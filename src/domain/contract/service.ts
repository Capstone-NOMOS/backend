import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../../config/db.js';
import { AppError } from '../../errors.js';
import { contractsChanged } from '../dispatch/contracts-changed.js';
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
async function assertApprover(tx: PoolClient, actor: UserContext, contract: ContractView): Promise<{ byRepresentative: boolean }> {
  await assertProjectVisibleToUser(tx, actor, contract.projectId);
  const owner = await findBackendOwner(tx, contract.projectId);
  if (owner !== null && owner === actor.userId) return { byRepresentative: false };
  if (owner === null && actor.orgRole === 'REPRESENTATIVE') return { byRepresentative: true };
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

export async function approveContract(actor: UserContext, contractId: string): Promise<ContractView> {
  return withTransaction(async (tx) => {
    const contract = await loadForDecision(tx, contractId);
    const { byRepresentative } = await assertApprover(tx, actor, contract);
    if (!(await markContractApproved(tx, contractId, actor.userId))) {
      throw new AppError('CONTRACT_NOT_DRAFT', `only a draft contract can be confirmed (this one is ${contract.status})`);
    }
    await appendEvent(tx, {
      orgId: actor.orgId,
      projectId: contract.projectId,
      type: 'CONTRACT_APPROVED',
      onBehalfOf: actor.userId,
      payload: { contractId, featureKey: contract.featureKey, attempt: contract.attempt, byRepresentative },
    });
    return (await findContract(tx, contractId))!;
  });
}

// 수정 요청 — 초안이나 실패에서 다음 회차로 다시 쓰게 한다. 피드백은 선택(실패를 그대로 다시 시도할 때는 없어도 된다).
export async function reviseContract(actor: UserContext, contractId: string, feedback: string | null): Promise<ContractView> {
  const result = await withTransaction(async (tx) => {
    const contract = await loadForDecision(tx, contractId);
    await assertApprover(tx, actor, contract);
    const used = contract.attempt - 1;
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

export type ContractJobView = ContractJob & { previous: { schemaYaml: string; summary: string } | null };

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
  return {
    // 수정 요청이면 직전 초안이 아직 행에 남아 있다 — 그걸 "이전 초안"으로 준다.
    contracts: jobs.map((j) => ({ ...j, previous: j.schemaYaml && j.summary ? { schemaYaml: j.schemaYaml, summary: j.summary } : null })),
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
export async function submitContractDraft(
  ctx: AgentContext,
  contractId: string,
  input: { attempt: number; openapiYaml: string; summary: string; openQuestions: string[] },
): Promise<ContractView> {
  const contract = await assertWriter(ctx, contractId);
  const checked = checkContractYaml(input.openapiYaml);
  if (!checked.ok) throw new AppError('CONTRACT_INVALID', 'the contract is not a valid OpenAPI fragment', checked.problems);
  return withTransaction(async (tx) => {
    const done = await markContractDrafted(tx, {
      contractId,
      attempt: input.attempt,
      schemaYaml: input.openapiYaml,
      summary: input.summary,
      openQuestions: input.openQuestions,
      agentId: ctx.agentId,
    });
    if (!done) throw new AppError('CONTRACT_STALE', `contract is not waiting for attempt ${input.attempt} (status ${contract.status}, attempt ${contract.attempt})`);
    await appendEvent(tx, {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      type: 'CONTRACT_DRAFTED',
      actorAgentId: ctx.agentId,
      onBehalfOf: ctx.onBehalfOf,
      policyHash: ctx.policyHash,
      payload: { contractId, featureKey: contract.featureKey, attempt: input.attempt, operations: checked.operations, openQuestionCount: input.openQuestions.length },
    });
    return (await findContract(tx, contractId))!;
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
