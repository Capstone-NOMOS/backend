import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors.js';
import type { Queryable } from '../../config/db.js';
import type { PoolClient } from 'pg';
import { generateSecret, hashSecret, signJwt } from '../../utils/tokens.js';
import { findAgentMembership, findProjectAuthRow } from '../policy/repository.js';
import { appendEvent } from '../events/append.js';
import { findUserByConnectKeyHash } from '../org/repository.js';
import {
  findAgentByActiveRefreshToken,
  insertRefreshToken,
  listAgentsByOrg,
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
  method: 'connect_key' | 'device',
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

  return { accessToken: await signAgentAccessToken(tx, agent), refreshToken, agentId: agent.id };
}

// 연결 키 경로. 브라우저가 없는 환경(SSH·서버)용으로 남긴다. 조직·프로젝트가 없어도 연결된다.
export async function connectAgent(input: ConnectAgentInput): Promise<ConnectAgentResult> {
  return withTransaction(async (tx) => {
    const user = await findUserByConnectKeyHash(tx, hashSecret(input.connectKey));
    if (!user) {
      throw new AppError('INVALID_CONNECT_REQUEST', 'invalid connect request');
    }
    const { connectKey: _connectKey, ...spec } = input;
    return issueAgentCredentials(tx, user, spec, 'connect_key');
  });
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

// 역할 배정 화면이 보는 모양. agents.status는 넣지 않는다 — 연결 이후 갱신하는 경로가 아직 없어
// 항상 'pending'이라, 내보내면 화면이 "오프라인"으로 오해한다(접속 상태 추적은 미구현).
export type OrgAgentView = {
  agentId: string;
  agentName: string;
  userId: string;
  nickname: string | null;
  // 처음 CLI로 연결한 시각. 행이 있다는 것 자체가 "연결한 적 있음"이다.
  connectedAt: string;
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
    assignment:
      r.activeProjectId === null || r.activeTeamRole === null
        ? null
        : { projectId: r.activeProjectId, teamRole: r.activeTeamRole },
  }));
}
