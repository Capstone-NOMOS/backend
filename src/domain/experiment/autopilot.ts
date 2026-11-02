import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../errors.js';
import { decideAsExperiment } from '../approval/service.js';
import { approveContractAsExperiment, redraftWithAnswers, retryContractAsExperiment } from '../contract/service.js';
import { onContractsChanged } from '../dispatch/contracts-changed.js';
import { onExperimentNudge } from '../dispatch/experiment-nudge.js';
import { onTasksChanged } from '../dispatch/tasks-changed.js';
import { appendEvent } from '../events/append.js';
import type { ExperimentSkippedPayload } from '../events/types.js';
import { findPendingPlan, findTaskSplitBlockers } from '../pm/repository.js';
import { applyPlanAsExperiment, requestTaskSplitAsExperiment, retryPlanAsExperiment, retryRewriteWithAnswers } from '../pm/service.js';
import type { UserContext } from '../project/visibility.js';
import { EXPERIMENT_ACTOR } from './attribution.js';
import {
  findOpenExperimentProject,
  listContractCandidates,
  listPendingActionApprovals,
  listPlanLeaves,
  needsTaskSplit,
  type ExperimentProject,
} from './repository.js';

// 무인 실험(034) — 실험 모드(question_mode = experiment) 프로젝트는 사람 없이 끝까지 돈다.
// 사람이 누르던 결정을 서버가 system:experiment 명의(payload auto: true)로 대신한다. 사람은 끝난 뒤 내보낸 데이터셋에 정답 라벨만 붙인다.
//
//   기능 명세 초안 ready·대기 질문 없음·이 판에 새 질문 없음 → 적용(acceptAssumptions)
//   계약 draft·대기 질문 없음·이 초안에 새 질문 없음        → 확정(acceptAssumptions)
//   확정 명세 중 태스크 없는 것 + 계약 전부 확정 + 작성 중 계획 없음 → 태스크 나누기 요청 → ready면 적용
//   ACTION 승인 카드(1차 검토·최종)                          → 승인. **G3는 하지 않는다**(프로젝트가 끝나 다음 회차를 넣을 수 없다)
//   PM 초안 failed(budget 제외)                              → 같은 요청을 EXPERIMENT_PLAN_RETRIES회까지, 넘으면 EXPERIMENT_SKIPPED
//   계약 failed                                              → 수정 요청을 EXPERIMENT_CONTRACT_RETRIES회까지, 넘으면 EXPERIMENT_SKIPPED
//   답이 다 왔는데 다시 쓰지 못한 초안(그때 다른 초안이 작성 중)  → 다시 쓰기를 다시 시도
//
// "새 질문 없음"이 "다 됐다"다 — 재작성이 질문을 더 내지 않거나 회차 상한(EXPERIMENT_QUESTION_ROUNDS)에 닿아 질문을 가정으로 옮겼다.
// 판정·검증은 각 서비스의 사람 경로와 한 벌이다(…AsExperiment가 같은 함수를 부르고, 자격 검사만 "실험 모드인가"로 바꾼다).
//
// 언제 도나: 상태를 바꾼 서비스가 커밋 뒤에 부르는 신호(experimentNudge·tasksChanged·contractsChanged)와 주기 정리(sweep.ts).
// 매번 프로젝트 상태를 다시 읽어 판정하므로 신호를 놓치거나 겹쳐도 결과가 같다. 한 프로젝트는 한 줄로 돈다(겹치면 끝난 뒤 한 번 더).
// 자동 처리가 실패해도 원래 흐름은 이미 커밋돼 있다 — 로그만 남기고 다음 신호·주기 정리에서 다시 본다.
// 기본 모드 프로젝트는 첫 조회(findOpenExperimentProject)에서 걸러진다 — 아무것도 바뀌지 않는다.

// 한 번 돌 때 최대 몇 바퀴(1차 검토 승인 → 최종 카드 승인처럼 앞 처리가 다음 처리를 낳는다).
const MAX_PASSES = 10;

const projects = new Map<string, { dirty: boolean }>();
const inflight = new Set<Promise<void>>();

export function scheduleExperimentRun(projectId: string): void {
  const running = projects.get(projectId);
  if (running) {
    running.dirty = true;
    return;
  }
  const state = { dirty: false };
  projects.set(projectId, state);
  const job = (async () => {
    try {
      do {
        state.dirty = false;
        await runExperimentAutopilot(projectId);
      } while (state.dirty);
    } catch (err) {
      logger.warn('실험 모드 자동 진행 실패', { projectId, error: String(err) });
    } finally {
      projects.delete(projectId);
    }
  })().finally(() => inflight.delete(job));
  inflight.add(job);
}

// 테스트용 — 자동 진행이 낳은 작업까지 다 끝날 때까지.
export async function drainExperimentAutopilot(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}

// 한 프로젝트를 자동으로 통과시킬 것이 없을 때까지 처리한다. 처리한 건수를 돌려준다(테스트·감독용).
export async function runExperimentAutopilot(projectId: string): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const project = await findOpenExperimentProject(pool, projectId);
    if (!project || !project.representativeUserId) return total;
    const acted = await onePass(project, { userId: project.representativeUserId, orgId: project.orgId, orgRole: 'REPRESENTATIVE' });
    total += acted;
    if (acted === 0) return total;
  }
  return total;
}

async function attempt(what: string, subject: Record<string, string>, fn: () => Promise<boolean | void>): Promise<boolean> {
  try {
    return (await fn()) !== false;
  } catch (err) {
    // 다른 초안이 작성 중(프로젝트당 하나)이면 그게 끝날 때 다시 신호가 온다 — 경고할 일이 아니다.
    if (err instanceof AppError && err.code === 'PM_PLAN_IN_PROGRESS') return false;
    logger.warn(`실험 모드 자동 처리 실패: ${what}`, { ...subject, error: String(err) });
    return false;
  }
}

async function onePass(project: ExperimentProject, rep: UserContext): Promise<number> {
  let acted = 0;

  // ① PM 초안(기능 명세·태스크 나누기)
  for (const plan of await listPlanLeaves(pool, project.id)) {
    if (plan.skipped) continue;
    if (plan.status === 'ready') {
      if (plan.pendingQuestionCount > 0) continue; // 자동 답을 기다린다(빠졌으면 주기 정리가 다시 답한다)
      if (plan.answeredQuestionCount > 0) {
        // 답이 다 왔는데 다음 판이 없다 — 그때 다른 초안이 작성 중이었다. 다시 쓰기를 다시 시도한다(다음 판이 생기면 이 판은 빠진다).
        await attempt('답으로 다시 쓰기', { planId: plan.id }, () => retryRewriteWithAnswers(plan.id));
        continue;
      }
      const applied = await attempt('초안 적용', { planId: plan.id }, () => applyPlanAsExperiment(rep.userId, project.id, plan.id));
      if (applied) acted += 1;
      else if (await skip(project, { kind: 'plan', planId: plan.rootPlanId, planKind: plan.kind }, 'apply_failed', plan.retries)) acted += 1;
      continue;
    }
    // failed — 예산 소진은 다시 내도 같다(감독 스크립트가 멈추고 알린다).
    if (plan.errorReason === 'budget') continue;
    if (plan.retries < env.EXPERIMENT_PLAN_RETRIES) {
      if (await attempt('초안 다시 요청', { planId: plan.id }, () => retryPlanAsExperiment(rep.userId, project.id, plan.id))) acted += 1;
    } else if (await skip(project, { kind: 'plan', planId: plan.rootPlanId, planKind: plan.kind }, plan.errorReason ?? 'failed', plan.retries)) {
      acted += 1;
    }
  }

  // ② API 계약
  for (const contract of await listContractCandidates(pool, project.id)) {
    if (contract.skipped) continue;
    if (contract.status === 'draft') {
      if (contract.pendingQuestionCount > 0) continue;
      if (contract.currentAnsweredCount > 0) {
        // 이 초안의 질문에 답이 다 왔다 — 다음 회차를 연다(보통은 답 신호가 이미 열었다).
        if (await attempt('계약 다음 회차', { contractId: contract.id }, () => redraftWithAnswers(contract.id))) acted += 1;
        continue;
      }
      if (await attempt('계약 확정', { contractId: contract.id }, () => approveContractAsExperiment(rep, contract.id))) acted += 1;
      continue;
    }
    if (contract.experimentRetries < env.EXPERIMENT_CONTRACT_RETRIES) {
      if (await attempt('계약 다시 시키기', { contractId: contract.id }, () => retryContractAsExperiment(contract.id))) acted += 1;
    } else if (await skip(project, { kind: 'contract', contractId: contract.id, featureKey: contract.featureKey }, contract.errorReason ?? 'failed', contract.experimentRetries)) {
      acted += 1;
    }
  }

  // ③ 승인 카드(ACTION — 1차 검토를 승인하면 최종 카드가 생겨 다음 바퀴에서 승인된다)
  for (const approvalId of await listPendingActionApprovals(pool, project.id)) {
    if (await attempt('승인', { approvalId }, () => decideAsExperiment(rep, approvalId))) acted += 1;
  }

  // ④ 태스크 나누기 — 태스크 없는 확정 명세가 있고, API 기능의 계약이 전부 확정됐고, 작성 중인 계획이 없을 때
  if (!(await findPendingPlan(pool, project.id)) && (await needsTaskSplit(pool, project.id))) {
    const { specCount, unapprovedContracts } = await findTaskSplitBlockers(pool, project.id);
    if (specCount > 0 && unapprovedContracts.length === 0) {
      if (await attempt('태스크 나누기 요청', { projectId: project.id }, () => requestTaskSplitAsExperiment(rep.userId, project.id))) acted += 1;
    }
  }
  return acted;
}

// 자동으로 다시 시켜도 끝내지 못한 흐름을 포기한다(한 번만 — 이벤트가 있으면 조회에서 빠진다).
async function skip(project: ExperimentProject, subject: ExperimentSkippedPayload['subject'], reason: string, retries: number): Promise<boolean> {
  await withTransaction((tx) =>
    appendEvent(tx, {
      orgId: project.orgId,
      projectId: project.id,
      type: 'EXPERIMENT_SKIPPED',
      onBehalfOf: EXPERIMENT_ACTOR,
      policyHash: project.policyHash,
      payload: { auto: true, subject, reason, retries },
    }),
  );
  logger.warn('실험 모드: 자동으로 끝내지 못해 포기했다', { projectId: project.id, subject, reason, retries });
  return true;
}

// 신호 구독 — app이 import하면 걸린다(startDispatchRecorder와 같은 자리). 기본 모드 프로젝트의 신호는 첫 조회에서 끝난다.
let started = false;
export function startExperimentAutopilot(): void {
  if (started) return;
  started = true;
  onExperimentNudge(scheduleExperimentRun);
  onTasksChanged((projectId) => scheduleExperimentRun(projectId));
  onContractsChanged((projectId) => scheduleExperimentRun(projectId));
}
