import { pool, withTransaction } from '../../config/db.js';
import { AppError } from '../../errors.js';
import { requestReleaseIfComplete } from '../approval/service.js';
import { tasksChanged } from '../dispatch/tasks-changed.js';
import { appendEvent } from '../events/append.js';
import { findProjectById, listProjectMembers } from '../project/repository.js';
import type { UserContext } from '../project/visibility.js';
import { expirePendingForTask } from '../question/repository.js';
import { insertVerification } from '../verification/repository.js';
import { inspectManualCommit } from '../verification/service.js';
import { closeTaskByHuman, findTaskById, insertArtifact, listOpenDependents, type Task } from './repository.js';

// 사람이 조정하는 출구(027, 대표 결정 2026-10-24) — 재실행으로 풀리지 않는 태스크를 사람이 닫는다.
//
//   취소(대표): 잘못 나눈·필요 없어진 태스크. CANCELLED로 닫고 기록은 남긴다. 통합 확인(G3)과 뒤 태스크의 선행에서 "끝난 것"으로 센다 —
//              안 그러면 그 태스크 하나 때문에 프로젝트가 영원히 끝나지 않는다. 대신할 일은 새 태스크로 만든다.
//   직접 완료(그 역할 담당 또는 대표): 에이전트가 끝내 못 한 일을 개발자가 태스크 브랜치에 직접 커밋하고 넘긴다.
//              에이전트 제출과 **같은 V3**(실제 diff·신고 대조·경로 소유권)를 통과해야 DONE이다. 실패면 아무것도 바뀌지 않는다(422).
//              서버가 커밋을 못 읽으면(SKIPPED) 받지 않는다(409 MANUAL_COMPLETION_UNVERIFIABLE) — 확인 안 된 sha로 DONE이 되지 않게.
//
// 둘 다 사람이 붙잡지 않은 상태(READY·BLOCKED·ESCALATED)에서만 — 에이전트가 작업 중인 태스크를 밑에서 닫지 않는다(409 TASK_IN_PROGRESS).
// 재시도 횟수는 건드리지 않는다. 이벤트(TASK_CANCELLED·TASK_COMPLETED_MANUALLY)로 지표에서 따로 센다.

const CLOSABLE = new Set(['READY', 'BLOCKED', 'ESCALATED']);

async function loadForHuman(actor: UserContext, taskId: string): Promise<{ task: Task; policyHash: string }> {
  const task = await findTaskById(pool, taskId);
  if (!task) throw new AppError('TASK_NOT_FOUND', `task ${taskId} not found`);
  const project = await findProjectById(pool, task.projectId);
  // 지운 프로젝트(029)의 태스크는 없는 것으로 본다.
  if (!project) throw new AppError('TASK_NOT_FOUND', `task ${taskId} not found`);
  if (project.orgId !== actor.orgId) throw new AppError('CROSS_ORG_ACCESS', 'cannot access another organization');
  if (project.status !== 'active' && project.status !== 'planning') {
    throw new AppError('PROJECT_NOT_OPEN', `project is ${project.status}`);
  }
  assertClosable(task);
  return { task, policyHash: project.policyHash };
}

function assertClosable(task: Task): void {
  if (task.state === 'DONE' || task.state === 'CANCELLED') throw new AppError('TASK_ALREADY_CLOSED', `task is already ${task.state}`);
  if (!CLOSABLE.has(task.state)) {
    throw new AppError('TASK_IN_PROGRESS', `task is ${task.state} — an agent is working on it or it awaits a decision; stop or decide it first`);
  }
}

export async function cancelTask(actor: UserContext, taskId: string, reason: string): Promise<Task> {
  if (actor.orgRole !== 'REPRESENTATIVE') throw new AppError('NOT_REPRESENTATIVE', 'only the representative can cancel a task');
  const { task } = await loadForHuman(actor, taskId);
  const closed = await withTransaction(async (tx) => {
    const next = await closeTaskByHuman(tx, taskId, 'CANCELLED');
    if (!next) throw new AppError('TASK_IN_PROGRESS', 'the task changed while cancelling — reload and try again');
    const expiredQuestionIds = await expirePendingForTask(tx, taskId);
    const unblockedDependents = await listOpenDependents(tx, taskId);
    await appendEvent(tx, {
      orgId: actor.orgId,
      projectId: task.projectId,
      type: 'TASK_CANCELLED',
      onBehalfOf: actor.userId,
      payload: { taskId, title: task.title, previousState: task.state, reason, expiredQuestionIds, unblockedDependents },
    });
    // 마지막 남은 태스크를 취소했으면 통합 확인을 요청한다.
    await requestReleaseIfComplete(tx, { orgId: actor.orgId, projectId: task.projectId });
    return next;
  });
  tasksChanged(task.projectId);
  return closed;
}

export async function completeTaskManually(
  actor: UserContext,
  taskId: string,
  input: { commitSha: string; changedPaths: string[]; note: string | null },
): Promise<Task> {
  const { task, policyHash } = await loadForHuman(actor, taskId);
  // 그 역할의 담당(에이전트 주인) 또는 대표만 — 사람이 넘기는 코드도 그 역할의 영역 규칙을 받는다.
  if (actor.orgRole !== 'REPRESENTATIVE') {
    const members = await listProjectMembers(pool, task.projectId);
    if (!members.some((m) => m.teamRole === task.teamRole && m.userId === actor.userId)) {
      throw new AppError('NOT_TASK_OWNER', `only the ${task.teamRole ?? 'assigned'} member or the representative can complete this task`);
    }
  }

  // 네트워크·git이라 트랜잭션 밖에서. 실패면 아무것도 쓰지 않는다.
  const v3 = await inspectManualCommit({ task, projectId: task.projectId, policyHash, commitSha: input.commitSha, changedPaths: input.changedPaths });
  if (v3.result === 'FAIL') {
    throw new AppError('MANUAL_COMPLETION_INVALID', `the commit did not pass the path check: ${String(v3.detail.reason ?? '')}`, v3.detail);
  }
  // 사람이 넘기는 결과는 **확인된 커밋만** 받는다. 에이전트 제출의 SKIPPED(서버 사정으로 못 읽음)는 에이전트 잘못이 아니라 허용하지만,
  // 직접 완료에서 허용하면 없는 sha로도 DONE이 된다(FE 보고 — clone_url이 없는 로컬 프로젝트).
  if (v3.result !== 'PASS') {
    throw new AppError(
      'MANUAL_COMPLETION_UNVERIFIABLE',
      `the server could not read the commit, so it cannot be accepted: ${String(v3.detail.reason ?? '')} — check the repository's clone_url or GitHub connection`,
    );
  }

  const closed = await withTransaction(async (tx) => {
    const artifact = await insertArtifact(tx, { taskId, commitSha: input.commitSha, changedPaths: input.changedPaths, triggeredActions: [], gateMode: 'HUMAN' });
    await insertVerification(tx, { ...v3, artifactId: artifact.id });
    const next = await closeTaskByHuman(tx, taskId, 'DONE');
    if (!next) throw new AppError('TASK_IN_PROGRESS', 'the task changed while completing — reload and try again');
    await appendEvent(tx, {
      orgId: actor.orgId,
      projectId: task.projectId,
      type: 'TASK_COMPLETED_MANUALLY',
      onBehalfOf: actor.userId,
      policyHash,
      payload: {
        taskId,
        title: task.title,
        artifactId: artifact.id,
        commitSha: input.commitSha,
        changedPaths: input.changedPaths,
        previousState: task.state,
        v3: v3.result,
        note: input.note,
      },
    });
    await requestReleaseIfComplete(tx, { orgId: actor.orgId, projectId: task.projectId });
    return next;
  });
  tasksChanged(task.projectId);
  return closed;
}
