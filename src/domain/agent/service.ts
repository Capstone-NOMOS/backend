import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors.js';
import type { Queryable } from '../../config/db.js';
import { generateSecret, hashSecret, signJwt } from '../../utils/tokens.js';
import { findAgentMembership, findProjectAuthRow } from '../policy/repository.js';
import { appendEvent } from '../events/append.js';
import { findUserByConnectKeyHash } from '../org/repository.js';
import {
  findAgentByActiveRefreshToken,
  insertRefreshToken,
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

// 조직·프로젝트가 없어도 연결된다. org_id는 사용자의 현재 조직(없으면 null)을 따른다.
export async function connectAgent(input: ConnectAgentInput): Promise<ConnectAgentResult> {
  return withTransaction(async (tx) => {
    const user = await findUserByConnectKeyHash(tx, hashSecret(input.connectKey));
    if (!user) {
      throw new AppError('INVALID_CONNECT_REQUEST', 'invalid connect request');
    }

    const { agent, created } = await upsertAgent(tx, {
      userId: user.id,
      orgId: user.orgId,
      name: input.agentName,
      harness: input.harness,
      skills: input.skills,
      maxConcurrent: input.maxConcurrent,
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
      payload: { agentId: agent.id, userId: user.id, name: agent.name, harness: agent.harness, reconnected: !created },
    });

    return { accessToken: await signAgentAccessToken(tx, agent), refreshToken, agentId: agent.id };
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
