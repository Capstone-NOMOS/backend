import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { PoolClient } from 'pg';
import { pool, withTransaction, type Queryable } from '../../config/db.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../errors.js';
import { authorInTransaction } from '../authoring/apply.js';
import { findActor, lockProjectForAuthoring } from '../authoring/repository.js';
import { requestContractsInTx } from '../contract/service.js';
import { onPlanningQuestionsSettled } from '../dispatch/planning-questions.js';
import { experimentNudge } from '../dispatch/experiment-nudge.js';
import { autoMark, EXPERIMENT_ATTRIBUTION, type Attribution } from '../experiment/attribution.js';
import {
  answersBlock,
  answeredTexts,
  assumptionOf,
  closeQuestionsAsAssumed,
  insertPlanningQuestionsInTx,
  limitPlanningQuestions,
  planningQuestionsCommitted,
  questionsPendingError,
  repeatedAssumption,
  routePlanningQuestions,
  splitRepeated,
  toAskedQuestion,
  type RoutedPlanningQuestion,
} from '../question/planning.js';
import { listPendingQuestionsOf, listQuestionsOf, listQuestionsOfPlanChain } from '../question/repository.js';
import type { RoutingInput } from '../question/router.js';
import { TEAM_ROLES } from '../roles.js';
import { contractsChanged } from '../dispatch/contracts-changed.js';
import { tasksChanged } from '../dispatch/tasks-changed.js';
import { appendEvent } from '../events/append.js';
import type { AuthoringInput } from '../authoring/apply.js';
import { contractCoverageProblems, dagHashOf, draftToAuthoring, PLAN_DRAFT_JSON_SCHEMA, planDraftSchema, planStructure, pmOnlyProblems, type PlanDraft } from './draft.js';
import {
  FEATURE_DRAFT_JSON_SCHEMA,
  featureDraftSchema,
  featureContent,
  featureDraftToAuthoring,
  featureHashOf,
  featureOnlyProblems,
  featureStructure,
  type FeatureDraft,
} from './feature-draft.js';
import { getPmModel, type PmModel } from './model.js';
import {
  completeJob,
  failJob,
  RelayJobNotTaken,
  RelayWorkerFailed,
  relayWorkerLastSeen,
  takeNextJob,
  type RelayJob,
  type RelayResult,
} from './relay.js';
import { findUserById } from '../org/repository.js';
import { costOfAttempts, estimateInputTokens, maxCallCost, type AttemptUsage } from './pricing.js';
import { buildFeatureUserPrompt, buildUserPrompt, FEATURE_SYSTEM_PROMPT, PM_SYSTEM_PROMPT, type PlanContext } from './prompt.js';
import {
  chainHasAppliedPlan,
  countChainAnswerRounds,
  countChainRevisions,
  findPendingPlan,
  findPlan,
  findProjectForPm,
  findTaskSplitBlockers,
  hasChildPlan,
  insertPendingPlan,
  listAllPendingPlans,
  listPlans,
  listRoleAssignees,
  loadPlanContext,
  markPlanApplied,
  markPlanFailed,
  markPlanReady,
  markPlanRejected,
  planCostsUsd,
  planQuestionCounts,
  pmSpentUsd,
  setInflightMaxCost,
  type PlanErrorReason,
  type PlanKind,
  type PlanRow,
  type ProjectForPm,
  type RoleAssignee,
} from './repository.js';

// 내장 PM — 계획 수립. 대표의 지시 → PM 초안(비동기) → 대표 검토 → 적용.
//
// - 판정은 코드가 한다(P2): 초안은 명세·태스크 생성과 같은 검증(domain/authoring)을 dry-run으로 거친다.
//   위반이면 위반 목록을 붙여 **한 번만** 다시 쓰게 하고, 그래도 틀리면 failed(invalid)다.
// - 응답은 stop_reason부터 본다. 거절(refused)·잘림(truncated)은 PM이 틀린 게 아니므로 교정하지 않는다.
// - 매 호출 전에 "누적 + 이번 최대치 > 예산"을 검사한다. 넘으면 호출하지 않는다.
// - 행동의 주인: 요청·적용은 대표, 초안 생성·호출은 system:pm(P3).

const PM_ACTOR = 'system:pm';
const OPEN_STATUSES = new Set(['planning', 'active']);

// ── 계획 종류별 차이(022) ────────────────────────────────────────────────
// 호출·교정·예산·시간 제한·중계·적용 흐름은 한 벌이고, 종류마다 지침·출력 형식·검증·적용 입력만 다르다.
type Previous = { draft: unknown; feedback?: string; answers?: string; problems?: string[] };
type KindSpec = {
  system: string;
  schema: Record<string, unknown>;
  buildUser(context: PlanContext, instruction: string, previous?: Previous): string;
  parse(json: unknown): { ok: true; draft: unknown } | { ok: false; problems: string[] };
  ownProblems(draft: unknown, context: PlanContext): string[];
  toAuthoring(draft: unknown, ctx: { projectId: string; actorUserId: string; planId: string }): AuthoringInput;
  shape(draft: unknown): { structure: unknown; hash: string; mode: string | null; specCount: number; taskCount: number };
};

function zodProblems(issues: { path: (string | number)[]; message: string }[]): string[] {
  return issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

const KINDS: Record<PlanKind, KindSpec> = {
  // 기능 명세(새 흐름 1단계) — 명세만 만든다. 태스크는 대표가 나중에 따로 나눈다.
  feature: {
    system: FEATURE_SYSTEM_PROMPT,
    schema: FEATURE_DRAFT_JSON_SCHEMA,
    buildUser: (context, instruction, previous) => buildFeatureUserPrompt({ context, instruction, ...(previous ? { previous } : {}) }),
    parse: (json) => {
      const r = featureDraftSchema.safeParse(json);
      return r.success ? { ok: true, draft: r.data } : { ok: false, problems: zodProblems(r.error.issues) };
    },
    ownProblems: (draft) => featureOnlyProblems(draft as FeatureDraft),
    toAuthoring: (draft, ctx) => featureDraftToAuthoring(draft as FeatureDraft, ctx),
    shape: (draft) => {
      const d = draft as FeatureDraft;
      const structure = featureStructure(d);
      return { structure, hash: featureHashOf(structure), mode: null, specCount: d.features.length, taskCount: 0 };
    },
  },
  tasks: {
    system: PM_SYSTEM_PROMPT,
    schema: PLAN_DRAFT_JSON_SCHEMA,
    buildUser: (context, instruction, previous) =>
      buildUserPrompt({ context, instruction, ...(previous ? { previous: { ...previous, draft: previous.draft as PlanDraft } } : {}) }),
    parse: (json) => {
      const r = planDraftSchema.safeParse(json);
      return r.success ? { ok: true, draft: r.data } : { ok: false, problems: zodProblems(r.error.issues) };
    },
    ownProblems: (draft, context) => [...pmOnlyProblems(draft as PlanDraft), ...contractCoverageProblems(draft as PlanDraft, context)],
    toAuthoring: (draft, ctx) => draftToAuthoring(draft as PlanDraft, ctx),
    shape: (draft) => {
      const d = draft as PlanDraft;
      const structure = planStructure(d);
      return { structure, hash: dagHashOf(structure), mode: d.mode, specCount: d.specs.length, taskCount: d.tasks.length };
    },
  },
};

// ── 요청 ────────────────────────────────────────────────────────────────

export type PlanView = {
  id: string;
  projectId: string;
  kind: PlanKind;
  status: PlanRow['status'];
  instruction: string | null;
  feedback: string | null;
  parentPlanId: string | null;
  mode: string | null;
  // 태스크 분할 초안(kind=tasks). 기능 명세면 null.
  draft: PlanDraft | null;
  // 기능 명세 초안(kind=feature, 022). 태스크 분할이면 null.
  featureDraft: FeatureDraft | null;
  error: { reason: PlanErrorReason; detail: unknown } | null;
  costUsd: number;
  createdAt: string;
  appliedAt: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  // 033: 왜 다시 썼나(feedback 대표의 수정 요청 | answers 질문의 답) — 원본은 null.
  revisionCause: PlanRow['revisionCause'];
  // 033: 이 초안의 기획 단계 질문 — 화면의 "답 대기 질문 N개". 질문 목록은 GET /projects/{id}/questions(planId)로 읽는다.
  questionCount: number;
  pendingQuestionCount: number;
  // 초안의 태스크마다 누가 받게 되는가. PM이 정하지 않고 **서버가 조회 시점에 계산**한다 —
  // 프로젝트에서 역할당 에이전트는 하나라(uq_project_members_role) teamRole이면 담당이 결정적으로 정해진다.
  // 저장하지 않는 이유: 프로젝트 시작(G1) 전에는 멤버가 바뀔 수 있다. 역할에 아무도 없으면 agent가 null — 적용하면 그 태스크는 아무도 가져가지 않는다.
  assignments: TaskAssignment[];
};

export type TaskAssignment = {
  ref: string;
  teamRole: string | null;
  agent: { id: string; name: string; userId: string; nickname: string | null } | null;
};

function assignmentsOf(draft: PlanDraft | null, assignees: Map<string, RoleAssignee>): TaskAssignment[] {
  if (!draft) return [];
  return draft.tasks.map((t) => {
    const who = t.teamRole === null ? undefined : assignees.get(t.teamRole);
    return {
      ref: t.ref,
      teamRole: t.teamRole,
      agent: who ? { id: who.agentId, name: who.agentName, userId: who.userId, nickname: who.nickname } : null,
    };
  });
}

function toView(
  plan: PlanRow,
  costUsd: number,
  assignees: Map<string, RoleAssignee>,
  questions: { total: number; pending: number } = { total: 0, pending: 0 },
): PlanView {
  const tasksDraft = plan.kind === 'tasks' ? ((plan.draft as PlanDraft | null) ?? null) : null;
  return {
    id: plan.id,
    projectId: plan.projectId,
    kind: plan.kind,
    status: plan.status,
    instruction: plan.instruction,
    feedback: plan.feedback,
    parentPlanId: plan.parentPlanId,
    mode: plan.mode,
    draft: tasksDraft,
    featureDraft: plan.kind === 'feature' ? ((plan.draft as FeatureDraft | null) ?? null) : null,
    error: plan.errorReason === null ? null : { reason: plan.errorReason, detail: plan.errorDetail ?? null },
    costUsd,
    createdAt: plan.createdAt,
    appliedAt: plan.appliedAt,
    rejectedAt: plan.rejectedAt,
    rejectReason: plan.rejectReason,
    revisionCause: plan.revisionCause,
    questionCount: questions.total,
    pendingQuestionCount: questions.pending,
    assignments: assignmentsOf(tasksDraft, assignees),
  };
}

async function assertRepresentativeOf(tx: PoolClient, actorUserId: string, project: { orgId: string }): Promise<void> {
  const actor = await findActor(tx, actorUserId);
  if (!actor || actor.orgId !== project.orgId) throw new AppError('CROSS_ORG_ACCESS', 'cannot access another organization');
  if (actor.orgRole !== 'REPRESENTATIVE') {
    throw new AppError('NOT_REPRESENTATIVE', 'only the organization representative can use the PM');
  }
}

function requireModel(): PmModel {
  const model = getPmModel();
  if (!model) throw new AppError('PM_UNAVAILABLE', 'the built-in PM is not configured on this server (ANTHROPIC_API_KEY)');
  return model;
}

// 호출 전에 보는 최대 비용. 프롬프트 길이로 입력을 보수적으로 추정한다.
async function nextCallMaxCost(tx: PoolClient, project: ProjectForPm, kind: PlanKind, instruction: string, previous?: unknown) {
  const context = await loadPlanContext(tx, project);
  const spec = KINDS[kind];
  const user = spec.buildUser(context, instruction, previous ? { draft: previous, feedback: '' } : undefined);
  return maxCallCost(env.PM_MODEL, estimateInputTokens(spec.system, user, JSON.stringify(spec.schema)), env.PM_MAX_TOKENS);
}

async function assertWithinBudget(tx: PoolClient, project: ProjectForPm, maxCost: number): Promise<void> {
  const spent = await pmSpentUsd(tx, project.id);
  if (spent + maxCost > project.pmBudgetUsd) {
    throw new AppError(
      'PM_BUDGET_EXCEEDED',
      `PM budget would be exceeded: spent $${spent.toFixed(4)} + this call up to $${maxCost.toFixed(4)} > budget $${project.pmBudgetUsd}. ` +
        '승인 경로 미구현 — budget:exceed 승인 카드가 없어 예산을 올리기 전까지 PM을 부를 수 없다',
    );
  }
}

// 태스크 나누기(새 계획 흐름 3단계)는 확정한 기능 명세와 확정한 API 계약 위에서만 한다 — PM이 명세·계약을 지어내지 않게.
async function assertReadyToSplit(tx: PoolClient, projectId: string): Promise<void> {
  const { specCount, unapprovedContracts } = await findTaskSplitBlockers(tx, projectId);
  if (specCount === 0) {
    throw new AppError('NO_FEATURE_SPECS', 'there is no confirmed feature spec to split into tasks; request a feature spec (POST /pm/features) and confirm it first');
  }
  if (unapprovedContracts.length > 0) {
    throw new AppError(
      'CONTRACTS_NOT_APPROVED',
      `the API contract is not confirmed yet for ${unapprovedContracts.join(', ')}; the BACKEND member confirms it first`,
      { featureKeys: unapprovedContracts },
    );
  }
}

// 자동 요청(답에 따른 재작성·실험 모드 재요청)이 잠금 안에서 다시 보니 필요 없어졌다 — 신호가 겹친 경우. 조용히 그만둔다.
class AutoRequestNotNeeded extends Error {}

async function openRequest(
  actorUserId: string,
  projectId: string,
  // cause answers(033): 기획 단계 질문의 답을 붙여 다시 쓴다 — 사람이 누른 요청이 아니다(명의 system:pm, 대표의 수정 요청 한도에 세지 않는다).
  // cause retry·experiment_split(034): 실험 모드의 자동 경로(명의 system:experiment — attribution). 대표 확인은 actorUserId(조직 대표)로 그대로 한다.
  input: {
    kind: PlanKind;
    instruction: string;
    feedback: string | null;
    parent: PlanRow | null;
    cause?: 'answers' | 'retry' | 'experiment_split';
    attribution?: Attribution;
  },
): Promise<PlanView> {
  requireModel();
  const byAnswers = input.cause === 'answers';
  const byRetry = input.cause === 'retry';
  const plan = await withTransaction(async (tx) => {
    // 같은 프로젝트의 요청을 한 줄로 세운다 — "진행 중 요청은 하나" 확인과 INSERT 사이에 끼지 못하게(authoring과 같은 잠금).
    const locked = await lockProjectForAuthoring(tx, projectId);
    if (!locked) throw new AppError('PROJECT_NOT_FOUND', `project ${projectId} not found`);
    if (!byAnswers) await assertRepresentativeOf(tx, actorUserId, locked);
    if (!OPEN_STATUSES.has(locked.status)) {
      throw new AppError('PROJECT_NOT_OPEN', `project is ${locked.status}; the PM plans only while planning or active`);
    }
    // 답에 따른 재작성은 같은 잠금 안에서 다시 확인한다 — 답이 동시에 커밋되면 신호가 여러 번 오고, 대기 질문이 남았거나
    // 이미 다음 판이 열렸으면(앞선 신호·대표의 수정 요청) 열지 않는다.
    if (byAnswers && input.parent && !(await answersSettled(tx, input.parent.id))) throw new AutoRequestNotNeeded();
    // 실험 모드 자동 경로는 실험 모드 프로젝트에서만(좁은 입구). 재요청은 실패한 판이 체인의 마지막일 때 한 번만 — 신호가 겹쳐도 두 번 열지 않는다.
    if (input.attribution && (await findProjectForPm(tx, projectId))?.questionMode !== 'experiment') throw new AppError('QUESTION_MODE_INVALID', 'automatic PM requests run only in experiment mode');
    if (byRetry && input.parent && ((await findPlan(tx, input.parent.id))?.status !== 'failed' || (await hasChildPlan(tx, input.parent.id)))) {
      throw new AutoRequestNotNeeded();
    }
    if (await findPendingPlan(tx, projectId)) {
      throw new AppError('PM_PLAN_IN_PROGRESS', 'a PM plan is already being drafted for this project; wait for it to finish');
    }
    // 수정 요청 한도 — 같은 잠금 안에서 센다(동시에 두 번 눌러 한도를 넘지 못하게). 새 계획 요청(새 체인)은 0부터다.
    if (input.parent && !byAnswers && !byRetry) {
      const used = await countChainRevisions(tx, input.parent.rootPlanId);
      if (used >= env.PM_MAX_REVISIONS) {
        throw new AppError(
          'PLAN_REVISION_LIMIT',
          `this plan has already been revised ${used} time(s) (limit ${env.PM_MAX_REVISIONS}); start a new plan request instead`,
          { limit: env.PM_MAX_REVISIONS, used },
        );
      }
    }
    if (input.kind === 'tasks') await assertReadyToSplit(tx, projectId);
    const project = (await findProjectForPm(tx, projectId))!;
    await assertWithinBudget(tx, project, await nextCallMaxCost(tx, project, input.kind, input.instruction, input.parent?.draft ?? undefined));

    const id = randomUUID();
    const created = await insertPendingPlan(tx, {
      id,
      projectId,
      kind: input.kind,
      requestedBy: actorUserId,
      instruction: input.instruction,
      feedback: input.feedback,
      parentPlanId: input.parent?.id ?? null,
      rootPlanId: input.parent?.rootPlanId ?? id,
      revisionCause: input.parent ? (byAnswers ? 'answers' : byRetry ? 'retry' : 'feedback') : null,
    });
    await appendEvent(tx, {
      orgId: project.orgId,
      projectId,
      type: 'PM_PLAN_REQUESTED',
      onBehalfOf: byAnswers ? PM_ACTOR : (input.attribution?.onBehalfOf ?? actorUserId),
      policyHash: project.policyHash,
      payload: {
        ...autoMark(input.attribution),
        planId: id,
        parentPlanId: input.parent?.id ?? null,
        kind: input.parent ? 'revise' : 'draft',
        planKind: input.kind,
        ...(input.cause ? { cause: input.cause } : {}),
      },
    });
    return created;
  });
  schedule(plan.id);
  return toView(plan, 0, new Map()); // pending — 초안이 없어 담당도 없다
}

export async function requestPlan(actorUserId: string, projectId: string, instruction: string): Promise<PlanView> {
  return openRequest(actorUserId, projectId, { kind: 'tasks', instruction, feedback: null, parent: null });
}

// 기능 명세 요청(022, 새 흐름 1단계). 대표의 자연어 요구 → PM이 개발 용어 없는 기능 명세 초안 → 대표 확정(적용).
export async function requestFeatureSpec(actorUserId: string, projectId: string, instruction: string): Promise<PlanView> {
  return openRequest(actorUserId, projectId, { kind: 'feature', instruction, feedback: null, parent: null });
}

// 수정 요청. 이전 초안 + 피드백을 넣은 **새 단발 호출**이다 — 대화를 이어 붙이지 않으므로 거절된 턴이 섞일 일이 없다.
export async function revisePlan(actorUserId: string, projectId: string, planId: string, feedback: string): Promise<PlanView> {
  const parent = await findPlan(pool, planId);
  if (!parent || parent.projectId !== projectId) throw new AppError('PLAN_NOT_FOUND', `plan ${planId} not found`);
  if (parent.status !== 'ready' || parent.draft === null) {
    throw new AppError('PLAN_NOT_APPLICABLE', `only a ready plan can be revised (this one is ${parent.status})`);
  }
  return openRequest(actorUserId, projectId, { kind: parent.kind, instruction: parent.instruction ?? '', feedback, parent });
}

// ── 조회 ────────────────────────────────────────────────────────────────

async function assertCanView(actorUserId: string, projectId: string): Promise<void> {
  await withTransaction(async (tx) => {
    const project = await findProjectForPm(tx, projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', `project ${projectId} not found`);
    await assertRepresentativeOf(tx, actorUserId, project);
  });
}

export async function getPlan(actorUserId: string, projectId: string, planId: string): Promise<PlanView> {
  await assertCanView(actorUserId, projectId);
  const plan = await findPlan(pool, planId);
  if (!plan || plan.projectId !== projectId) throw new AppError('PLAN_NOT_FOUND', `plan ${planId} not found`);
  const [costs, questions] = await Promise.all([planCostsUsd(pool, [plan.id]), planQuestionCounts(pool, [plan.id])]);
  return toView(plan, costs.get(plan.id) ?? 0, await listRoleAssignees(pool, projectId), questions.get(plan.id));
}

export async function listProjectPlans(actorUserId: string, projectId: string): Promise<PlanView[]> {
  await assertCanView(actorUserId, projectId);
  const plans = await listPlans(pool, projectId);
  const costs = await planCostsUsd(pool, plans.map((p) => p.id));
  const questions = await planQuestionCounts(pool, plans.map((p) => p.id));
  const assignees = await listRoleAssignees(pool, projectId);
  return plans.map((p) => toView(p, costs.get(p.id) ?? 0, assignees, questions.get(p.id)));
}

// ── PM 준비 상태 ─────────────────────────────────────────────────────────

// 워커는 3초마다 묻는다. 이만큼 조용하면 꺼진 것으로 본다(잠깐의 네트워크 끊김은 넘긴다).
export const RELAY_WORKER_STALE_MS = 30_000;

export type PmStatus = {
  provider: 'api' | 'relay';
  // 지금 요청하면 PM이 돌 수 있는가. false면 reason이 이유다.
  ready: boolean;
  reason: 'NO_API_KEY' | 'WORKER_OFFLINE' | null;
  workerLastSeenAt: string | null;
  budgetUsd: number;
  spentUsd: number;
  // 작성 중인 계획(프로젝트당 하나). 있으면 새 요청은 409다.
  pendingPlanId: string | null;
};

// 화면이 "계획 받기" 버튼을 켜기 전에 본다. 요청 자체를 막지는 않는다 — 판단은 화면이, 실패는 기존 경로(timeout)가 한다.
export async function getPmStatus(actorUserId: string, projectId: string): Promise<PmStatus> {
  await assertCanView(actorUserId, projectId);
  const project = (await findProjectForPm(pool, projectId))!;
  const model = getPmModel();
  const provider = model?.kind === 'relay' ? 'relay' : env.PM_PROVIDER;
  const seen = model?.kind === 'relay' ? relayWorkerLastSeen(project.orgId) : null;
  let reason: PmStatus['reason'] = null;
  if (!model) reason = 'NO_API_KEY';
  else if (model.kind === 'relay' && (!seen || Date.now() - seen.getTime() > RELAY_WORKER_STALE_MS)) reason = 'WORKER_OFFLINE';
  const pending = await findPendingPlan(pool, projectId);
  return {
    provider,
    ready: reason === null,
    reason,
    workerLastSeenAt: seen ? seen.toISOString() : null,
    budgetUsd: project.pmBudgetUsd,
    spentUsd: await pmSpentUsd(pool, projectId),
    pendingPlanId: pending?.id ?? null,
  };
}

// ── 반려 ────────────────────────────────────────────────────────────────

// ready 초안을 버린다. 다시 요청 없이 닫는 것이다 — 고쳐서 다시 받으려면 수정 요청(revise)을 쓴다.
// 반려한 초안은 적용·수정 요청할 수 없다. 조건부 UPDATE라 적용과 동시에 눌려도 한쪽만 이긴다.
export async function rejectPlan(
  actorUserId: string,
  projectId: string,
  planId: string,
  reason: string | null,
): Promise<PlanView> {
  await withTransaction(async (tx) => {
    const project = await findProjectForPm(tx, projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', `project ${projectId} not found`);
    await assertRepresentativeOf(tx, actorUserId, project);
    const plan = await findPlan(tx, planId, { forUpdate: true });
    if (!plan || plan.projectId !== projectId) throw new AppError('PLAN_NOT_FOUND', `plan ${planId} not found`);
    if (!(await markPlanRejected(tx, planId, reason))) {
      throw new AppError('PLAN_NOT_APPLICABLE', `only a ready plan can be rejected (this one is ${plan.status})`);
    }
    await appendEvent(tx, {
      orgId: project.orgId,
      projectId,
      type: 'PLAN_REJECTED',
      onBehalfOf: actorUserId,
      policyHash: project.policyHash,
      payload: { planId, rootPlanId: plan.rootPlanId, reason },
    });
  });
  return getPlan(actorUserId, projectId, planId);
}

// ── 적용 ────────────────────────────────────────────────────────────────

// 저장된 초안을 **그대로** 명세·태스크 생성 경로에 넣는다(source='pm', tasks.plan_id).
// 같은 트랜잭션·같은 프로젝트 잠금 안에서 "ready인가, 같은 체인에서 이미 적용됐나"를 다시 본다 — 두 번 누르기·옛 초안 적용 방지.
// 초안 이후 상황이 바뀌어 검증에 걸리면(422) 전부 롤백되고 계획은 ready로 남는다 — 수정 요청으로 이어가면 된다.
// approved_at은 건드리지 않는다(G1 승인 = 잠김). 적용은 G1이 아니다.
// 기획 단계 질문(033)에 답 대기가 남았으면 409 QUESTIONS_PENDING(details에 질문들) — 답을 받아 다시 쓴 초안을 확정하게 한다.
// 대표가 acceptAssumptions로 확정하면 남은 질문을 만료(사유 confirmed_with_assumptions)로 닫고 적용한다 — 추천안(첫 선택지)을 가정한 셈이다.
export async function applyPlan(
  actorUserId: string,
  projectId: string,
  planId: string,
  options: { acceptAssumptions?: boolean } = {},
): Promise<PlanView> {
  return applyPlanWith(actorUserId, projectId, planId, { acceptAssumptions: options.acceptAssumptions === true });
}

// attribution(034): 실험 모드의 자동 적용 — applyPlanAsExperiment만 넘긴다(라우트는 넘기지 못한다).
async function applyPlanWith(
  actorUserId: string,
  projectId: string,
  planId: string,
  options: { acceptAssumptions: boolean; attribution?: Attribution },
): Promise<PlanView> {
  const by = options.attribution?.onBehalfOf ?? actorUserId;
  const auto = autoMark(options.attribution);
  const plan = await findPlan(pool, planId);
  if (!plan || plan.projectId !== projectId) throw new AppError('PLAN_NOT_FOUND', `plan ${planId} not found`);
  if (plan.status !== 'ready' || plan.draft === null) {
    throw new AppError('PLAN_NOT_APPLICABLE', `only a ready plan can be applied (this one is ${plan.status})`);
  }
  const draft = plan.draft;
  let requested: string[] = [];
  let assumed: string[] = [];

  const client = await pool.connect();
  try {
    const authoring = KINDS[plan.kind].toAuthoring(draft, { projectId, actorUserId, planId });
    await authorInTransaction(client, options.attribution ? { ...authoring, attribution: options.attribution } : authoring, {
      hooks: {
        beforeValidate: async (tx) => {
          if (options.attribution && (await findProjectForPm(tx, projectId))?.questionMode !== 'experiment') {
            throw new AppError('QUESTION_MODE_INVALID', 'automatic apply runs only in experiment mode');
          }
          const current = await findPlan(tx, planId, { forUpdate: true });
          if (!current || current.status !== 'ready') {
            throw new AppError('PLAN_NOT_APPLICABLE', `only a ready plan can be applied (this one is ${current?.status ?? 'gone'})`);
          }
          if (await chainHasAppliedPlan(tx, current.rootPlanId)) {
            throw new AppError('PLAN_NOT_APPLICABLE', 'another plan in this revision chain has already been applied');
          }
          const pending = await listPendingQuestionsOf(tx, { kind: 'plan', planId });
          if (pending.length > 0 && !options.acceptAssumptions) throw questionsPendingError(pending);
          if (pending.length > 0) {
            const project = (await findProjectForPm(tx, projectId))!;
            assumed = await closeQuestionsAsAssumed(
              tx,
              { orgId: project.orgId, projectId, policyHash: project.policyHash, onBehalfOf: by, ...auto },
              pending,
              { kind: 'plan', planId },
            );
          }
        },
        afterWrite: async (tx, result) => {
          await markPlanApplied(tx, planId);
          const project = (await findProjectForPm(tx, projectId))!;
          await appendEvent(tx, {
            orgId: project.orgId,
            projectId,
            type: 'PLAN_APPLIED',
            onBehalfOf: by,
            policyHash: project.policyHash,
            payload: {
              ...auto,
              planId,
              planKind: plan.kind,
              specIds: result.specs.map((s) => s.id),
              taskIds: result.taskIds.map((t) => t.id),
              ...(assumed.length > 0 ? { assumedQuestionIds: assumed } : {}),
            },
          });
          // 기능 명세 확정(새 흐름 1단계 → 2단계): API가 필요한 기능마다 BE가 쓸 계약 작성 대기를 같은 트랜잭션에 만든다.
          if (plan.kind === 'feature') {
            requested = await requestContractsInTx(tx, project, result.specs.filter((s) => s.needsApi).map((s) => s.id), by, options.attribution);
          }
        },
      },
    });
  } finally {
    client.release();
  }
  // 시작한 프로젝트에 계획을 추가로 적용하면 새 태스크가 바로 담당 에이전트에게 간다. 시작 전이면 아무것도 안 간다.
  tasksChanged(projectId);
  // 계약 작성 대기가 생겼으면 BE 노트북을 깨운다(커밋 뒤).
  if (requested.length > 0) contractsChanged(projectId);
  experimentNudge(projectId);
  return getPlan(actorUserId, projectId, planId);
}

// ── 백그라운드 실행 ──────────────────────────────────────────────────────

const running = new Set<Promise<void>>();

function schedule(planId: string): void {
  const job = runPlan(planId)
    .catch((err: unknown) => logger.error('pm plan job crashed', { planId, error: String(err) }))
    .finally(() => running.delete(job));
  running.add(job);
}

// 테스트가 백그라운드 작업이 끝나길 기다린다.
export async function drainPmJobs(): Promise<void> {
  while (running.size > 0) await Promise.all([...running]);
}

type CallOutcome =
  | { kind: 'response'; stopReason: string | null; text: string }
  | { kind: 'failed'; reason: PlanErrorReason; detail: unknown }
  | { kind: 'gone' }; // 계획이 더 이상 pending이 아니다(재시작 정리 등) — 조용히 멈춘다

async function recordCall(
  project: ProjectForPm,
  planId: string,
  call: {
    purpose: 'draft' | 'repair';
    attempts: AttemptUsage[];
    costUsd: number;
    latencyMs: number;
    stopReason: string | null;
    servedModel: string | null;
    interrupted: boolean;
  },
): Promise<void> {
  await withTransaction(async (tx) => {
    await appendEvent(tx, {
      orgId: project.orgId,
      projectId: project.id,
      type: 'PM_CALL',
      onBehalfOf: PM_ACTOR,
      policyHash: project.policyHash,
      tokenCost: call.costUsd,
      latencyMs: call.latencyMs,
      payload: {
        planId,
        purpose: call.purpose,
        requestedModel: env.PM_MODEL,
        servedModel: call.servedModel,
        provider: env.PM_PROVIDER,
        stopReason: call.stopReason,
        interrupted: call.interrupted,
        attempts: call.attempts,
      },
    });
    await setInflightMaxCost(tx, planId, null);
  });
}

async function callModel(
  model: PmModel,
  project: ProjectForPm,
  planId: string,
  purpose: 'draft' | 'repair',
  user: string,
  spec: KindSpec,
): Promise<CallOutcome> {
  const maxCost = maxCallCost(env.PM_MODEL, estimateInputTokens(spec.system, user, JSON.stringify(spec.schema)), env.PM_MAX_TOKENS);

  // 호출마다 예산을 본다(교정 호출 포함). 최대치를 계획 행에 적어 두어, 끊기면 그 값으로 정산한다.
  const reserved = await withTransaction(async (tx) => {
    const spent = await pmSpentUsd(tx, project.id);
    if (spent + maxCost > project.pmBudgetUsd) return 'over' as const;
    return (await setInflightMaxCost(tx, planId, maxCost)) ? ('ok' as const) : ('gone' as const);
  });
  if (reserved === 'gone') return { kind: 'gone' };
  if (reserved === 'over') {
    return { kind: 'failed', reason: 'budget', detail: { purpose, maxCostUsd: maxCost, budgetUsd: project.pmBudgetUsd } };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, env.PM_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await model.generate({
      model: env.PM_MODEL,
      effort: env.PM_EFFORT,
      maxTokens: env.PM_MAX_TOKENS,
      system: spec.system,
      user,
      jsonSchema: spec.schema,
      signal: controller.signal,
      context: { orgId: project.orgId, planId, purpose },
    });
    // 거절도 과금된다 — 무엇이든 기록한다.
    await recordCall(project, planId, {
      purpose,
      attempts: res.attempts,
      costUsd: costOfAttempts(res.attempts),
      latencyMs: Date.now() - started,
      stopReason: res.stopReason,
      servedModel: res.servedModel,
      interrupted: false,
    });
    return { kind: 'response', stopReason: res.stopReason, text: res.text };
  } catch (err) {
    // 요청이 서버에 닿기 전에 거부된 4xx(키·형식 오류)는 과금되지 않는다. 그 밖(시간 제한·연결 끊김·5xx)은
    // 그때까지 생성된 토큰이 과금됐을 수 있으므로 잡아 둔 최대치로 정산한다 — 예산 검사가 느슨해지지 않게.
    const rejectedUpfront = err instanceof Anthropic.APIError && typeof err.status === 'number' && err.status >= 400 && err.status < 500;
    // 중계: 아무도 가져가지 않았거나(모델이 돌지 않음) 노트북이 실패를 보고했으면(그 노트북의 구독으로 돌았다) 정산할 비용이 없다.
    // 최대치로 정산하면 노트북이 꺼져 있던 요청마다 예산이 $0.33씩 깎였다(실제로 그랬다).
    const relayNoCost = err instanceof RelayJobNotTaken || err instanceof RelayWorkerFailed;
    await recordCall(project, planId, {
      purpose,
      attempts: [],
      costUsd: rejectedUpfront || relayNoCost ? 0 : maxCost,
      latencyMs: Date.now() - started,
      stopReason: null,
      servedModel: null,
      interrupted: !rejectedUpfront && !relayNoCost,
    });
    if (timedOut) return { kind: 'failed', reason: 'timeout', detail: { timeoutMs: env.PM_TIMEOUT_MS } };
    return { kind: 'failed', reason: 'api_error', detail: { message: err instanceof Error ? err.message : String(err) } };
  } finally {
    clearTimeout(timer);
  }
}

// 응답 → 초안. stop_reason → JSON 해석 → 형식(zod) → 도메인 검증(dry-run) 순서.
type Judged =
  | { kind: 'ok'; draft: unknown }
  | { kind: 'fix'; problems: string[]; draft: unknown }
  | { kind: 'failed'; reason: PlanErrorReason; detail: unknown };

async function judge(
  outcome: { stopReason: string | null; text: string },
  ctx: { projectId: string; actorUserId: string; planId: string },
  spec: KindSpec,
  context: PlanContext,
): Promise<Judged> {
  if (outcome.stopReason === 'refusal') return { kind: 'failed', reason: 'refused', detail: null };
  // 출력 한도 부족이다 — 같은 한도로 교정하면 또 잘린다.
  if (outcome.stopReason === 'max_tokens') return { kind: 'failed', reason: 'truncated', detail: { maxTokens: env.PM_MAX_TOKENS } };

  let json: unknown;
  try {
    json = JSON.parse(outcome.text);
  } catch {
    return { kind: 'fix', problems: ['응답이 JSON이 아니다'], draft: null };
  }
  const parsed = spec.parse(json);
  if (!parsed.ok) return { kind: 'fix', problems: parsed.problems, draft: null };

  const own = spec.ownProblems(parsed.draft, context);
  if (own.length > 0) return { kind: 'fix', problems: own, draft: parsed.draft };

  const client = await pool.connect();
  try {
    await authorInTransaction(client, spec.toAuthoring(parsed.draft, ctx), { dryRun: true });
    return { kind: 'ok', draft: parsed.draft };
  } catch (err) {
    if (err instanceof AppError && err.code === 'PLAN_INVALID') {
      const problems = (err.details as { where: string; message: string }[]).map((p) => `${p.where} ${p.message}`);
      return { kind: 'fix', problems, draft: parsed.draft };
    }
    if (err instanceof AppError) return { kind: 'failed', reason: 'invalid', detail: { code: err.code, message: err.message } };
    throw err;
  } finally {
    client.release();
  }
}

async function finishFailed(project: ProjectForPm, planId: string, reason: PlanErrorReason, detail: unknown): Promise<void> {
  await withTransaction(async (tx) => {
    if (!(await markPlanFailed(tx, planId, reason, detail))) return; // 이미 정리됨 — 덮어쓰지 않는다
    await appendEvent(tx, {
      orgId: project.orgId,
      projectId: project.id,
      type: 'PM_PLAN_FAILED',
      onBehalfOf: PM_ACTOR,
      policyHash: project.policyHash,
      payload: { planId, reason },
    });
  });
  experimentNudge(project.id);
}

// 실험 모드의 재요청(retry, 034)은 실패한 판을 부모로 두지만 "같은 요청"이다 — 재요청 고리를 거슬러 원래 요청의 부모·원인·피드백으로 쓴다.
async function effectiveRequest(plan: PlanRow): Promise<{ parent: PlanRow | null; cause: PlanRow['revisionCause']; feedback: string | null }> {
  let current = plan;
  while (current.revisionCause === 'retry' && current.parentPlanId) {
    const failed = await findPlan(pool, current.parentPlanId);
    if (!failed) break;
    current = failed;
  }
  const parent = current.parentPlanId ? await findPlan(pool, current.parentPlanId) : null;
  return { parent, cause: current.revisionCause, feedback: current.feedback };
}

async function runPlan(planId: string): Promise<void> {
  const plan = await findPlan(pool, planId);
  if (!plan || plan.status !== 'pending') return;
  const project = (await findProjectForPm(pool, plan.projectId))!;
  const model = getPmModel();
  if (!model) return finishFailed(project, planId, 'api_error', { message: 'PM model is not configured' });

  const { parent, cause, feedback } = await effectiveRequest(plan);
  const context = await loadPlanContext(pool, project);
  const ctx = { projectId: project.id, actorUserId: plan.requestedBy, planId };
  const instruction = plan.instruction ?? '';

  const spec = KINDS[plan.kind];
  // 질문의 답으로 다시 쓰는 계획(033)은 feedback 칸에 답을 담아 둔다 — 프롬프트에서는 "받은 답"으로 보인다.
  const previous: Previous | undefined = parent?.draft
    ? cause === 'answers'
      ? { draft: parent.draft, answers: feedback ?? '' }
      : { draft: parent.draft, feedback: feedback ?? '' }
    : undefined;
  const firstPrompt = spec.buildUser(context, instruction, previous);

  let repaired = false;
  let outcome = await callModel(model, project, planId, 'draft', firstPrompt, spec);
  for (;;) {
    if (outcome.kind === 'gone') return;
    if (outcome.kind === 'failed') return finishFailed(project, planId, outcome.reason, outcome.detail);

    const judged = await judge(outcome, ctx, spec, context);
    if (judged.kind === 'failed') return finishFailed(project, planId, judged.reason, judged.detail);
    if (judged.kind === 'ok') {
      // 기능 명세 초안의 질문(033) — 상한을 넘는 것은 가정으로 옮기고, 남은 것은 트랜잭션 밖에서 라우팅해 초안과 같은 트랜잭션에 넣는다.
      const questioned = plan.kind === 'feature' ? await prepareFeatureQuestions(project, plan, judged.draft as FeatureDraft) : null;
      const finalDraft = questioned?.draft ?? judged.draft;
      const shaped = spec.shape(finalDraft);
      const dagHash = shaped.hash;
      const created = await withTransaction(async (tx) => {
        if (!(await markPlanReady(tx, planId, finalDraft, shaped.structure, dagHash, shaped.mode))) return null;
        const questions = questioned
          ? await insertPlanningQuestionsInTx(
              tx,
              {
                orgId: project.orgId,
                projectId: project.id,
                policyHash: project.policyHash,
                stage: 'feature_spec',
                planId,
                contractId: null,
                askerRole: 'PM',
                askedByAgentId: null,
                onBehalfOf: PM_ACTOR,
              },
              questioned.routed,
            )
          : [];
        await appendEvent(tx, {
          orgId: project.orgId,
          projectId: project.id,
          type: 'PM_PLAN_DRAFTED',
          onBehalfOf: PM_ACTOR,
          policyHash: project.policyHash,
          payload: {
            planId,
            planKind: plan.kind,
            dagHash,
            specCount: shaped.specCount,
            taskCount: shaped.taskCount,
            repaired,
            ...(questioned
              ? { questionCount: questions.length, assumedQuestionCount: questioned.overflow, ...(questioned.repeated > 0 ? { repeatedQuestionCount: questioned.repeated } : {}) }
              : {}),
          },
        });
        return questions;
      });
      if (questioned && created) planningQuestionsCommitted(created, questioned.routed, project);
      experimentNudge(project.id);
      return;
    }
    // 교정은 한 번만. 무한 재시도는 비용과 비결정성만 늘린다.
    if (repaired) return finishFailed(project, planId, 'invalid', { problems: judged.problems });
    repaired = true;
    const repairPrompt = spec.buildUser(context, instruction, judged.draft ? { draft: judged.draft, problems: judged.problems } : undefined);
    const withProblems = judged.draft ? repairPrompt : `${repairPrompt}\n\n## 이전 응답의 문제 — 고쳐서 다시 내라\n${judged.problems.map((p) => `- ${p}`).join('\n')}`;
    outcome = await callModel(model, project, planId, 'repair', withProblems, spec);
  }
}

// ── 재시작 정리(server 모드에서만 부른다 — migrate 단계에서는 옛 서버가 아직 작업 중일 수 있다) ──

// 프로세스가 죽으면 진행 중이던 pending이 영원히 남는다. 끊긴 호출은 잡아 둔 최대치로 정산하고 failed(restart)로 닫는다.
export async function recoverInterruptedPlans(): Promise<number> {
  const pending = await listAllPendingPlans(pool);
  for (const plan of pending) {
    const project = await findProjectForPm(pool, plan.projectId);
    if (!project) continue;
    await withTransaction(async (tx) => {
      const current = await findPlan(tx, plan.id, { forUpdate: true });
      if (!current || current.status !== 'pending') return;
      if (current.inflightMaxCostUsd !== null) {
        await appendEvent(tx, {
          orgId: project.orgId,
          projectId: project.id,
          type: 'PM_CALL',
          onBehalfOf: PM_ACTOR,
          policyHash: project.policyHash,
          tokenCost: Number(current.inflightMaxCostUsd),
          payload: {
            planId: plan.id,
            purpose: 'draft',
            requestedModel: env.PM_MODEL,
            servedModel: null,
            stopReason: null,
            interrupted: true,
            attempts: [],
          },
        });
      }
      await markPlanFailed(tx, plan.id, 'restart', null);
      await appendEvent(tx, {
        orgId: project.orgId,
        projectId: project.id,
        type: 'PM_PLAN_FAILED',
        onBehalfOf: PM_ACTOR,
        policyHash: project.policyHash,
        payload: { planId: plan.id, reason: 'restart' },
      });
    });
  }
  if (pending.length > 0) logger.warn('closed PM plans interrupted by a restart', { count: pending.length });
  return pending.length;
}

// ── 중계 모드: 대표 노트북의 pm-worker ─────────────────────────────────────

// 작업을 가져가는 에이전트는 그 조직 **대표 본인의** 에이전트여야 한다. 작업에는 프로젝트 맥락(지시·레포·태스크)이 들어 있고,
// 그 결과가 곧 계획 초안이 된다 — 팀원의 노트북이 대표 대신 PM을 돌리게 하지 않는다.
// 에이전트 행은 인증 미들웨어가 방금 DB에서 읽은 것(AuthAgent)을 받는다.
type RelayAgent = { id: string; onBehalfOf: string; orgId: string | null };

async function assertRepresentativeAgent(agent: RelayAgent): Promise<{ orgId: string }> {
  if (env.PM_PROVIDER !== 'relay') {
    throw new AppError('PM_RELAY_DISABLED', 'this server calls the model API directly (PM_PROVIDER=api); no pm-worker is needed');
  }
  const owner = await findUserById(pool, agent.onBehalfOf);
  if (!agent.orgId || !owner || owner.orgId !== agent.orgId || owner.orgRole !== 'REPRESENTATIVE') {
    throw new AppError('NOT_REPRESENTATIVE', "only the organization representative's agent can run the PM");
  }
  return { orgId: agent.orgId };
}

export async function takeRelayJob(agent: RelayAgent): Promise<RelayJob | null> {
  const { orgId } = await assertRepresentativeAgent(agent);
  return takeNextJob(orgId, agent.id);
}

export async function submitRelayResult(agent: RelayAgent, jobId: string, result: RelayResult): Promise<void> {
  await assertRepresentativeAgent(agent);
  completeJob(jobId, agent.id, result);
}

export async function failRelayJob(agent: RelayAgent, jobId: string, message: string): Promise<void> {
  await assertRepresentativeAgent(agent);
  failJob(jobId, agent.id, message);
}

// ── 기능 명세 초안의 질문(033) ────────────────────────────────────────────

// 일반 모드 상한: 초안 하나당 PLANNING_QUESTIONS_MAX개, 답에 따른 재작성 PLANNING_QUESTION_ROUNDS회 — 넘는 질문은 가정(assumptions)으로 옮긴다.
// 실험 모드는 무제한이다(상한은 PM 예산). 남은 질문은 라우팅까지 마친다(트랜잭션 밖 — 라우터가 LLM이면 수 초).
async function prepareFeatureQuestions(
  project: ProjectForPm,
  plan: PlanRow,
  draft: FeatureDraft,
): Promise<{ draft: FeatureDraft; routed: RoutedPlanningQuestion[]; overflow: number; repeated: number }> {
  const roundsUsed = await countChainAnswerRounds(pool, plan.rootPlanId);
  // 실험 모드: 체인에서 이미 답이 정해진 질문을 다시 물으면 거른다(이미 받은 답을 가정으로 남긴다 — planning.ts의 splitRepeated).
  const { fresh, repeated } =
    project.questionMode === 'experiment'
      ? splitRepeated(draft.questions, answeredTexts(await listQuestionsOfPlanChain(pool, plan.rootPlanId)))
      : { fresh: draft.questions, repeated: [] };
  const { kept, overflow } = limitPlanningQuestions(fresh, { mode: project.questionMode, roundsUsed });
  const finalDraft: FeatureDraft = {
    ...draft,
    questions: kept,
    assumptions: [...draft.assumptions, ...repeated.map(repeatedAssumption), ...overflow.map(assumptionOf)],
  };
  const routed = await routePlanningQuestions(
    kept.map((q) => {
      // 어느 기능에 대한 질문인지 — 표시가 없고 기능이 하나뿐이면 그 기능으로 본다.
      const feature = draft.features.find((f) => f.featureKey === q.featureKey) ?? (draft.features.length === 1 ? draft.features[0] : undefined);
      const asked = toAskedQuestion(q);
      const input: RoutingInput = {
        stage: 'feature_spec',
        askerRole: 'PM',
        roles: [...TEAM_ROLES],
        task: null,
        spec: feature ? { featureKey: feature.featureKey, title: feature.title, content: featureContent(feature) } : null,
        repo: null,
        questions: [asked],
        contract: null,
        context: { orgId: project.orgId },
      };
      return { question: asked, input };
    }),
  );
  return { draft: finalDraft, routed, overflow: overflow.length, repeated: repeated.length };
}

// 질문이 전부 답해지면(033) 답을 붙여 **새 단발 호출**로 초안을 다시 쓴다 — 대표의 수정 요청과 같은 체인·같은 경로(cause answers).
// 다시 쓴 초안에서 또 질문이 나오면 같은 흐름이 반복된다(일반 모드는 PLANNING_QUESTION_ROUNDS회까지).
// 다시 쓸 수 없으면(이미 다른 초안을 쓰는 중·예산 초과) 로그만 남긴다 — 답은 저장됐고, 대표가 수정 요청으로 이어 간다.

async function answersSettled(db: Queryable, planId: string): Promise<boolean> {
  const plan = await findPlan(db, planId);
  if (!plan || plan.status !== 'ready' || plan.draft === null) return false;
  if ((await listPendingQuestionsOf(db, { kind: 'plan', planId })).length > 0) return false;
  return !(await hasChildPlan(db, planId));
}

async function rewriteWithAnswers(planId: string): Promise<void> {
  if (!(await answersSettled(pool, planId))) return; // 빠른 확인 — 잠금 안에서 한 번 더 본다(openRequest)
  const plan = (await findPlan(pool, planId))!;
  const project = (await findProjectForPm(pool, plan.projectId))!;
  // 실험 모드는 체인 전체의 답을 넣는다 — 되풀이한 질문을 거르는 대신 이미 받은 답을 그대로 다음 입력에 싣는다(splitRepeated).
  const questions =
    project.questionMode === 'experiment' ? await listQuestionsOfPlanChain(pool, plan.rootPlanId) : await listQuestionsOf(pool, { kind: 'plan', planId });
  const answers = answersBlock(questions);
  if (!answers) return;
  try {
    await openRequest(plan.requestedBy, plan.projectId, { kind: plan.kind, instruction: plan.instruction ?? '', feedback: answers, parent: plan, cause: 'answers' });
  } catch (err) {
    if (err instanceof AutoRequestNotNeeded) return;
    logger.warn('질문의 답으로 기능 명세 초안을 다시 쓰지 못했다 — 대표가 수정 요청으로 이어 간다', { planId, error: String(err) });
  }
}

onPlanningQuestionsSettled(async (_projectId, subject) => {
  if (subject.kind === 'plan') await rewriteWithAnswers(subject.planId);
});

// ── 실험 모드 자동 경로(034, domain/experiment가 부른다) ─────────────────────────
// 판정·검증은 위의 사람 경로와 한 벌이다 — 명의만 system:experiment(auto: true), 권한 확인은 조직 대표로 한다(실험을 켠 사람).
// 각 함수는 실험 모드 프로젝트가 아니면 잠금 안에서 거부한다(좁은 입구).

export async function applyPlanAsExperiment(representativeUserId: string, projectId: string, planId: string): Promise<void> {
  await applyPlanWith(representativeUserId, projectId, planId, { acceptAssumptions: true, attribution: EXPERIMENT_ATTRIBUTION });
}

// 실패한 초안을 같은 요청으로 다시 낸다(새 체인이 아니다 — 같은 지시·같은 답, revision_cause retry). 이미 다시 냈으면 아무것도 하지 않는다.
export async function retryPlanAsExperiment(representativeUserId: string, projectId: string, failedPlanId: string): Promise<boolean> {
  const failed = await findPlan(pool, failedPlanId);
  if (!failed || failed.projectId !== projectId || failed.status !== 'failed') return false;
  try {
    await openRequest(representativeUserId, projectId, {
      kind: failed.kind,
      instruction: failed.instruction ?? '',
      feedback: failed.feedback,
      parent: failed,
      cause: 'retry',
      attribution: EXPERIMENT_ATTRIBUTION,
    });
    return true;
  } catch (err) {
    if (err instanceof AutoRequestNotNeeded) return false;
    throw err;
  }
}

// 태스크 나누기 자동 요청 — POST /pm/plans와 같은 경로, 지시 없음.
export async function requestTaskSplitAsExperiment(representativeUserId: string, projectId: string): Promise<void> {
  await openRequest(representativeUserId, projectId, {
    kind: 'tasks',
    instruction: '',
    feedback: null,
    parent: null,
    cause: 'experiment_split',
    attribution: EXPERIMENT_ATTRIBUTION,
  });
}

// 답이 다 왔는데 다시 쓰지 못한 초안(그때 다른 초안이 작성 중이었다 — 프로젝트당 하나) — 감독이 다시 시도한다.
export async function retryRewriteWithAnswers(planId: string): Promise<void> {
  await rewriteWithAnswers(planId);
}
