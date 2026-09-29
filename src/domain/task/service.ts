import { withTransaction } from '../../config/db.js';
import { AppError, type ErrorCode } from '../../errors.js';
import { appendEvent } from '../events/append.js';
import type { DenialStage, PathDenialReason } from '../events/types.js';
import { settle, type Outcome } from '../outcome.js';
import { getPolicySnapshot } from '../policy/policy-cache.js';
import type { PolicyMode } from '../policy/pm-review-fallback.js';
import { findAgentMembership } from '../policy/repository.js';
import { buildNotesPromptBlock, selectNotesForTask } from '../note/injection.js';
import type { Note } from '../note/repository.js';
import { assertProjectVisibleToUser, type UserContext } from '../project/visibility.js';
import { buildClaudePermissions, type ClaudePermissions } from '../repo/claude-settings.js';
import { findRepoById, listRepoPaths } from '../repo/repository.js';
import { inspectPaths, recordToolDenied, strictestMode } from '../policy/scope-check.js';
import { resolveRule, samplePath } from '../repo/glob.js';
import type { TeamRole } from '../roles.js';
import { runServerVerifications, type VerificationSummary } from '../verification/service.js';
import {
  claimTaskRow,
  countUnfinishedDeps,
  findTaskById,
  insertArtifact,
  findSpecForTask,
  listArtifactsForTask,
  listLockedSpecTests,
  listTasks,
  markTaskVerifying,
  setTaskBranch,
  type Artifact,
  type SpecTest,
  type Task,
  type TaskSpec,
} from './repository.js';

// 에이전트 토큰에서 온 요청 맥락. project_id·policy_hash는 미들웨어가 이미 확인했다.
export type AgentContext = {
  agentId: string;
  onBehalfOf: string;
  orgId: string;
  projectId: string;
  policyHash: string;
};

// 제출은 정책표의 artifact:submit에 걸린다. 경로에서 나온 행동 키들과 함께 판정한다.
const SUBMIT_ACTION_KEY = 'artifact:submit';
// claim은 정책 게이트가 없는 도구다. 이벤트 payload의 라벨로만 쓰인다 (action_catalog의 키가 아니다).
const CLAIM_LABEL = 'task:claim';

export async function claimTask(ctx: AgentContext, taskId: string): Promise<Task> {
  return settle(
    await withTransaction<Outcome<Task>>(async (tx) => {
      const deny = async (
        stage: DenialStage,
        detail: string,
        code: ErrorCode,
        extra: { memberRole?: TeamRole | null; ownerRole?: string | null; repoId?: string | null } = {},
      ): Promise<Outcome<Task>> => {
        await recordToolDenied(tx, {
          ...ctx,
          actionKey: CLAIM_LABEL,
          repoId: extra.repoId ?? null,
          stage,
          detail,
          memberRole: extra.memberRole ?? null,
          ownerRole: extra.ownerRole ?? null,
        });
        return { denied: { code, message: detail } };
      };

      const membership = await findAgentMembership(tx, ctx.agentId);
      if (!membership || membership.projectId !== ctx.projectId) {
        return deny('membership', 'agent is not a member of this project', 'NOT_PROJECT_MEMBER');
      }

      const task = await findTaskById(tx, taskId);
      // 다른 프로젝트의 태스크는 "없음"으로 답한다 — 존재 여부를 알려주지 않는다.
      if (!task || task.projectId !== ctx.projectId) {
        return { denied: { code: 'TASK_NOT_FOUND', message: `task ${taskId} not found` } };
      }

      // team_role이 NULL이면 역할 제한이 없는 태스크다 (통합 태스크).
      if (task.teamRole !== null && task.teamRole !== membership.teamRole) {
        return deny('membership', `task belongs to ${task.teamRole}`, 'TASK_ROLE_MISMATCH', {
          memberRole: membership.teamRole,
          ownerRole: task.teamRole,
          repoId: task.repoId,
        });
      }

      const pending = await countUnfinishedDeps(tx, taskId);
      if (pending > 0) {
        return { denied: { code: 'TASK_DEPS_NOT_DONE', message: `${pending} dependencies are not DONE` } };
      }

      // 경합은 여기서 갈린다. 진 쪽은 0행을 받는다.
      const claimed = await claimTaskRow(tx, taskId, ctx.agentId);
      if (!claimed) {
        return { denied: { code: 'TASK_ALREADY_CLAIMED', message: 'task is no longer READY' } };
      }

      await appendEvent(tx, {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        type: 'TASK_CLAIMED',
        actorAgentId: ctx.agentId,
        onBehalfOf: ctx.onBehalfOf,
        policyHash: ctx.policyHash,
        // 역할 제한이 없는 태스크를 잡은 경우를 표시해 둔다.
        payload: { taskId, teamRole: membership.teamRole, unrestricted: task.teamRole === null },
      });

      return { value: claimed };
    }),
  );
}

export type SubmitArtifactInput = {
  taskId: string;
  commitSha: string;
  changedPaths: string[];
};

// 제출 결과에는 서버가 즉시 판정한 단계(V1A·V1B·V3)의 결론이 함께 온다.
// 비동기로 돌리면 "제출은 됐는데 결과는 언제 오는가"를 관리하는 상태가 하나 더 늘고,
// 모델은 그 사이에 다음 태스크로 넘어가 버린다.
export type SubmitArtifactResult = { artifact: Artifact; verification: VerificationSummary };

export async function submitArtifact(
  ctx: AgentContext,
  input: SubmitArtifactInput,
): Promise<SubmitArtifactResult> {
  const artifact = settle(
    await withTransaction<Outcome<Artifact>>(async (tx) => {
      const deny = async (
        stage: DenialStage,
        detail: string,
        code: ErrorCode,
        extra: {
          repoId?: string | null;
          path?: string | null;
          ownerRole?: string | null;
          memberRole?: TeamRole | null;
          pathViolation?: boolean;
          reason?: PathDenialReason;
        } = {},
      ): Promise<Outcome<Artifact>> => {
        await recordToolDenied(tx, {
          ...ctx,
          actionKey: SUBMIT_ACTION_KEY,
          repoId: extra.repoId ?? null,
          stage,
          detail,
          path: extra.path ?? null,
          ownerRole: extra.ownerRole ?? null,
          memberRole: extra.memberRole ?? null,
          pathViolation: extra.pathViolation ?? false,
          ...(extra.reason === undefined ? {} : { reason: extra.reason }),
        });
        return { denied: { code, message: detail } };
      };

      const membership = await findAgentMembership(tx, ctx.agentId);
      if (!membership || membership.projectId !== ctx.projectId) {
        return deny('membership', 'agent is not a member of this project', 'NOT_PROJECT_MEMBER');
      }

      const task = await findTaskById(tx, input.taskId);
      if (!task || task.projectId !== ctx.projectId) {
        return { denied: { code: 'TASK_NOT_FOUND', message: `task ${input.taskId} not found` } };
      }
      if (task.assigneeAgentId !== ctx.agentId) {
        return deny('membership', 'task is assigned to another agent', 'NOT_TASK_ASSIGNEE', {
          repoId: task.repoId,
          memberRole: membership.teamRole,
        });
      }
      if (task.state !== 'CLAIMED' && task.state !== 'IN_PROGRESS') {
        return { denied: { code: 'TASK_STATE_INVALID', message: `cannot submit while task is ${task.state}` } };
      }

      const snapshot = await getPolicySnapshot(tx, ctx.projectId, ctx.policyHash);
      const rules = snapshot.repoPaths.filter((p) => p.repoId === task.repoId);

      // 3·4단계 — 도구 호출 때와 같은 판정을 제출 시점에 한 번 더 한다 (V3의 전신).
      // 로컬 편집기로 직접 고친 파일은 도구 호출을 거치지 않으므로 여기서만 걸린다.
      const verdict = inspectPaths(rules, input.changedPaths, membership.teamRole, true);
      if (!verdict.ok) {
        const code: ErrorCode = verdict.stage === 'forbidden_path' ? 'FORBIDDEN_PATH' : 'SCOPE_DENIED';
        return deny(verdict.stage, verdict.detail, code, {
          repoId: task.repoId,
          path: verdict.path,
          ownerRole: verdict.ownerRole,
          memberRole: membership.teamRole,
          pathViolation: verdict.pathViolation,
          reason: verdict.reason,
        });
      }

      const triggeredActions = [...new Set([...verdict.actionKeys, SUBMIT_ACTION_KEY])].sort();
      const modes: PolicyMode[] = [];
      for (const key of triggeredActions) {
        const policy = snapshot.policies.find((p) => p.actionKey === key);
        if (!policy) {
          return deny('unknown_action', `no policy row for ${key}`, 'SCOPE_DENIED', {
            repoId: task.repoId,
            memberRole: membership.teamRole,
          });
        }
        modes.push(policy.mode);
      }

      // 여러 칸에 걸리면 가장 엄격한 판정이 이긴다.
      const gateMode = strictestMode(modes);
      if (gateMode === 'FORBIDDEN') {
        return deny('forbidden_action', 'submission triggers a FORBIDDEN action', 'SCOPE_DENIED', {
          repoId: task.repoId,
          memberRole: membership.teamRole,
        });
      }

      // 판정을 사실로 고정한다. 나중에 정책표나 경로 규칙이 바뀌어도 이 행은 그대로 남는다.
      const artifact = await insertArtifact(tx, {
        taskId: task.id,
        commitSha: input.commitSha,
        changedPaths: input.changedPaths,
        triggeredActions,
        gateMode,
      });

      // 제출했으므로 검증 대기로 넘어간다. V1~V4는 ⑤에서 붙는다.
      await markTaskVerifying(tx, task.id);

      await appendEvent(tx, {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        type: 'ARTIFACT_SUBMITTED',
        actorAgentId: ctx.agentId,
        onBehalfOf: ctx.onBehalfOf,
        policyHash: ctx.policyHash,
        payload: {
          taskId: task.id,
          artifactId: artifact.id,
          commitSha: artifact.commitSha,
          attempt: artifact.attempt,
          triggeredActions,
          gateMode,
        },
      });

      return { value: artifact };
    }),
  );

  // 검증은 **트랜잭션 밖**에서 돈다. V3는 git fetch를, V1B는 HTTP 호출을 하므로
  // 안에서 돌리면 네트워크가 느린 동안 커넥션과 행 잠금을 붙들고 있게 된다.
  // 제출 자체는 이미 커밋됐으므로 검증이 실패해도 산출물 기록은 남는다.
  const verification = await runServerVerifications(ctx, artifact.id);
  return { artifact, verification };
}

// ── 조회 ──────────────────────────────────────────────────────────────────
// 웹 UI(사람 토큰)와 Executor 폴링(에이전트 토큰)이 같은 엔드포인트를 쓴다.
// 에이전트는 자기 역할로 강제 필터된다 — 남의 역할 태스크는 목록에 아예 없어야
// "잡아보고 403"을 반복하지 않는다.

export type TaskQuery = { state?: string; teamRole?: TeamRole; limit?: number };

const TASK_PAGE = { default: 50, max: 200 } as const;

function pageSize(limit: number | undefined): number {
  return Math.min(limit ?? TASK_PAGE.default, TASK_PAGE.max);
}

export async function listTasksForAgent(
  ctx: AgentContext,
  projectId: string,
  query: TaskQuery,
): Promise<Task[]> {
  return withTransaction(async (tx) => {
    const membership = await findAgentMembership(tx, ctx.agentId);
    if (!membership || membership.projectId !== ctx.projectId || projectId !== ctx.projectId) {
      throw new AppError('NOT_PROJECT_MEMBER', 'agent is not a member of this project');
    }
    // 요청에 teamRole이 있어도 무시한다. 자기 역할이 정본이다.
    return listTasks(tx, projectId, {
      ...(query.state === undefined ? {} : { state: query.state }),
      teamRole: membership.teamRole,
      limit: pageSize(query.limit),
    });
  });
}

export async function listTasksForUser(
  actor: UserContext,
  projectId: string,
  query: TaskQuery,
): Promise<Task[]> {
  return withTransaction(async (tx) => {
    await assertProjectVisibleToUser(tx, actor, projectId);
    return listTasks(tx, projectId, {
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.teamRole === undefined ? {} : { teamRole: query.teamRole }),
      limit: pageSize(query.limit),
    });
  });
}

// ── 브리핑 ────────────────────────────────────────────────────────────────
// Executor는 팀원 노트북에서 돌아 DB를 직접 못 본다. 프롬프트와 settings.json을 만드는 데
// 필요한 것을 한 번에 준다 — 여러 엔드포인트를 조합하게 하면 조합 방식이 Executor마다 갈린다.
//
// CLAIM 전에도 받을 수 있다. Executor가 작업공간을 먼저 만들고, claim은 모델이 도구로 하기 때문이다.

export type BriefingPath = { pathPattern: string; access: string; ownerRole: string | null };

export type TaskBriefing = {
  task: Task;
  repo: { id: string; fullName: string; defaultBranch: string; devBranch: string };
  spec: TaskSpec | null;
  notes: Note[];
  // 서버가 렌더한 인계 노트 블록. Executor가 같은 형식을 다시 만들면 둘이 갈라진다.
  notesBlock: string;
  writablePaths: BriefingPath[];
  claudeSettings: ClaudePermissions;
  // V2(PM 시험지)가 돌릴 코드. 잠긴 것만 내려간다.
  specTests: SpecTest[];
  policyHash: string;
};

export async function getTaskBriefing(ctx: AgentContext, taskId: string): Promise<TaskBriefing> {
  return withTransaction(async (tx) => {
    const membership = await findAgentMembership(tx, ctx.agentId);
    if (!membership || membership.projectId !== ctx.projectId) {
      throw new AppError('NOT_PROJECT_MEMBER', 'agent is not a member of this project');
    }

    const task = await findTaskById(tx, taskId);
    if (!task || task.projectId !== ctx.projectId) {
      throw new AppError('TASK_NOT_FOUND', `task ${taskId} not found`);
    }
    // 남의 역할 태스크의 명세·노트를 미리 보지 못하게 한다. 목록 필터와 같은 기준이다.
    if (task.teamRole !== null && task.teamRole !== membership.teamRole) {
      throw new AppError('TASK_ROLE_MISMATCH', `task belongs to ${task.teamRole}`);
    }

    const notes = await selectNotesForTask(tx, taskId);
    const repo = await findRepoById(tx, task.repoId);
    if (!repo) throw new AppError('REPO_NOT_FOUND', `repository ${task.repoId} not found`);

    const rules = await listRepoPaths(tx, task.repoId);
    // 프롬프트에 넣을 "수정 가능 경로". 소유 역할은 상속되므로(owner가 NULL인 tests/**는 `**`의 소유자를 따른다)
    // 규칙의 owner_role만 보고 거르면 판정과 어긋난다. 그래서 규칙마다 대표 경로를 만들어 **제출 때와 같은 판정기**를
    // 돌려 보고, 그 경로에서 실제로 이 규칙이 이기면서 쓰기가 허용될 때만 싣는다 — 판정 로직을 두 벌 두지 않는다.
    const writablePaths = rules
      .filter((r) => r.access === 'write')
      .filter((r) => {
        const probe = samplePath(r.pathPattern);
        return resolveRule(rules, probe)?.id === r.id && inspectPaths(rules, [probe], membership.teamRole, true).ok;
      })
      // 실린 경로의 실효 소유 역할은 전부 이 에이전트의 역할이다(상속된 것 포함).
      .map((r) => ({ pathPattern: r.pathPattern, access: r.access, ownerRole: membership.teamRole }));

    return {
      task,
      // 브릿지가 push를 거부할 브랜치를 알아야 한다(default_branch·dev_branch에는 push하지 않는다).
      repo: { id: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch, devBranch: repo.devBranch },
      spec: task.specId === null ? null : await findSpecForTask(tx, task.specId),
      // read_notes 호출에 의존하지 않는다 — 서버가 골라서 넣는다.
      notes,
      notesBlock: buildNotesPromptBlock(notes),
      writablePaths,
      // 로컬 방어선. 이 결과를 Executor가 worktree의 .claude/settings.json으로 깐다.
      claudeSettings: buildClaudePermissions(rules),
      specTests: task.specId === null ? [] : await listLockedSpecTests(tx, task.specId),
      policyHash: ctx.policyHash,
    };
  });
}

// Executor는 모델이 MCP 도구로 제출한 산출물의 id를 모른다. V2·V4 결과를 어디에 붙일지
// 알아야 하므로 목록을 준다 — 담당자만 볼 수 있다.
export async function listTaskArtifacts(ctx: AgentContext, taskId: string): Promise<Artifact[]> {
  return withTransaction(async (tx) => {
    const task = await findTaskById(tx, taskId);
    if (!task || task.projectId !== ctx.projectId) {
      throw new AppError('TASK_NOT_FOUND', `task ${taskId} not found`);
    }
    if (task.assigneeAgentId !== ctx.agentId) {
      throw new AppError('NOT_TASK_ASSIGNEE', 'task is assigned to another agent');
    }
    return listArtifactsForTask(tx, taskId);
  });
}

// 사람이 태스크 상세 화면에서 산출물을 본다. 에이전트 경로와 달리 담당자 제약이 없다 —
// 조회뿐이고, 대표가 자기 조직의 작업을 보는 것이 이 화면의 목적이다.
// 이게 없으면 프론트가 artifact_id를 얻을 방법이 없어 검증 결과 API에 닿지 못한다.
export async function listTaskArtifactsForUser(actor: UserContext, taskId: string): Promise<Artifact[]> {
  return withTransaction(async (tx) => {
    const task = await findTaskById(tx, taskId);
    if (!task) throw new AppError('TASK_NOT_FOUND', `task ${taskId} not found`);
    await assertProjectVisibleToUser(tx, actor, task.projectId);
    return listArtifactsForTask(tx, taskId);
  });
}

// Executor가 브랜치를 만들면 서버에 알린다. 서버가 정본을 들고 있어야
// 재실행·이어받기에서 같은 브랜치를 쓰고, 나중에 PR을 열 때도 이 값을 본다.
export async function reportTaskBranch(
  ctx: AgentContext,
  taskId: string,
  branchName: string,
): Promise<Task> {
  return withTransaction(async (tx) => {
    const task = await findTaskById(tx, taskId);
    if (!task || task.projectId !== ctx.projectId) {
      throw new AppError('TASK_NOT_FOUND', `task ${taskId} not found`);
    }
    // 이미 있으면 덮어쓰지 않는다 — 브랜치가 바뀌면 이전 작업물을 찾을 수 없게 된다.
    await setTaskBranch(tx, taskId, branchName);
    return (await findTaskById(tx, taskId))!;
  });
}
