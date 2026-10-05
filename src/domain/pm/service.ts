import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../errors.js';
import { authorInTransaction } from '../authoring/apply.js';
import { findActor, lockProjectForAuthoring } from '../authoring/repository.js';
import { tasksChanged } from '../dispatch/tasks-changed.js';
import { appendEvent } from '../events/append.js';
import { dagHashOf, draftToAuthoring, PLAN_DRAFT_JSON_SCHEMA, planDraftSchema, planStructure, type PlanDraft } from './draft.js';
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
import { buildUserPrompt, PM_SYSTEM_PROMPT } from './prompt.js';
import {
  chainHasAppliedPlan,
  countChainRevisions,
  findPendingPlan,
  findPlan,
  findProjectForPm,
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
  pmSpentUsd,
  setInflightMaxCost,
  type PlanErrorReason,
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

// ── 요청 ────────────────────────────────────────────────────────────────

export type PlanView = {
  id: string;
  projectId: string;
  status: PlanRow['status'];
  instruction: string | null;
  feedback: string | null;
  parentPlanId: string | null;
  mode: string | null;
  draft: PlanDraft | null;
  error: { reason: PlanErrorReason; detail: unknown } | null;
  costUsd: number;
  createdAt: string;
  appliedAt: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
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

function toView(plan: PlanRow, costUsd: number, assignees: Map<string, RoleAssignee>): PlanView {
  return {
    id: plan.id,
    projectId: plan.projectId,
    status: plan.status,
    instruction: plan.instruction,
    feedback: plan.feedback,
    parentPlanId: plan.parentPlanId,
    mode: plan.mode,
    draft: plan.draft,
    error: plan.errorReason === null ? null : { reason: plan.errorReason, detail: plan.errorDetail ?? null },
    costUsd,
    createdAt: plan.createdAt,
    appliedAt: plan.appliedAt,
    rejectedAt: plan.rejectedAt,
    rejectReason: plan.rejectReason,
    assignments: assignmentsOf(plan.draft, assignees),
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
async function nextCallMaxCost(tx: PoolClient, project: ProjectForPm, instruction: string, previous?: PlanDraft) {
  const context = await loadPlanContext(tx, project);
  const user = buildUserPrompt({ context, instruction, ...(previous ? { previous: { draft: previous, feedback: '' } } : {}) });
  return maxCallCost(env.PM_MODEL, estimateInputTokens(PM_SYSTEM_PROMPT, user, JSON.stringify(PLAN_DRAFT_JSON_SCHEMA)), env.PM_MAX_TOKENS);
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

async function openRequest(
  actorUserId: string,
  projectId: string,
  input: { instruction: string; feedback: string | null; parent: PlanRow | null },
): Promise<PlanView> {
  requireModel();
  const plan = await withTransaction(async (tx) => {
    // 같은 프로젝트의 요청을 한 줄로 세운다 — "진행 중 요청은 하나" 확인과 INSERT 사이에 끼지 못하게(authoring과 같은 잠금).
    const locked = await lockProjectForAuthoring(tx, projectId);
    if (!locked) throw new AppError('PROJECT_NOT_FOUND', `project ${projectId} not found`);
    await assertRepresentativeOf(tx, actorUserId, locked);
    if (!OPEN_STATUSES.has(locked.status)) {
      throw new AppError('PROJECT_NOT_OPEN', `project is ${locked.status}; the PM plans only while planning or active`);
    }
    if (await findPendingPlan(tx, projectId)) {
      throw new AppError('PM_PLAN_IN_PROGRESS', 'a PM plan is already being drafted for this project; wait for it to finish');
    }
    // 수정 요청 한도 — 같은 잠금 안에서 센다(동시에 두 번 눌러 한도를 넘지 못하게). 새 계획 요청(새 체인)은 0부터다.
    if (input.parent) {
      const used = await countChainRevisions(tx, input.parent.rootPlanId);
      if (used >= env.PM_MAX_REVISIONS) {
        throw new AppError(
          'PLAN_REVISION_LIMIT',
          `this plan has already been revised ${used} time(s) (limit ${env.PM_MAX_REVISIONS}); start a new plan request instead`,
          { limit: env.PM_MAX_REVISIONS, used },
        );
      }
    }
    const project = (await findProjectForPm(tx, projectId))!;
    await assertWithinBudget(tx, project, await nextCallMaxCost(tx, project, input.instruction, input.parent?.draft ?? undefined));

    const id = randomUUID();
    const created = await insertPendingPlan(tx, {
      id,
      projectId,
      requestedBy: actorUserId,
      instruction: input.instruction,
      feedback: input.feedback,
      parentPlanId: input.parent?.id ?? null,
      rootPlanId: input.parent?.rootPlanId ?? id,
    });
    await appendEvent(tx, {
      orgId: project.orgId,
      projectId,
      type: 'PM_PLAN_REQUESTED',
      onBehalfOf: actorUserId,
      policyHash: project.policyHash,
      payload: { planId: id, parentPlanId: input.parent?.id ?? null, kind: input.parent ? 'revise' : 'draft' },
    });
    return created;
  });
  schedule(plan.id);
  return toView(plan, 0, new Map()); // pending — 초안이 없어 담당도 없다
}

export async function requestPlan(actorUserId: string, projectId: string, instruction: string): Promise<PlanView> {
  return openRequest(actorUserId, projectId, { instruction, feedback: null, parent: null });
}

// 수정 요청. 이전 초안 + 피드백을 넣은 **새 단발 호출**이다 — 대화를 이어 붙이지 않으므로 거절된 턴이 섞일 일이 없다.
export async function revisePlan(actorUserId: string, projectId: string, planId: string, feedback: string): Promise<PlanView> {
  const parent = await findPlan(pool, planId);
  if (!parent || parent.projectId !== projectId) throw new AppError('PLAN_NOT_FOUND', `plan ${planId} not found`);
  if (parent.status !== 'ready' || parent.draft === null) {
    throw new AppError('PLAN_NOT_APPLICABLE', `only a ready plan can be revised (this one is ${parent.status})`);
  }
  return openRequest(actorUserId, projectId, { instruction: parent.instruction ?? '', feedback, parent });
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
  const costs = await planCostsUsd(pool, [plan.id]);
  return toView(plan, costs.get(plan.id) ?? 0, await listRoleAssignees(pool, projectId));
}

export async function listProjectPlans(actorUserId: string, projectId: string): Promise<PlanView[]> {
  await assertCanView(actorUserId, projectId);
  const plans = await listPlans(pool, projectId);
  const costs = await planCostsUsd(pool, plans.map((p) => p.id));
  const assignees = await listRoleAssignees(pool, projectId);
  return plans.map((p) => toView(p, costs.get(p.id) ?? 0, assignees));
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
export async function applyPlan(actorUserId: string, projectId: string, planId: string): Promise<PlanView> {
  const plan = await findPlan(pool, planId);
  if (!plan || plan.projectId !== projectId) throw new AppError('PLAN_NOT_FOUND', `plan ${planId} not found`);
  if (plan.status !== 'ready' || plan.draft === null) {
    throw new AppError('PLAN_NOT_APPLICABLE', `only a ready plan can be applied (this one is ${plan.status})`);
  }
  const draft = plan.draft;

  const client = await pool.connect();
  try {
    await authorInTransaction(client, draftToAuthoring(draft, { projectId, actorUserId, planId }), {
      hooks: {
        beforeValidate: async (tx) => {
          const current = await findPlan(tx, planId, { forUpdate: true });
          if (!current || current.status !== 'ready') {
            throw new AppError('PLAN_NOT_APPLICABLE', `only a ready plan can be applied (this one is ${current?.status ?? 'gone'})`);
          }
          if (await chainHasAppliedPlan(tx, current.rootPlanId)) {
            throw new AppError('PLAN_NOT_APPLICABLE', 'another plan in this revision chain has already been applied');
          }
        },
        afterWrite: async (tx, result) => {
          await markPlanApplied(tx, planId);
          const project = (await findProjectForPm(tx, projectId))!;
          await appendEvent(tx, {
            orgId: project.orgId,
            projectId,
            type: 'PLAN_APPLIED',
            onBehalfOf: actorUserId,
            policyHash: project.policyHash,
            payload: { planId, specIds: result.specs.map((s) => s.id), taskIds: result.taskIds.map((t) => t.id) },
          });
        },
      },
    });
  } finally {
    client.release();
  }
  // 시작한 프로젝트에 계획을 추가로 적용하면 새 태스크가 바로 담당 에이전트에게 간다. 시작 전이면 아무것도 안 간다.
  tasksChanged(projectId);
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
): Promise<CallOutcome> {
  const maxCost = maxCallCost(env.PM_MODEL, estimateInputTokens(PM_SYSTEM_PROMPT, user, JSON.stringify(PLAN_DRAFT_JSON_SCHEMA)), env.PM_MAX_TOKENS);

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
      system: PM_SYSTEM_PROMPT,
      user,
      jsonSchema: PLAN_DRAFT_JSON_SCHEMA,
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
  | { kind: 'ok'; draft: PlanDraft }
  | { kind: 'fix'; problems: string[]; draft: PlanDraft | null }
  | { kind: 'failed'; reason: PlanErrorReason; detail: unknown };

async function judge(
  outcome: { stopReason: string | null; text: string },
  ctx: { projectId: string; actorUserId: string; planId: string },
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
  const parsed = planDraftSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: 'fix', problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), draft: null };
  }

  const client = await pool.connect();
  try {
    await authorInTransaction(client, draftToAuthoring(parsed.data, ctx), { dryRun: true });
    return { kind: 'ok', draft: parsed.data };
  } catch (err) {
    if (err instanceof AppError && err.code === 'PLAN_INVALID') {
      const problems = (err.details as { where: string; message: string }[]).map((p) => `${p.where} ${p.message}`);
      return { kind: 'fix', problems, draft: parsed.data };
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
}

async function runPlan(planId: string): Promise<void> {
  const plan = await findPlan(pool, planId);
  if (!plan || plan.status !== 'pending') return;
  const project = (await findProjectForPm(pool, plan.projectId))!;
  const model = getPmModel();
  if (!model) return finishFailed(project, planId, 'api_error', { message: 'PM model is not configured' });

  const parent = plan.parentPlanId ? await findPlan(pool, plan.parentPlanId) : null;
  const context = await loadPlanContext(pool, project);
  const ctx = { projectId: project.id, actorUserId: plan.requestedBy, planId };
  const instruction = plan.instruction ?? '';

  const firstPrompt = buildUserPrompt({
    context,
    instruction,
    ...(parent?.draft ? { previous: { draft: parent.draft, feedback: plan.feedback ?? '' } } : {}),
  });

  let repaired = false;
  let outcome = await callModel(model, project, planId, 'draft', firstPrompt);
  for (;;) {
    if (outcome.kind === 'gone') return;
    if (outcome.kind === 'failed') return finishFailed(project, planId, outcome.reason, outcome.detail);

    const judged = await judge(outcome, ctx);
    if (judged.kind === 'failed') return finishFailed(project, planId, judged.reason, judged.detail);
    if (judged.kind === 'ok') {
      const structure = planStructure(judged.draft);
      const dagHash = dagHashOf(structure);
      await withTransaction(async (tx) => {
        if (!(await markPlanReady(tx, planId, judged.draft, structure, dagHash))) return;
        await appendEvent(tx, {
          orgId: project.orgId,
          projectId: project.id,
          type: 'PM_PLAN_DRAFTED',
          onBehalfOf: PM_ACTOR,
          policyHash: project.policyHash,
          payload: { planId, dagHash, specCount: judged.draft.specs.length, taskCount: judged.draft.tasks.length, repaired },
        });
      });
      return;
    }
    // 교정은 한 번만. 무한 재시도는 비용과 비결정성만 늘린다.
    if (repaired) return finishFailed(project, planId, 'invalid', { problems: judged.problems });
    repaired = true;
    const repairPrompt = buildUserPrompt({
      context,
      instruction,
      ...(judged.draft ? { previous: { draft: judged.draft, problems: judged.problems } } : {}),
    });
    const withProblems = judged.draft ? repairPrompt : `${repairPrompt}\n\n## 이전 응답의 문제 — 고쳐서 다시 내라\n${judged.problems.map((p) => `- ${p}`).join('\n')}`;
    outcome = await callModel(model, project, planId, 'repair', withProblems);
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
