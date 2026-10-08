import { pool, withTransaction, type Queryable } from '../../config/db.js';
import { AppError } from '../../errors.js';
import { presenceOf } from '../agent/presence.js';
import { findAgentMembership } from '../policy/repository.js';
import { appendEvent } from '../events/append.js';
import { listProjectMembers } from '../project/repository.js';
import { assertProjectVisibleToUser, type UserContext } from '../project/visibility.js';
import { TEAM_ROLES, type TeamRole } from '../roles.js';
import { findTaskById, type Task } from '../task/repository.js';
import type { AgentContext } from '../task/service.js';
import { tasksChanged } from '../dispatch/tasks-changed.js';
import { blockStoppedTaskInTx } from '../task/stall.js';
import { activityRecorded } from './activity-hub.js';
import { parseCursor, renderFeedRow, type RoomMessage } from './render.js';
import { findOpenRun, insertActivity, listActiveRoleTasks, listRoomFeed, type ActivityKind, type RoomTask } from './repository.js';

// 룸 = 프로젝트 × 역할. 그 역할의 에이전트가 무엇을 하는지(활동), 서버(PM)가 무엇을 지시·판정했는지를 한 줄씩 보여 준다.
// 팀원은 자기 역할 룸만, 대표는 전부 본다. PM(서버)의 프로젝트 단위 알림은 모든 룸에 나온다.

const RUNNING_STATES = ['CLAIMED', 'IN_PROGRESS'];

async function taskInProject(ctx: AgentContext, taskId: string, db: Queryable = pool): Promise<Task> {
  const task = await findTaskById(db, taskId);
  if (!task || task.projectId !== ctx.projectId) throw new AppError('TASK_NOT_FOUND', `task ${taskId} not found`);
  return task;
}

// ── Executor → 서버 ──────────────────────────────────────────────────────

// Claude 실행을 시작했다. 태스크를 잡는 것(claim_task)은 실행 **안에서** 모델이 하므로, 시작 시점의 태스크는 보통 아직 READY다.
// 그래서 "이 에이전트가 잡고 있다" 또는 "이 에이전트가 지금 잡을 수 있다(READY·담당 없음·내 역할 또는 역할 제한 없음)"면 받는다.
// 선행 조건·정책은 여기서 다시 보지 않는다 — 실제로 잡을 수 있는지는 claim이 판정하고, 이건 기록일 뿐이다.
export async function startRun(ctx: AgentContext, taskId: string): Promise<{ taskId: string; attempt: number }> {
  return withTransaction(async (tx) => {
    const task = await taskInProject(ctx, taskId, tx);
    const held = task.assigneeAgentId === ctx.agentId && RUNNING_STATES.includes(task.state);
    const membership = await findAgentMembership(tx, ctx.agentId);
    const claimable =
      task.state === 'READY' &&
      task.assigneeAgentId === null &&
      membership?.projectId === ctx.projectId &&
      (task.teamRole === null || task.teamRole === membership.teamRole);
    if (!held && !claimable) {
      throw new AppError('RUN_NOT_ALLOWED', `task ${taskId} is neither held nor claimable by this agent (state ${task.state})`);
    }
    await appendEvent(tx, {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      type: 'AGENT_RUN_STARTED',
      actorAgentId: ctx.agentId,
      onBehalfOf: ctx.onBehalfOf,
      policyHash: ctx.policyHash,
      payload: { taskId, attempt: task.retryCount },
    });
    return { taskId, attempt: task.retryCount };
  });
}

export type EndRunInput = {
  outcome: 'completed' | 'timeout' | 'failed';
  committed: boolean;
  durationMs: number;
  exitCode: number | null;
  // 제출하지 않고 끝났을 때 대표에게 보일 사유 — 모델의 마지막 말, 거부된 쉘 명령(Executor가 실행 기록에서 뽑는다).
  lastMessage?: string | null;
  deniedCommands?: string[];
};

// Claude 실행이 끝났다. 제출 여부는 Executor가 아니라 서버가 정한다 — 이 에이전트가 아직 그 태스크를 잡고 있으면(CLAIMED·IN_PROGRESS)
// 제출하지 않은 것이다. 제출 뒤에는 검증이 상태를 이미 옮겨 두었다(VERIFYING·DONE·READY…).
// 제출하지 않았으면 같은 트랜잭션에서 BLOCKED(AGENT_STOPPED)로 멈추고 사유를 남긴다(task/stall.ts) — 재시도 횟수는 그대로.
export async function endRun(
  ctx: AgentContext,
  taskId: string,
  input: EndRunInput,
): Promise<{ submitted: boolean; taskState: string; blocked: boolean }> {
  const result = await withTransaction(async (tx) => {
    const task = await taskInProject(ctx, taskId, tx);
    const open = await findOpenRun(tx, taskId, ctx.agentId);
    if (open === null) throw new AppError('RUN_NOT_OPEN', `no open run for task ${taskId}`);
    const submitted = !(task.assigneeAgentId === ctx.agentId && RUNNING_STATES.includes(task.state));
    await appendEvent(tx, {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      type: 'AGENT_RUN_ENDED',
      actorAgentId: ctx.agentId,
      onBehalfOf: ctx.onBehalfOf,
      policyHash: ctx.policyHash,
      payload: {
        taskId,
        attempt: open.attempt,
        outcome: input.outcome,
        committed: input.committed,
        durationMs: input.durationMs,
        exitCode: input.exitCode,
        submitted,
        taskState: task.state,
      },
    });
    if (submitted) return { submitted, taskState: task.state, blocked: false };
    const blocked = await blockStoppedTaskInTx(tx, { orgId: ctx.orgId, projectId: ctx.projectId, onBehalfOf: ctx.onBehalfOf, policyHash: ctx.policyHash }, taskId, {
      cause: input.outcome === 'completed' ? 'not_submitted' : input.outcome,
      agentId: ctx.agentId,
      lastMessage: input.lastMessage ?? null,
      deniedCommands: input.deniedCommands ?? [],
    });
    return { submitted, taskState: blocked ? blocked.state : task.state, blocked: blocked !== null };
  });
  if (result.blocked) tasksChanged(ctx.projectId);
  return result;
}

// 실행 중 도구 사용 묶음. 열린 실행에만 붙는다 — 끝난 뒤 늦게 온 묶음은 받지 않는다.
export async function recordActivity(
  ctx: AgentContext,
  taskId: string,
  items: { kind: ActivityKind; target: string }[],
): Promise<{ recorded: number }> {
  await taskInProject(ctx, taskId);
  if ((await findOpenRun(pool, taskId, ctx.agentId)) === null) {
    throw new AppError('RUN_NOT_OPEN', `no open run for task ${taskId}`);
  }
  await insertActivity(pool, { projectId: ctx.projectId, taskId, agentId: ctx.agentId, items });
  activityRecorded(ctx.orgId, ctx.projectId);
  return { recorded: items.length };
}

// ── 사람 → 룸 ────────────────────────────────────────────────────────────

// 이 사람이 볼 수 있는 룸의 역할. 대표는 전부, 팀원은 자기 에이전트가 배정된 역할만.
async function visibleRoles(actor: UserContext, projectId: string): Promise<TeamRole[]> {
  await assertProjectVisibleToUser(pool, actor, projectId);
  if (actor.orgRole === 'REPRESENTATIVE') return [...TEAM_ROLES];
  const members = await listProjectMembers(pool, projectId);
  return TEAM_ROLES.filter((role) => members.some((m) => m.userId === actor.userId && m.teamRole === role));
}

export type RoomSummary = {
  role: TeamRole;
  agent: { agentId: string; agentName: string; online: boolean; lastSeenAt: string | null } | null;
  activeTasks: RoomTask[];
};

export async function listRooms(actor: UserContext, projectId: string): Promise<RoomSummary[]> {
  const roles = await visibleRoles(actor, projectId);
  const members = await listProjectMembers(pool, projectId);
  const rooms: RoomSummary[] = [];
  for (const role of roles) {
    const member = members.find((m) => m.teamRole === role);
    rooms.push({
      role,
      agent: member ? { agentId: member.agentId, agentName: member.agentName, ...presenceOf(member.agentId) } : null,
      activeTasks: await listActiveRoleTasks(pool, projectId, role),
    });
  }
  return rooms;
}

// 최신부터. nextBefore를 다음 요청의 before로 넘기면 더 오래된 것을 읽는다.
export async function getRoomFeed(
  actor: UserContext,
  projectId: string,
  role: TeamRole,
  query: { before?: string; limit: number },
): Promise<{ messages: RoomMessage[]; nextBefore: string | null }> {
  const roles = await visibleRoles(actor, projectId);
  if (!roles.includes(role)) throw new AppError('ROOM_NOT_VISIBLE', `you cannot see the ${role} room of this project`);
  let before: ReturnType<typeof parseCursor> | undefined;
  if (query.before !== undefined) {
    before = parseCursor(query.before);
    if (before === null) throw new AppError('VALIDATION_ERROR', 'before is not a feed cursor');
  }
  const rows = await listRoomFeed(pool, projectId, role, { ...(before ? { before } : {}), limit: query.limit });
  const messages = rows.map(renderFeedRow).filter((m): m is RoomMessage => m !== null);
  const last = rows[rows.length - 1];
  return { messages, nextBefore: rows.length === query.limit && last ? `${last.tsMicros}.${last.source}.${last.id}` : null };
}
