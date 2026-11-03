import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../errors.js';
import { tasksChanged } from '../dispatch/tasks-changed.js';
import { appendEvent } from '../events/append.js';
import { findRoleOwner } from '../approval/repository.js';
import { findProjectById } from '../project/repository.js';
import type { TaskBlockedPayload } from '../events/types.js';
import { blockStoppedTask, findTaskById, listUnresponsiveClaims, resumeEscalatedTask, resumeStoppedTask, type Task } from './repository.js';

// 에이전트가 제출 없이 멈춘 태스크. CLAIMED로 남기면 아무도 다시 가져가지 못하고(운영 테스트의 영구 정체),
// READY로 되돌려 재시도를 깎으면 권한·환경 탓(쉘 거부·선행 코드 없음)을 에이전트 실패로 센다(대표 결정).
// 그래서 BLOCKED(AGENT_STOPPED)로 멈추고 사유를 남긴 뒤, 대표가 원인을 해결하고 재개하면 READY. retry_count는 검증 실패·반려만 쓴다.

export const WATCHDOG = 'system:watchdog';
// Executor의 실행 제한(30분) + 여유. 그동안 실행 보고·도구 사용이 하나도 없으면 에이전트가 사라진 것으로 본다.
export const UNRESPONSIVE_AFTER_MS = 45 * 60 * 1000;

type BlockInput = Omit<TaskBlockedPayload, 'taskId' | 'reason'>;

// 같은 트랜잭션에서 상태와 이벤트를 함께 바꾼다. 그사이 제출로 상태가 바뀌었으면 null(아무것도 하지 않음).
export async function blockStoppedTaskInTx(
  tx: PoolClient,
  ctx: { orgId: string; projectId: string; onBehalfOf: string; policyHash?: string },
  taskId: string,
  input: BlockInput,
): Promise<Task | null> {
  const blocked = await blockStoppedTask(tx, taskId, input.agentId);
  if (blocked === null) return null;
  await appendEvent(tx, {
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    type: 'TASK_BLOCKED',
    actorAgentId: input.agentId,
    onBehalfOf: ctx.onBehalfOf,
    ...(ctx.policyHash === undefined ? {} : { policyHash: ctx.policyHash }),
    payload: { taskId, reason: 'AGENT_STOPPED', ...input },
  });
  return blocked;
}

// 멈춘 태스크(BLOCKED·AGENT_STOPPED, ESCALATED)를 처리할 사람 — **그 역할의 담당**이다(대표 결정 2026-11-03).
// 대표는 직접 일을 끝낼 수 없고, 원인(쉘 거부·선행 코드·명세)을 아는 것도 그 역할 담당이다. 담당이 없거나(역할 제한 없는 태스크·빈 역할)
// 담당이 대표 본인이면 대표다. 재개 권한·받은 편지함(처리할 일)이 이 함수 한 벌을 쓴다 — 갈리면 보이는데 누르면 403이 된다.
// 대표는 담당이 있어도 대신 처리할 수 있다(1차 검토를 대신하는 것과 같다). 담당이 직접 완료하면 대표의 최종 승인을 거친다(human-control.ts).
export function stuckTaskHandler(owner: { userId: string; isRepresentative: boolean } | null): { userId: string } | 'representative' {
  return owner === null || owner.isRepresentative ? 'representative' : { userId: owner.userId };
}

// 재개. 원인(허용 명령·설치·명세)을 해결했다는 판단은 사람이 한다 — 그 역할 담당 또는 대표(stuckTaskHandler).
// 두 경우를 받는다: 멈춤(BLOCKED·AGENT_STOPPED — 재시도 횟수 그대로)과 재시도 소진(ESCALATED — 횟수를 0으로).
// ESCALATED는 "사람에게 넘긴다"인데 사람이 처리할 길이 없어 막다른 길이었다(통합 테스트: 검사기 결함으로 3번 실패한 태스크를 되살릴 수 없었다).
export async function resumeTask(
  actor: { userId: string; orgId: string; orgRole: string },
  taskId: string,
  note: string | null,
): Promise<Task> {
  const isRepresentative = actor.orgRole === 'REPRESENTATIVE';
  const resumed = await withTransaction(async (tx) => {
    const task = await findTaskById(tx, taskId);
    if (!task) throw new AppError('TASK_NOT_FOUND', `task ${taskId} not found`);
    const project = await findProjectById(tx, task.projectId);
    if (project?.orgId !== actor.orgId) throw new AppError('CROSS_ORG_ACCESS', 'cannot access another organization');
    if (!isRepresentative) {
      const handler = stuckTaskHandler(await findRoleOwner(tx, task.projectId, task.teamRole));
      if (handler === 'representative' || handler.userId !== actor.userId) {
        throw new AppError('NOT_TASK_OWNER', `only the ${task.teamRole ?? 'assigned'} member or the representative can resume this task`);
      }
    }
    const escalated = task.state === 'ESCALATED';
    const next = escalated ? await resumeEscalatedTask(tx, taskId) : await resumeStoppedTask(tx, taskId);
    if (next === null) {
      throw new AppError('TASK_NOT_STOPPED', `task ${taskId} is not stopped or escalated (state ${task.state}, reason ${task.blockedReason ?? '-'})`);
    }
    await appendEvent(tx, {
      orgId: actor.orgId,
      projectId: task.projectId,
      type: 'TASK_RESUMED',
      onBehalfOf: actor.userId,
      payload: {
        taskId,
        note,
        from: escalated ? 'ESCALATED' : 'AGENT_STOPPED',
        ...(escalated ? { previousRetryCount: task.retryCount } : {}),
        // 누가 재개했나 — "사람 개입" 지표를 담당·대표로 나눠 센다.
        resumedBy: isRepresentative ? 'representative' : 'role_owner',
      },
    });
    return next;
  });
  // 다시 가져갈 수 있게 됐다 — "다시 실행해 주세요"와 에이전트 푸시.
  tasksChanged(resumed.projectId);
  return resumed;
}

// 감시: 응답이 끊긴 수령을 멈춤으로 바꾼다(Executor가 꺼져 종료 보고조차 오지 않은 경우).
export async function sweepUnresponsiveClaims(thresholdMs: number = UNRESPONSIVE_AFTER_MS): Promise<number> {
  const stale = await listUnresponsiveClaims(pool, thresholdMs);
  let count = 0;
  for (const s of stale) {
    const blocked = await withTransaction((tx) =>
      blockStoppedTaskInTx(tx, { orgId: s.orgId, projectId: s.projectId, onBehalfOf: WATCHDOG }, s.taskId, {
        cause: 'unresponsive',
        agentId: s.agentId,
        lastMessage: null,
        deniedCommands: [],
      }),
    );
    if (blocked) {
      count += 1;
      tasksChanged(s.projectId);
    }
  }
  return count;
}

// startServer에서만 건다(테스트 앱·migrate에는 걸지 않는다).
export function startStallWatchdog(intervalMs = 5 * 60 * 1000): () => void {
  const timer = setInterval(() => {
    sweepUnresponsiveClaims().catch((err: unknown) => logger.warn('stall watchdog failed', { error: String(err) }));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
