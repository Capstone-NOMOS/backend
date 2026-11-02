import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../../config/db.js';
import { AppError } from '../../errors.js';
import { logger } from '../../config/logger.js';
import { contractsChanged } from '../dispatch/contracts-changed.js';
import { onPlanningQuestionsSettled } from '../dispatch/planning-questions.js';
import { findProjectById } from '../project/repository.js';
import {
  answersBlock,
  assumptionOf,
  closeQuestionsAsAssumed,
  insertPlanningQuestionsInTx,
  limitPlanningQuestions,
  planningQuestionProblems,
  planningQuestionsCommitted,
  questionsPendingError,
  routePlanningQuestions,
  toAskedQuestion,
  type PlanningQuestion,
} from '../question/planning.js';
import { listPendingQuestionsOf, listQuestionsOf, type AskedQuestion } from '../question/repository.js';
import type { RoutingInput } from '../question/router.js';
import { TEAM_ROLES } from '../roles.js';
import { findSpecForTask } from '../task/repository.js';
import { appendEvent } from '../events/append.js';
import { findAgentMembership } from '../policy/repository.js';
import { assertProjectVisibleToUser, type UserContext } from '../project/visibility.js';
import type { AgentContext } from '../task/service.js';
import {
  findBackendOwner,
  findContract,
  insertPendingContracts,
  listApprovedContracts,
  listBackendRepos,
  listContracts,
  listPendingContractJobs,
  markContractApproved,
  markContractDrafted,
  markContractFailed,
  requestContractRedraft,
  requestContractRedraftByAnswers,
  type ContractJob,
  type ContractView,
} from './repository.js';
import { checkContractYaml } from './validate.js';

// API 계약(023, 새 계획 흐름 2단계).
//
// 대표는 개발 지식이 없어 API 계약을 판단할 수 없다 — 계약은 그 소관인 BE가 정한다.
//   기능 명세 확정(API가 필요한 기능) → 작성 대기 → BE 노트북의 에이전트가 BE 코드를 읽고 초안(OpenAPI 조각 + 요약)
//   → BE 개발자가 확정하거나 수정 요청(최대 CONTRACT_MAX_REVISIONS회) → 확정된 계약은 FE·BE 태스크 브리핑에 들어간다.
// FE 확인 단계는 두지 않는다(대표 결정) — 화면에 더 필요한 것은 실행 중 AskUserQuestion으로 BE에게 묻는다(질문 중계).
// 형식 검사는 코드가 한다(P2, validate.ts). 계약 내용이 좋은지는 BE 개발자가 본다.

export const CONTRACT_MAX_REVISIONS = 3;

// 기능 명세를 확정한 트랜잭션 안에서 부른다(pm/service의 적용). API가 필요한 명세마다 작성 대기 계약을 만든다.
// 커밋 뒤 contractsChanged를 부르는 건 호출부 몫이다.
export async function requestContractsInTx(
  tx: PoolClient,
  project: { id: string; orgId: string; policyHash: string },
  specIds: string[],
  onBehalfOf: string,
): Promise<string[]> {
  const contractIds = await insertPendingContracts(tx, project.id, specIds);
  if (contractIds.length > 0) {
    await appendEvent(tx, {
      orgId: project.orgId,
      projectId: project.id,
      type: 'CONTRACT_REQUESTED',
      onBehalfOf,
      policyHash: project.policyHash,
      payload: { contractIds, specIds },
    });
  }
  return contractIds;
}

// ── 사람 ─────────────────────────────────────────────────────────────────

export async function listProjectContracts(actor: UserContext, projectId: string): Promise<ContractView[]> {
  await withTransaction((tx) => assertProjectVisibleToUser(tx, actor, projectId));
  return listContracts(pool, projectId);
}

// 에이전트(MCP read_contracts) — 자기 프로젝트의 확정한 계약만. 초안은 바뀔 수 있어 주지 않는다(브리핑의 잠긴 시험지와 같은 규칙).
export async function listAgentContracts(ctx: AgentContext, projectId: string): Promise<ContractView[]> {
  if (ctx.projectId !== projectId) throw new AppError('NOT_PROJECT_MEMBER', 'agent is not a member of this project');
  return (await listContracts(pool, projectId)).filter((c) => c.status === 'approved');
}

// 확정·수정 요청할 수 있는 사람: 이 프로젝트의 BE 담당(에이전트 주인). BE 담당이 없을 때만 대표가 대신한다(대표 결정).
// 받은 편지함의 "확정 대기 계약"도 이 판정을 쓴다 — 정의를 두 벌 두지 않는다.
export function contractApproverRole(backendOwner: string | null, actor: { userId: string; orgRole: string }): 'owner' | 'representative' | null {
  if (backendOwner !== null && backendOwner === actor.userId) return 'owner';
  if (backendOwner === null && actor.orgRole === 'REPRESENTATIVE') return 'representative';
  return null;
}

async function assertApprover(tx: PoolClient, actor: UserContext, contract: ContractView): Promise<{ byRepresentative: boolean }> {
  await assertProjectVisibleToUser(tx, actor, contract.projectId);
  const owner = await findBackendOwner(tx, contract.projectId);
  const role = contractApproverRole(owner, actor);
  if (role !== null) return { byRepresentative: role === 'representative' };
  throw new AppError(
    'NOT_CONTRACT_APPROVER',
    owner === null ? 'no BACKEND member is assigned; the representative confirms instead' : 'only the BACKEND member of this project can confirm the API contract',
  );
}

async function loadForDecision(tx: PoolClient, contractId: string): Promise<ContractView> {
  const contract = await findContract(tx, contractId, { forUpdate: true });
  if (!contract) throw new AppError('CONTRACT_NOT_FOUND', `contract ${contractId} not found`);
  return contract;
}

// 기획 단계 질문(033)에 답 대기가 남았으면 409 QUESTIONS_PENDING — 답이 오면 그 답으로 다음 회차가 저절로 열린다.
// acceptAssumptions면 남은 질문을 가정(추천안)으로 닫고 확정한다.
export async function approveContract(actor: UserContext, contractId: string, options: { acceptAssumptions?: boolean } = {}): Promise<ContractView> {
  return withTransaction(async (tx) => {
    const contract = await loadForDecision(tx, contractId);
    const { byRepresentative } = await assertApprover(tx, actor, contract);
    const pending = await listPendingQuestionsOf(tx, { kind: 'contract', contractId });
    if (pending.length > 0 && !options.acceptAssumptions) throw questionsPendingError(pending);
    let assumed: string[] = [];
    if (pending.length > 0) {
      const project = (await findProjectById(tx, contract.projectId))!;
      assumed = await closeQuestionsAsAssumed(
        tx,
        { orgId: actor.orgId, projectId: contract.projectId, policyHash: project.policyHash, onBehalfOf: actor.userId },
        pending,
        { kind: 'contract', contractId },
      );
    }
    if (!(await markContractApproved(tx, contractId, actor.userId))) {
      throw new AppError('CONTRACT_NOT_DRAFT', `only a draft contract can be confirmed (this one is ${contract.status})`);
    }
    await appendEvent(tx, {
      orgId: actor.orgId,
      projectId: contract.projectId,
      type: 'CONTRACT_APPROVED',
      onBehalfOf: actor.userId,
      payload: { contractId, featureKey: contract.featureKey, attempt: contract.attempt, byRepresentative, ...(assumed.length > 0 ? { assumedQuestionIds: assumed } : {}) },
    });
    return (await findContract(tx, contractId))!;
  });
}

// 수정 요청 — 초안이나 실패에서 다음 회차로 다시 쓰게 한다. 피드백은 선택(실패를 그대로 다시 시도할 때는 없어도 된다).
export async function reviseContract(actor: UserContext, contractId: string, feedback: string | null): Promise<ContractView> {
  const result = await withTransaction(async (tx) => {
    const contract = await loadForDecision(tx, contractId);
    await assertApprover(tx, actor, contract);
    // 질문의 답으로 연 회차(033)는 BE 담당의 수정 요청이 아니다 — 한도에서 뺀다.
    const used = contract.attempt - 1 - contract.questionRounds;
    if (used >= CONTRACT_MAX_REVISIONS) {
      throw new AppError('CONTRACT_REVISION_LIMIT', `this contract has already been redrafted ${used} time(s) (limit ${CONTRACT_MAX_REVISIONS})`, {
        limit: CONTRACT_MAX_REVISIONS,
        used,
      });
    }
    if (!(await requestContractRedraft(tx, contractId, feedback))) {
      throw new AppError('CONTRACT_NOT_DRAFT', `only a draft or failed contract can be redrafted (this one is ${contract.status})`);
    }
    await appendEvent(tx, {
      orgId: actor.orgId,
      projectId: contract.projectId,
      type: 'CONTRACT_REVISION_REQUESTED',
      onBehalfOf: actor.userId,
      payload: { contractId, featureKey: contract.featureKey, attempt: contract.attempt + 1, feedback },
    });
    return (await findContract(tx, contractId))!;
  });
  contractsChanged(result.projectId);
  return result;
}

// ── BE 노트북(에이전트) ──────────────────────────────────────────────────

// answers(033): 이 계약의 기획 단계 질문에 받은 답 — 다음 회차 프롬프트에 넣는다(CLI 0.1.18).
export type ContractJobView = ContractJob & {
  previous: { schemaYaml: string; summary: string } | null;
  answers: { question: string; answer: string }[];
};

// 이 에이전트가 쓸 계약 작업 — BACKEND 역할만. 앞서 확정한 계약도 함께 준다(경로·형식을 맞추게).
export async function listContractJobs(ctx: AgentContext): Promise<{
  contracts: ContractJobView[];
  approved: { featureKey: string; title: string; schemaYaml: string }[];
  repos: Awaited<ReturnType<typeof listBackendRepos>>;
}> {
  const membership = await findAgentMembership(pool, ctx.agentId);
  if (!membership || membership.projectId !== ctx.projectId) throw new AppError('NOT_PROJECT_MEMBER', 'agent is not a member of this project');
  if (membership.teamRole !== 'BACKEND') return { contracts: [], approved: [], repos: [] };
  const [jobs, approved, repos] = await Promise.all([
    listPendingContractJobs(pool, ctx.projectId),
    listApprovedContracts(pool, ctx.projectId),
    listBackendRepos(pool, ctx.projectId),
  ]);
  const answered = await Promise.all(jobs.map((j) => listQuestionsOf(pool, { kind: 'contract', contractId: j.id })));
  return {
    // 수정 요청이면 직전 초안이 아직 행에 남아 있다 — 그걸 "이전 초안"으로 준다.
    contracts: jobs.map((j, i) => ({
      ...j,
      previous: j.schemaYaml && j.summary ? { schemaYaml: j.schemaYaml, summary: j.summary } : null,
      answers: answered[i]!.flatMap((q) => q.questions.flatMap((item) => (q.answers?.[item.question] === undefined ? [] : [{ question: item.question, answer: q.answers[item.question]! }]))),
    })),
    approved,
    repos,
  };
}

async function assertWriter(ctx: AgentContext, contractId: string): Promise<ContractView> {
  const membership = await findAgentMembership(pool, ctx.agentId);
  if (!membership || membership.projectId !== ctx.projectId) throw new AppError('NOT_PROJECT_MEMBER', 'agent is not a member of this project');
  if (membership.teamRole !== 'BACKEND') throw new AppError('NOT_CONTRACT_WRITER', 'only the BACKEND agent drafts API contracts');
  const contract = await findContract(pool, contractId);
  if (!contract || contract.projectId !== ctx.projectId) throw new AppError('CONTRACT_NOT_FOUND', `contract ${contractId} not found`);
  return contract;
}

// 초안 제출. 형식이 틀리면 422 CONTRACT_INVALID(위반 목록) — Executor가 그걸 붙여 한 번 다시 쓴다(교정 1회).
// attempt가 지금 회차와 다르면(그 사이 수정 요청·다른 초안) 409 CONTRACT_STALE.
// openQuestions(033): 질문 형식({ question, options })은 라우팅해 FE·BE·PM에게 묻고, 답이 다 오면 다음 회차가 저절로 열린다.
// 문자열(CLI 0.1.17 이하)은 지금처럼 기록만 한다(호환). 일반 모드 상한을 넘는 질문은 가정 문장으로 기록한다.
export async function submitContractDraft(
  ctx: AgentContext,
  contractId: string,
  input: { attempt: number; openapiYaml: string; summary: string; openQuestions: (string | PlanningQuestion)[] },
): Promise<ContractView> {
  const contract = await assertWriter(ctx, contractId);
  const checked = checkContractYaml(input.openapiYaml);
  const structured = input.openQuestions.filter((q): q is PlanningQuestion => typeof q !== 'string');
  const plain = input.openQuestions.filter((q): q is string => typeof q === 'string');
  const questionProblems = planningQuestionProblems(structured, 'openQuestions');
  if (!checked.ok || questionProblems.length > 0) {
    throw new AppError('CONTRACT_INVALID', 'the contract is not a valid OpenAPI fragment', [...(checked.ok ? [] : checked.problems), ...questionProblems]);
  }
  const project = (await findProjectById(pool, ctx.projectId))!;
  const { kept, overflow } = limitPlanningQuestions(structured, { mode: project.questionMode, roundsUsed: contract.questionRounds });
  const routed = kept.length > 0 ? await routePlanningQuestions(await contractQuestionInputs(ctx, contract, kept)) : [];
  const recorded = [...plain, ...kept.map((q) => q.question), ...overflow.map(assumptionOf)];

  const result = await withTransaction(async (tx) => {
    const done = await markContractDrafted(tx, {
      contractId,
      attempt: input.attempt,
      schemaYaml: input.openapiYaml,
      summary: input.summary,
      openQuestions: recorded,
      agentId: ctx.agentId,
    });
    if (!done) throw new AppError('CONTRACT_STALE', `contract is not waiting for attempt ${input.attempt} (status ${contract.status}, attempt ${contract.attempt})`);
    const questions = await insertPlanningQuestionsInTx(
      tx,
      {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        policyHash: ctx.policyHash,
        stage: 'contract',
        planId: null,
        contractId,
        askerRole: 'BACKEND',
        askedByAgentId: ctx.agentId,
        onBehalfOf: ctx.onBehalfOf,
      },
      routed,
    );
    await appendEvent(tx, {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      type: 'CONTRACT_DRAFTED',
      actorAgentId: ctx.agentId,
      onBehalfOf: ctx.onBehalfOf,
      policyHash: ctx.policyHash,
      payload: {
        contractId,
        featureKey: contract.featureKey,
        attempt: input.attempt,
        operations: checked.operations,
        openQuestionCount: recorded.length,
        questionCount: questions.length,
      },
    });
    return { contract: (await findContract(tx, contractId))!, questions };
  });
  planningQuestionsCommitted(result.questions, routed, project);
  return result.contract;
}

// 계약 초안의 질문이 라우터에 넘기는 맥락 — 확정한 기능 명세(태스크는 없다), BE 레포, 질문 하나.
async function contractQuestionInputs(ctx: AgentContext, contract: ContractView, questions: PlanningQuestion[]): Promise<{ question: AskedQuestion; input: RoutingInput }[]> {
  const [spec, repos] = await Promise.all([findSpecForTask(pool, contract.specId), listBackendRepos(pool, ctx.projectId)]);
  return questions.map((q) => {
    const asked = toAskedQuestion(q);
    return {
      question: asked,
      input: {
        stage: 'contract',
        askerRole: 'BACKEND',
        roles: [...TEAM_ROLES],
        task: null,
        spec: spec ? { featureKey: spec.featureKey, title: spec.title, content: spec.content } : null,
        repo: repos[0] ? { fullName: repos[0].fullName } : null,
        questions: [asked],
        // 계약을 쓰는 중이라 확정한 계약 요약은 없다.
        contract: null,
        context: { orgId: ctx.orgId },
      },
    };
  });
}

// 노트북이 초안을 못 냈다(형식을 두 번 다 못 맞춤·실행 실패). BE 개발자가 수정 요청으로 다시 시킬 수 있다.
export async function failContractDraft(ctx: AgentContext, contractId: string, input: { attempt: number; reason: string }): Promise<ContractView> {
  const contract = await assertWriter(ctx, contractId);
  return withTransaction(async (tx) => {
    if (!(await markContractFailed(tx, contractId, input.attempt, input.reason))) {
      throw new AppError('CONTRACT_STALE', `contract is not waiting for attempt ${input.attempt}`);
    }
    await appendEvent(tx, {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      type: 'CONTRACT_FAILED',
      actorAgentId: ctx.agentId,
      onBehalfOf: ctx.onBehalfOf,
      policyHash: ctx.policyHash,
      payload: { contractId, featureKey: contract.featureKey, attempt: input.attempt, reason: input.reason },
    });
    return (await findContract(tx, contractId))!;
  });
}

// ── 질문의 답으로 다음 회차(033) ──────────────────────────────────────────

export const PLANNING_QUESTIONS_ACTOR = 'system:planning-questions';

// 계약 초안의 질문이 전부 답해지면 답을 붙여 다음 회차를 연다 — BE 담당의 수정 요청(revise)과 같은 경로(작성 대기 → BE 노트북이 다시 쓴다),
// 원인 answers. 수정 요청 한도에는 세지 않는다(question_rounds). 계약이 이미 확정·재작성 중이면 아무것도 하지 않는다.
async function redraftWithAnswers(contractId: string): Promise<void> {
  const reopened = await withTransaction(async (tx) => {
    const contract = await findContract(tx, contractId, { forUpdate: true });
    if (!contract || contract.status !== 'draft') return null;
    // 답이 동시에 커밋되면 신호가 여러 번 온다 — 계약 행 잠금 안에서 대기가 남지 않았는지 센다(한 번만 연다: 연 뒤에는 draft가 아니다).
    if ((await listPendingQuestionsOf(tx, { kind: 'contract', contractId })).length > 0) return null;
    const questions = await listQuestionsOf(tx, { kind: 'contract', contractId });
    const answers = answersBlock(questions);
    if (!answers) return null;
    const feedback = `질문에 받은 답 — 이 답을 반영해 다시 써라. 답으로 정해진 것은 다시 묻지 않는다.\n${answers}`;
    if (!(await requestContractRedraftByAnswers(tx, contractId, feedback))) return null;
    const project = (await findProjectById(tx, contract.projectId))!;
    await appendEvent(tx, {
      orgId: project.orgId,
      projectId: contract.projectId,
      type: 'CONTRACT_REVISION_REQUESTED',
      onBehalfOf: PLANNING_QUESTIONS_ACTOR,
      policyHash: project.policyHash,
      payload: { contractId, featureKey: contract.featureKey, attempt: contract.attempt + 1, feedback, cause: 'answers' },
    });
    return contract.projectId;
  });
  if (reopened) contractsChanged(reopened);
}

onPlanningQuestionsSettled(async (_projectId, subject) => {
  if (subject.kind !== 'contract') return;
  try {
    await redraftWithAnswers(subject.contractId);
  } catch (err) {
    logger.warn('질문의 답으로 계약 다음 회차를 열지 못했다 — BE 담당이 수정 요청으로 이어 간다', { contractId: subject.contractId, error: String(err) });
  }
});
