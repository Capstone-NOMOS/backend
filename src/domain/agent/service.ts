import { pool, withTransaction } from '../../config/db.js';
import { presenceOf } from './presence.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors.js';
import type { Queryable } from '../../config/db.js';
import type { PoolClient } from 'pg';
import { generateSecret, hashSecret, signJwt } from '../../utils/tokens.js';
import { findAgentMembership, findProjectAuthRow } from '../policy/repository.js';
import { closeOpenRunsOfAgentInTx } from '../room/runs.js';
import { appendEvent } from '../events/append.js';
import { findOrganizationById, findUserByConnectKeyHash, findUserById } from '../org/repository.js';
import { agentRevoked } from '../dispatch/agent-revoked.js';
import { tasksChanged } from '../dispatch/tasks-changed.js';
import type { GithubRevokeResult } from '../events/types.js';
import { detachAgentFromActiveProject, reattachAgentInTx } from '../project/service.js';
import {
  findAgentByActiveRefreshToken,
  findAgentById,
  insertRefreshToken,
  listAgentsByOrg,
  markAgentDisconnected,
  revokeAgentTokens,
  upsertAgent,
  type Agent,
} from './repository.js';

const AGENT_ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// 토큰에는 신원만 담는다. scopes·denied는 넣지 않는다 — 권한은 매 요청 DB에서 읽는다.
// policy_hash는 그 조회를 대체하는 게 아니라, "이 토큰이 최신 정책 기준인가"를 판별하는 무효화 장치다.
// kind:'agent'가 있어야 사용자 API의 authenticate가 이 토큰을 사람 토큰으로 오인하지 않는다.
async function signAgentAccessToken(db: Queryable, agent: Agent): Promise<string> {
  const membership = await findAgentMembership(db, agent.id);
  const project = membership ? await findProjectAuthRow(db, membership.projectId) : null;
  return signJwt(
    {
      sub: agent.id,
      kind: 'agent',
      on_behalf_of: agent.userId,
      org_id: agent.orgId,
      project_id: membership?.projectId ?? null,
      policy_hash: project?.policyHash ?? null,
    },
    AGENT_ACCESS_TTL_SECONDS,
    env.JWT_SECRET,
  );
}

export type ConnectAgentInput = {
  connectKey: string;
  agentName: string;
  harness: string;
  skills: string[];
  maxConcurrent: number;
};

export type ConnectAgentResult = { accessToken: string; refreshToken: string; agentId: string };

export type AgentSpec = Omit<ConnectAgentInput, 'connectKey'>;

// 사람이 확인된 뒤의 공통 부분 — 연결 키 경로와 브라우저 승인(device) 경로가 같이 쓴다.
// 에이전트 upsert → refresh token → AGENT_CONNECTED → access token. 한쪽에만 고치면 두 경로의 토큰이 갈라진다.
// org_id는 사용자의 현재 조직(없으면 null). 조직에 들어가면 assignAgentsToOrg가 옮긴다.
export async function issueAgentCredentials(
  tx: PoolClient,
  user: { id: string; orgId: string | null },
  spec: AgentSpec,
  method: 'connect_key' | 'device' | 'connect_code',
): Promise<ConnectAgentResult> {
  const { agent, created } = await upsertAgent(tx, {
    userId: user.id,
    orgId: user.orgId,
    name: spec.agentName,
    harness: spec.harness,
    skills: spec.skills,
    maxConcurrent: spec.maxConcurrent,
  });

  const refreshToken = generateSecret();
  await insertRefreshToken(tx, {
    agentId: agent.id,
    tokenHash: hashSecret(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  });

  await appendEvent(tx, {
    orgId: user.orgId,
    type: 'AGENT_CONNECTED',
    actorAgentId: agent.id,
    onBehalfOf: user.id,
    payload: { agentId: agent.id, userId: user.id, name: agent.name, harness: agent.harness, reconnected: !created, method },
  });
  // 같은 사람이 다시 연결했고 에이전트 없이 담당만 남은 역할이 하나면 다시 붙인다(028) — 대표가 다시 배정하지 않아도 된다.
  // 토큰보다 먼저 붙여야 토큰에 그 프로젝트가 실린다.
  const reattachedTo = await reattachAgentInTx(tx, agent.id, user.id);
  if (reattachedTo) reattached.push(reattachedTo);

  return { accessToken: await signAgentAccessToken(tx, agent), refreshToken, agentId: agent.id };
}

// 연결 키 경로. 브라우저가 없는 환경(SSH·서버)용으로 남긴다. 조직·프로젝트가 없어도 연결된다.
export async function connectAgent(input: ConnectAgentInput): Promise<ConnectAgentResult> {
  const result = await withTransaction(async (tx) => {
    const user = await findUserByConnectKeyHash(tx, hashSecret(input.connectKey));
    if (!user) {
      throw new AppError('INVALID_CONNECT_REQUEST', 'invalid connect request');
    }
    const { connectKey: _connectKey, ...spec } = input;
    return issueAgentCredentials(tx, user, spec, 'connect_key');
  });
  flushReattached();
  return result;
}

export async function refreshAgentToken(refreshToken: string): Promise<{ accessToken: string }> {
  const agent = await findAgentByActiveRefreshToken(pool, hashSecret(refreshToken));
  if (!agent) {
    throw new AppError('INVALID_REFRESH_TOKEN', 'refresh token is invalid or expired');
  }
  return { accessToken: await signAgentAccessToken(pool, agent) };
}

export type AgentSelf = {
  agentId: string;
  name: string;
  maxConcurrent: number;
  projectId: string;
  teamRole: string | null;
};

// Executor가 폴링 상한과 대상 프로젝트를 여기서 받는다.
export async function describeSelf(ctx: {
  agentId: string;
  projectId: string;
}): Promise<AgentSelf> {
  const { rows } = await pool.query(
    `SELECT a.name, a.max_concurrent, m.team_role
       FROM agents a
       LEFT JOIN project_members m ON m.agent_id = a.id AND m.project_id = $2
      WHERE a.id = $1`,
    [ctx.agentId, ctx.projectId],
  );
  const row = rows[0];
  if (!row) throw new AppError('UNAUTHENTICATED', 'invalid or expired token');
  return {
    agentId: ctx.agentId,
    name: row.name,
    maxConcurrent: row.max_concurrent,
    projectId: ctx.projectId,
    teamRole: row.team_role,
  };
}

// 이 에이전트가 누구 것인가(024) — CLI가 저장된 자격 증명을 재사용할 때 "어느 계정으로 붙었는지" 출력한다.
// 배정 전에도 된다(/agents/me는 배정 전 403). 조직은 매번 DB에서 읽는다(토큰의 org_id가 아니라).
export type AgentAccount = { agentId: string; agentName: string; loginId: string | null; nickname: string | null; orgName: string | null };

export async function describeAccount(agentId: string): Promise<AgentAccount> {
  const agent = await findAgentById(pool, agentId);
  if (!agent) throw new AppError('UNAUTHENTICATED', 'invalid or expired token');
  const user = await findUserById(pool, agent.userId);
  if (!user) throw new AppError('UNAUTHENTICATED', 'invalid or expired token');
  const org = user.orgId ? await findOrganizationById(pool, user.orgId) : null;
  return { agentId, agentName: agent.name, loginId: user.loginId, nickname: user.nickname, orgName: org?.name ?? null };
}

// 역할 배정 화면이 보는 모양. agents.status는 넣지 않는다 — 연결 이후 갱신하는 경로가 아직 없어
// 항상 'pending'이라, 내보내면 화면이 "오프라인"으로 오해한다(접속 상태 추적은 미구현).
export type OrgAgentView = {
  agentId: string;
  agentName: string;
  userId: string;
  nickname: string | null;
  // 처음 CLI로 연결한 시각. 행이 있다는 것 자체가 "연결한 적 있음"이다.
  connectedAt: string;
  // 지금 접속해 있는가(태스크 스트림이 열려 있거나 최근 60초 안에 요청). 메모리 값이라 서버 재시작 직후에는 false다.
  online: boolean;
  lastSeenAt: string | null;
  // 진행 중(completed·aborted가 아닌) 프로젝트 배정. 에이전트는 한 번에 한 프로젝트만 맡는다.
  assignment: { projectId: string; teamRole: string } | null;
};

export async function listOrgAgents(orgId: string): Promise<OrgAgentView[]> {
  const rows = await listAgentsByOrg(pool, orgId);
  return rows.map((r) => ({
    agentId: r.agentId,
    agentName: r.agentName,
    userId: r.userId,
    nickname: r.nickname,
    connectedAt: r.connectedAt,
    // 접속 상태는 메모리(presence.ts) — 태스크 스트림이 열려 있거나 최근 60초 안에 요청이 있었으면 online.
    ...presenceOf(r.agentId),
    assignment:
      r.activeProjectId === null || r.activeTeamRole === null
        ? null
        : { projectId: r.activeProjectId, teamRole: r.activeTeamRole },
  }));
}

// 에이전트가 속한 조직 — 사람용 실시간 스트림이 접속 상태 변화를 어느 조직에 알릴지 정할 때 쓴다. 조직 가입 전이면 null.
export async function agentOrgId(agentId: string): Promise<string | null> {
  return (await findAgentById(pool, agentId))?.orgId ?? null;
}

// 커밋 뒤에 태스크 스냅샷을 다시 계산할 프로젝트 — 다시 붙은 에이전트에게 가져갈 태스크를 보낸다.
// issueAgentCredentials는 호출부의 트랜잭션 안이라 여기 모았다가 호출부가 커밋 뒤 tasksChanged를 부른다(flushReattached).
const reattached: string[] = [];
export function flushReattached(): void {
  for (const projectId of reattached.splice(0)) tasksChanged(projectId);
}

// ── 연결 해제(021) ───────────────────────────────────────────────────────

// 에이전트 연결 해제 — 그 에이전트의 주인이나 같은 조직의 대표가 한다(대표 결정).
// - 맡은 진행 중 프로젝트에서 **에이전트만 떨어진다**(028). 사람은 그 역할 담당으로 남는다 — 접근·GitHub 권한도 그대로다.
//   진행 중 태스크를 붙잡고 있으면 409 ACTIVE_TASKS_HELD(멤버 해제와 같은 규칙). 다시 연결하면 그 역할에 다시 붙는다.
// - refresh token을 전부 폐기하고 disconnected_at을 찍는다. 남은 access token은 인증이 거부한다(AGENT_DISCONNECTED).
// - 행은 지우지 않는다(이벤트·태스크가 가리킨다). 같은 노트북에서 같은 이름으로 다시 connect하면 되살아난다.
export async function disconnectAgent(
  actor: { userId: string; orgId: string | null; orgRole: string | null },
  agentId: string,
): Promise<{ agentId: string; disconnectedAt: string; unassignedFrom: string | null; githubRevocations: GithubRevokeResult[] }> {
  const agent = await findAgentById(pool, agentId);
  if (!agent || agent.disconnectedAt !== null) throw new AppError('AGENT_NOT_FOUND', `agent ${agentId} not found`);
  const byOwner = agent.userId === actor.userId;
  if (!byOwner && !(actor.orgRole === 'REPRESENTATIVE' && actor.orgId !== null && agent.orgId === actor.orgId)) {
    throw new AppError('NOT_AGENT_OWNER', 'only the agent owner or the representative can disconnect it');
  }
  const result = await withTransaction(async (tx) => {
    const unassignedFrom = await detachAgentFromActiveProject(tx, agentId, actor.userId, 'agent_disconnected');
    // 열린 실행(시작했지만 아직 태스크를 잡기 전 등)을 닫는다 — 해제 뒤 Executor의 종료 보고는 401이라 오지 않는다(room/runs.ts).
    await closeOpenRunsOfAgentInTx(tx, agentId, actor.userId);
    const marked = await markAgentDisconnected(tx, agentId);
    if (!marked) throw new AppError('AGENT_NOT_FOUND', `agent ${agentId} not found`);
    await revokeAgentTokens(tx, agentId);
    await appendEvent(tx, {
      orgId: agent.orgId,
      type: 'AGENT_DISCONNECTED',
      actorAgentId: agentId,
      onBehalfOf: actor.userId,
      payload: { agentId, userId: agent.userId, name: agent.name, byOwner, unassignedFrom },
    });
    return { agentId, disconnectedAt: marked.disconnectedAt!, unassignedFrom };
  });
  // 커밋 뒤 — 떨어진 프로젝트의 태스크 스냅샷을 다시 계산하고, 그 에이전트의 스트림을 끊는다.
  if (result.unassignedFrom) tasksChanged(result.unassignedFrom);
  agentRevoked(agentId);
  // 사람은 담당으로 남으므로 GitHub 레포 접근은 회수하지 않는다(028). 회수는 사람이 빠질 때(멤버 해제·조직 탈퇴)만.
  return { ...result, githubRevocations: [] };
}
