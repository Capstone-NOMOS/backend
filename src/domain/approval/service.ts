import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../../config/db.js';
import { AppError } from '../../errors.js';
import { tasksChanged } from '../dispatch/tasks-changed.js';
import { appendEvent } from '../events/append.js';
import { findProjectById } from '../project/repository.js';
import { assertProjectVisibleToUser, type UserContext } from '../project/visibility.js';
import { failTaskForRetry, markTaskState, type Artifact, type Task } from '../task/repository.js';
import { MAX_RETRIES } from '../task/retry.js';
import type { StageOutcome } from '../verification/service.js';
import {
  decideApproval,
  findApprovalForUpdate,
  insertApproval,
  listApprovals,
  lockApprovalTask,
  type ApprovalDecision,
  type ApprovalStatusFilter,
  type ApprovalView,
} from './repository.js';

// 승인 대기열 — 지금 범위는 ACTION 게이트(검증은 통과했지만 정책 판정이 HUMAN·PM_REVIEW인 산출물)뿐이다.
//
// - 요청: 검증이 끝나 AWAITING_APPROVAL로 가는 **같은 트랜잭션**에서 카드를 만든다(verification/service.ts의 settle).
//   카드 내용은 그 순간의 스냅샷이다 — 나중에 무엇이 바뀌어도 "무엇을 승인했나"가 남는다.
// - 결정: **대표만** 한다. "해당 역할의 사람"은 곧 제출한 에이전트의 주인이라 자기 승인이 되기 때문이다.
//   대표가 자기 에이전트의 산출물을 승인하는 경우는 지금은 허용하되(다른 승인자가 없다) selfApproval: true로 남긴다 —
//   나중에 "다른 멤버 승인" 규칙을 만들 때의 근거다.
// - 승인 → DONE. 반려 → **READY**(담당 비움, retry_count +1, 3회째 ESCALATED) — 설계 문서의 IN_PROGRESS가 아니다:
//   제출 뒤 에이전트 실행은 끝나 있어 IN_PROGRESS를 이어받을 주체가 없다. 반려 사유는 다음 시도의 브리핑(lastRejection)으로 간다.
// - PM_REVIEW 카드도 대표가 처리한다(PM 리뷰 미구현). 그 결정은 reviewer: 'human_fallback'으로 구분해 남긴다 — PM 리뷰가 생기면 지표를 나눠 센다.

export type ActionApprovalInput = { task: Task; artifact: Artifact; stages: StageOutcome[] };

type EventContext = { orgId: string; projectId: string; onBehalfOf: string; policyHash: string; agentId?: string };

// settle 안에서 부른다 — 트랜잭션은 호출부 것이다.
export async function requestActionApproval(tx: PoolClient, ctx: EventContext, input: ActionApprovalInput): Promise<string> {
  const { task, artifact } = input;
  const approval = await insertApproval(tx, {
    projectId: task.projectId,
    gate: 'ACTION',
    subjectId: task.id,
    artifactId: artifact.id,
    gateMode: artifact.gateMode,
    payload: {
      taskTitle: task.title,
      artifactId: artifact.id,
      attempt: artifact.attempt,
      commitSha: artifact.commitSha,
      changedPaths: artifact.changedPaths,
      triggeredActions: artifact.triggeredActions,
      gateMode: artifact.gateMode,
      stages: input.stages,
      submittedByAgentId: task.assigneeAgentId,
    },
  });
  await appendEvent(tx, {
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    type: 'APPROVAL_REQUESTED',
    ...(ctx.agentId === undefined ? {} : { actorAgentId: ctx.agentId }),
    onBehalfOf: ctx.onBehalfOf,
    policyHash: ctx.policyHash,
    payload: {
      approvalId: approval.id,
      gate: 'ACTION',
      taskId: task.id,
      artifactId: artifact.id,
      gateMode: artifact.gateMode,
      triggeredActions: artifact.triggeredActions,
    },
  });
  return approval.id;
}

// 조직 전체의 대기열(대시보드 "승인 · 결정 대기", 받은 편지함) — 대표 전용(라우트가 막는다).
export async function listOrgApprovals(orgId: string, status: ApprovalStatusFilter, limit: number): Promise<ApprovalView[]> {
  return listApprovals(pool, { orgId, status, limit });
}

// 프로젝트의 승인 이력 — 볼 수 있는 범위는 태스크·노트와 같다.
export async function listProjectApprovals(
  actor: UserContext,
  projectId: string,
  status: ApprovalStatusFilter,
  limit: number,
): Promise<ApprovalView[]> {
  await withTransaction((tx) => assertProjectVisibleToUser(tx, actor, projectId));
  return listApprovals(pool, { projectId, status, limit });
}

export async function decide(
  actor: UserContext,
  approvalId: string,
  decision: ApprovalDecision,
  reason: string | null,
): Promise<ApprovalView> {
  if (actor.orgRole !== 'REPRESENTATIVE') {
    throw new AppError('NOT_REPRESENTATIVE', 'only the organization representative can decide approvals');
  }
  if (decision === 'REJECT' && !reason) throw new AppError('VALIDATION_ERROR', 'a rejection needs a reason');

  const projectId = await withTransaction(async (tx) => {
    const approval = await findApprovalForUpdate(tx, approvalId);
    if (!approval) throw new AppError('APPROVAL_NOT_FOUND', `approval ${approvalId} not found`);
    if (approval.orgId !== actor.orgId) throw new AppError('CROSS_ORG_ACCESS', 'cannot access another organization');
    if (approval.decision !== null) {
      throw new AppError('APPROVAL_ALREADY_DECIDED', `approval was already decided (${approval.decision})`);
    }
    if (approval.gate !== 'ACTION') {
      throw new AppError('APPROVAL_NOT_FOUND', `approval ${approvalId} is not an action approval`);
    }

    // 결정 순간에도 태스크가 승인 대기여야 한다(정지·수동 변경 등으로 바뀌었으면 결정을 받지 않는다).
    const task = await lockApprovalTask(tx, approval.subjectId);
    if (!task || task.state !== 'AWAITING_APPROVAL') {
      throw new AppError('APPROVAL_STALE', `the task is no longer awaiting approval (${task?.state ?? 'gone'})`);
    }

    if (!(await decideApproval(tx, approval.id, decision, actor.userId, reason))) {
      throw new AppError('APPROVAL_ALREADY_DECIDED', 'approval was decided concurrently');
    }

    let taskState: string;
    let retryCount: number | null = null;
    if (decision === 'APPROVE') {
      await markTaskState(tx, approval.subjectId, 'DONE');
      taskState = 'DONE';
    } else {
      const next = await failTaskForRetry(tx, approval.subjectId, MAX_RETRIES);
      taskState = next.state;
      retryCount = next.retryCount;
    }

    const project = (await findProjectById(tx, approval.projectId))!;
    await appendEvent(tx, {
      orgId: actor.orgId,
      projectId: approval.projectId,
      type: 'APPROVAL_RESULT',
      onBehalfOf: actor.userId,
      policyHash: project.policyHash,
      payload: {
        approvalId: approval.id,
        gate: approval.gate,
        taskId: approval.subjectId,
        artifactId: approval.artifactId,
        decision,
        reason,
        gateMode: approval.gateMode,
        // PM 리뷰가 생길 때까지 PM_REVIEW 카드도 대표가 대신 본다 — 지표를 나눠 셀 수 있게 표시한다.
        reviewer: approval.gateMode === 'PM_REVIEW' ? 'human_fallback' : 'human',
        // 승인자가 제출한 에이전트의 주인이다(대표가 자기 에이전트를 돌린 경우).
        selfApproval: task.assigneeOwnerId !== null && task.assigneeOwnerId === actor.userId,
        taskState,
        ...(retryCount === null ? {} : { retryCount, retryCause: 'REJECTED' as const }),
      },
    });
    return approval.projectId;
  });

  // 커밋 뒤 — 승인이면 뒤 태스크가 풀리고, 반려면 이 태스크가 다시 READY다.
  tasksChanged(projectId);
  const [view] = (await listApprovals(pool, { projectId, status: 'all', limit: 200 })).filter((a) => a.id === approvalId);
  return view!;
}
