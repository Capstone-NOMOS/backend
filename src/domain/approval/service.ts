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
  findRoleOwner,
  findUserNickname,
  insertApproval,
  insertReleaseApproval,
  isProjectReadyForRelease,
  listApprovals,
  listIntegrationChecks,
  listReleaseTasks,
  lockApprovalTask,
  markProjectCompleted,
  type ApprovalDecision,
  type ApprovalRow,
  type ApprovalStage,
  type ApprovalStageFilter,
  type ApprovalStatusFilter,
  type ApprovalView,
  type RoleReviewRecord,
} from './repository.js';

// 승인 대기열 — 지금 범위는 ACTION 게이트(검증은 통과했지만 정책 판정이 HUMAN·PM_REVIEW인 산출물)뿐이다.
//
// - 요청: 검증이 끝나 AWAITING_APPROVAL로 가는 **같은 트랜잭션**에서 카드를 만든다(verification/service.ts의 settle).
//   카드 내용은 그 순간의 스냅샷이다 — 나중에 무엇이 바뀌어도 "무엇을 승인했나"가 남는다.
// - 결정은 두 단계다(030, 대표 결정 2026-10-28). 먼저 **역할 담당**(project_members.user_id)이 1차 검토(role_review)하고,
//   통과하면 **대표**가 최종 승인(final)한다. 역할 담당은 자기 에이전트의 결과를 가장 잘 알지만 자기 승인이라 그것만으로 DONE이 되지 않는다.
//   역할 담당이 없거나(역할 제한 없는 태스크·빈 역할) 대표 본인이면 처음부터 final이다(payload.roleReviewSkipped).
//   1차 검토는 검토자 또는 대표가(대신 처리 — decidedByRepresentative), final·G3는 대표만 결정한다. 반려는 어느 단계든 같은 재시도 경로다.
//   대표가 자기 에이전트의 산출물을 최종 승인하는 경우는 허용하되 selfApproval: true로 남긴다.
// - 승인 → DONE. 반려 → **READY**(담당 비움, retry_count +1, 3회째 ESCALATED) — 설계 문서의 IN_PROGRESS가 아니다:
//   제출 뒤 에이전트 실행은 끝나 있어 IN_PROGRESS를 이어받을 주체가 없다. 반려 사유는 다음 시도의 브리핑(lastRejection)으로 간다.
// - PM_REVIEW 카드도 대표가 처리한다(PM 리뷰 미구현). 그 결정은 reviewer: 'human_fallback'으로 구분해 남긴다 — PM 리뷰가 생기면 지표를 나눠 센다.

export type ActionApprovalInput = { task: Task; artifact: Artifact; stages: StageOutcome[] };

type EventContext = { orgId: string; projectId: string; onBehalfOf: string; policyHash: string; agentId?: string };

export type RoleReviewSkipped = 'no_owner' | 'owner_is_representative';

// settle 안에서 부른다 — 트랜잭션은 호출부 것이다. 카드를 만드는 곳은 여기 한 곳이다(1차 검토 뒤 final 카드도 같은 스냅샷을 옮긴다).
export async function requestActionApproval(
  tx: PoolClient,
  ctx: EventContext,
  input: ActionApprovalInput,
): Promise<{ id: string; stage: ApprovalStage }> {
  const { task, artifact } = input;
  // 역할 담당(사람)이 있고 대표가 아니면 그 사람이 먼저 본다 — 에이전트 연결이 끊겨 있어도(agent_id NULL) 담당은 사람이라 그대로 간다.
  const owner = await findRoleOwner(tx, task.projectId, task.teamRole);
  const skipped: RoleReviewSkipped | null = owner === null ? 'no_owner' : owner.isRepresentative ? 'owner_is_representative' : null;
  const stage: ApprovalStage = skipped === null ? 'role_review' : 'final';
  const reviewerUserId = skipped === null ? owner!.userId : null;
  const approval = await insertApproval(tx, {
    projectId: task.projectId,
    gate: 'ACTION',
    subjectId: task.id,
    artifactId: artifact.id,
    gateMode: artifact.gateMode,
    stage,
    reviewerUserId,
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
      teamRole: task.teamRole,
      ...(skipped === null ? {} : { roleReviewSkipped: skipped }),
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
      stage,
      reviewerUserId,
      ...(skipped === null ? {} : { roleReviewSkipped: skipped }),
    },
  });
  return { id: approval.id, stage };
}

// ── G3: 통합 확인·완료 승인 ───────────────────────────────────────────────
// 통합 확인은 에이전트가 아니라 대표가 한다(운영 테스트 4-3 — 에이전트에게는 선행 코드·상대 레포·실행 수단이 없다).
// 태스크가 DONE이 되는 **같은 트랜잭션에서** 부른다(검증 결론·ACTION 승인). 모든 태스크가 DONE이면 카드를 하나 만든다 —
// 확인 항목(PM의 integrationChecks)과 태스크별 레포·브랜치·마지막 커밋(사람이 머지·실행해 볼 것)을 스냅샷으로 담는다.
export const RELEASE_REQUESTER = 'system:pm';

export async function requestReleaseIfComplete(tx: PoolClient, ctx: { orgId: string; projectId: string }): Promise<string | null> {
  if (!(await isProjectReadyForRelease(tx, ctx.projectId))) return null;
  const checks = await listIntegrationChecks(tx, ctx.projectId);
  const tasks = await listReleaseTasks(tx, ctx.projectId);
  const approvalId = await insertReleaseApproval(tx, ctx.projectId, { integrationChecks: checks, tasks });
  if (approvalId === null) return null;
  await appendEvent(tx, {
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    type: 'RELEASE_REQUESTED',
    onBehalfOf: RELEASE_REQUESTER,
    payload: { approvalId, checkCount: checks.length, taskCount: tasks.length },
  });
  return approvalId;
}

// 조직 전체의 대기열(대시보드 "승인 · 결정 대기", 받은 편지함) — 대표 전용(라우트가 막는다).
// 대표는 1차 검토 대기(role_review)도 본다 — 역할 담당이 응답하지 않으면 대신 처리한다. stage로 단계를 거른다.
export async function listOrgApprovals(
  orgId: string,
  status: ApprovalStatusFilter,
  stage: ApprovalStageFilter,
  limit: number,
): Promise<ApprovalView[]> {
  return listApprovals(pool, { orgId, status, stage, limit });
}

// 팀원의 "검토 요청" — 내가 그 역할 담당인 1차 검토 대기 카드(조직 전체). 결정되면 빠진다.
export async function listMyApprovals(actor: UserContext, limit: number): Promise<ApprovalView[]> {
  return listApprovals(pool, { orgId: actor.orgId, status: 'pending', stage: 'role_review', reviewerUserId: actor.userId, limit });
}

// 프로젝트의 승인 이력 — 볼 수 있는 범위는 태스크·노트와 같다.
export async function listProjectApprovals(
  actor: UserContext,
  projectId: string,
  status: ApprovalStatusFilter,
  stage: ApprovalStageFilter,
  limit: number,
): Promise<ApprovalView[]> {
  await withTransaction((tx) => assertProjectVisibleToUser(tx, actor, projectId));
  return listApprovals(pool, { projectId, status, stage, limit });
}

// 결정할 자격 — 1차 검토는 검토자(지금도 그 역할 담당일 때) 또는 대표, final·G3는 대표만.
// 검토자가 역할에서 빠졌으면(해제·탈퇴) 대표만 남는다 — 카드의 reviewer_user_id는 만든 순간의 값이다.
async function assertCanDecide(tx: PoolClient, actor: UserContext, approval: ApprovalRow, teamRole: string | null): Promise<void> {
  if (actor.orgRole === 'REPRESENTATIVE') return;
  if (approval.stage === 'role_review' && approval.reviewerUserId === actor.userId) {
    const owner = await findRoleOwner(tx, approval.projectId, teamRole);
    if (owner?.userId === actor.userId) return;
  }
  throw new AppError(
    'NOT_APPROVAL_REVIEWER',
    approval.stage === 'role_review'
      ? 'only the role owner under review or the organization representative can decide this approval'
      : 'only the organization representative can make the final decision',
  );
}

// reason: 반려 사유(필수), 승인이면 선택 메모(1차 검토 결과에 남는다).
export async function decide(
  actor: UserContext,
  approvalId: string,
  decision: ApprovalDecision,
  reason: string | null,
): Promise<ApprovalView> {
  if (decision === 'REJECT' && !reason) throw new AppError('VALIDATION_ERROR', 'a rejection needs a reason');

  const { projectId, changedTasks } = await withTransaction(async (tx) => {
    const approval = await findApprovalForUpdate(tx, approvalId);
    if (!approval) throw new AppError('APPROVAL_NOT_FOUND', `approval ${approvalId} not found`);
    if (approval.orgId !== actor.orgId) throw new AppError('CROSS_ORG_ACCESS', 'cannot access another organization');
    // 태스크 행을 잠가 역할을 읽는다(ACTION). G3는 대상이 프로젝트라 태스크가 없다.
    const task = approval.gate === 'ACTION' ? await lockApprovalTask(tx, approval.subjectId) : null;
    await assertCanDecide(tx, actor, approval, task?.teamRole ?? null);
    if (approval.decision !== null) {
      throw new AppError('APPROVAL_ALREADY_DECIDED', `approval was already decided (${approval.decision})`);
    }
    // 중단된 프로젝트(021)의 카드는 결정하지 않는다 — 대기열에서도 빠진다(listApprovals).
    const owning = await findProjectById(tx, approval.projectId);
    if (owning?.status === 'aborted') throw new AppError('PROJECT_NOT_OPEN', 'the project was aborted');
    if (approval.gate === 'G3') {
      // 승인 = 통합 확인 끝 → 프로젝트 완료. 반려 = 진행 중 그대로(고칠 태스크는 대표가 만든다 — 다시 전부 DONE이 되면 새 카드).
      if (!(await decideApproval(tx, approval.id, decision, actor.userId, reason))) {
        throw new AppError('APPROVAL_ALREADY_DECIDED', 'approval was decided concurrently');
      }
      if (decision === 'APPROVE') await markProjectCompleted(tx, approval.projectId);
      const released = (await findProjectById(tx, approval.projectId))!;
      await appendEvent(tx, {
        orgId: actor.orgId,
        projectId: approval.projectId,
        type: 'RELEASE_DECIDED',
        onBehalfOf: actor.userId,
        payload: { approvalId: approval.id, decision, reason, projectStatus: released.status },
      });
      return { projectId: approval.projectId, changedTasks: true };
    }
    if (approval.gate !== 'ACTION') {
      throw new AppError('APPROVAL_NOT_FOUND', `approval ${approvalId} is not an action approval`);
    }

    // 결정 순간에도 태스크가 승인 대기여야 한다(정지·수동 변경 등으로 바뀌었으면 결정을 받지 않는다).
    if (!task || task.state !== 'AWAITING_APPROVAL') {
      throw new AppError('APPROVAL_STALE', `the task is no longer awaiting approval (${task?.state ?? 'gone'})`);
    }

    if (!(await decideApproval(tx, approval.id, decision, actor.userId, reason))) {
      throw new AppError('APPROVAL_ALREADY_DECIDED', 'approval was decided concurrently');
    }

    const project = (await findProjectById(tx, approval.projectId))!;
    const isRoleReview = approval.stage === 'role_review';
    const decidedByRepresentative = isRoleReview && actor.orgRole === 'REPRESENTATIVE';
    const deciderNickname = await findUserNickname(tx, actor.userId);

    // 1차 검토 승인 — 태스크는 AWAITING_APPROVAL 그대로, 같은 스냅샷으로 대표의 final 카드를 만든다.
    if (isRoleReview && decision === 'APPROVE') {
      const roleReview: RoleReviewRecord = {
        by: actor.userId,
        nickname: deciderNickname,
        at: new Date().toISOString(),
        decidedByRepresentative,
        ...(reason ? { note: reason } : {}),
      };
      const { roleReviewSkipped: _skipped, ...snapshot } = approval.payload;
      const final = await insertApproval(tx, {
        projectId: approval.projectId,
        gate: 'ACTION',
        subjectId: approval.subjectId,
        artifactId: approval.artifactId,
        gateMode: approval.gateMode,
        stage: 'final',
        reviewerUserId: null,
        payload: { ...snapshot, roleReview, roleReviewApprovalId: approval.id },
      });
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
          reviewer: 'role_owner',
          selfApproval: task.assigneeOwnerId !== null && task.assigneeOwnerId === actor.userId,
          taskState: 'AWAITING_APPROVAL',
          stage: 'role_review',
          teamRole: task.teamRole,
          deciderNickname,
          decidedByRepresentative,
          nextApprovalId: final.id,
        },
      });
      await appendEvent(tx, {
        orgId: actor.orgId,
        projectId: approval.projectId,
        type: 'APPROVAL_REQUESTED',
        onBehalfOf: actor.userId,
        policyHash: project.policyHash,
        payload: {
          approvalId: final.id,
          gate: 'ACTION',
          taskId: approval.subjectId,
          artifactId: approval.artifactId!,
          gateMode: approval.gateMode!,
          triggeredActions: (approval.payload.triggeredActions as string[] | undefined) ?? [],
          stage: 'final',
          reviewerUserId: null,
          roleReviewApprovalId: approval.id,
        },
      });
      // 태스크 상태는 그대로다 — 에이전트에게 알릴 변화가 없다(화면은 events 트리거로 approvals 토픽을 받는다).
      return { projectId: approval.projectId, changedTasks: false };
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
        // 1차 검토는 역할 담당의 결정이다. 최종은 대표 — PM 리뷰가 생길 때까지 PM_REVIEW 카드도 대표가 대신 본다(지표를 나눠 셀 수 있게 표시한다).
        reviewer: isRoleReview ? 'role_owner' : approval.gateMode === 'PM_REVIEW' ? 'human_fallback' : 'human',
        // 결정한 사람이 제출한 에이전트의 주인이다(대표·역할 담당이 자기 에이전트의 결과를 본 경우).
        selfApproval: task.assigneeOwnerId !== null && task.assigneeOwnerId === actor.userId,
        taskState,
        stage: approval.stage,
        teamRole: task.teamRole,
        deciderNickname,
        ...(isRoleReview ? { decidedByRepresentative } : {}),
        ...(retryCount === null ? {} : { retryCount, retryCause: 'REJECTED' as const }),
      },
    });
    // 이 승인으로 마지막 태스크가 DONE이 됐으면 통합 확인(G3)을 요청한다.
    if (decision === 'APPROVE') await requestReleaseIfComplete(tx, { orgId: actor.orgId, projectId: approval.projectId });
    return { projectId: approval.projectId, changedTasks: true };
  });

  // 커밋 뒤 — 승인이면 뒤 태스크가 풀리고, 반려면 이 태스크가 다시 READY다. 1차 검토 승인은 태스크가 그대로라 부르지 않는다.
  if (changedTasks) tasksChanged(projectId);
  // 응답은 결정한 카드다. 1차 검토 승인이면 새로 생긴 final 카드가 아니라 방금 닫은 role_review 카드를 돌려준다(FE가 버튼을 누른 그 카드).
  const [view] = (await listApprovals(pool, { projectId, status: 'all', limit: 200 })).filter((a) => a.id === approvalId);
  return view!;
}
