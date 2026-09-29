import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';
import { asAgentId, asOrgId, asUserId, type AgentId, type OrgId, type UserId } from '../ids.js';

export type AgentStatus = 'pending' | 'online' | 'offline';

export type Agent = {
  id: AgentId;
  userId: UserId;
  orgId: OrgId | null;
  name: string;
  harness: string;
  skills: string[];
  maxConcurrent: number;
  status: AgentStatus;
  lastSeenAt: string | null;
  createdAt: string;
};

function toAgent(row: QueryResultRow): Agent {
  return {
    id: asAgentId(row.id),
    userId: asUserId(row.user_id),
    orgId: row.org_id === null ? null : asOrgId(row.org_id),
    name: row.name,
    harness: row.harness,
    skills: row.skills,
    maxConcurrent: row.max_concurrent,
    status: row.status,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

// (user_id, name)이 이미 있으면 새로 만들지 않고 연결 정보만 갱신한다.
// CLI를 재설치하고 같은 이름으로 다시 연결하는 흔한 경우를 409로 막지 않기 위해서다.
// status는 건드리지 않는다. xmax = 0이면 이번 문장이 INSERT한 행이다.
export async function upsertAgent(
  db: Queryable,
  input: {
    userId: string;
    orgId: string | null;
    name: string;
    harness: string;
    skills: string[];
    maxConcurrent: number;
  },
): Promise<{ agent: Agent; created: boolean }> {
  const { rows } = await db.query(
    `INSERT INTO agents (user_id, org_id, name, harness, skills, max_concurrent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, name) DO UPDATE
       SET org_id = EXCLUDED.org_id,
           harness = EXCLUDED.harness,
           skills = EXCLUDED.skills,
           max_concurrent = EXCLUDED.max_concurrent
     RETURNING *, (xmax = 0) AS inserted`,
    [input.userId, input.orgId, input.name, input.harness, input.skills, input.maxConcurrent],
  );
  const row = rows[0];
  if (!row) throw new Error('upsertAgent: returned no row');
  return { agent: toAgent(row), created: row.inserted === true };
}

export async function insertRefreshToken(
  db: Queryable,
  input: { agentId: string; tokenHash: string; expiresAt: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO agent_tokens (agent_id, token_hash, kind, expires_at) VALUES ($1, $2, 'refresh', $3)`,
    [input.agentId, input.tokenHash, input.expiresAt],
  );
}

// 만료·폐기되지 않은 refresh token의 주인 에이전트.
export async function findAgentByActiveRefreshToken(db: Queryable, tokenHash: string): Promise<Agent | null> {
  const { rows } = await db.query(
    `SELECT a.* FROM agent_tokens t
       JOIN agents a ON a.id = t.agent_id
      WHERE t.token_hash = $1
        AND t.kind = 'refresh'
        AND t.revoked_at IS NULL
        AND t.expires_at > now()`,
    [tokenHash],
  );
  const row = rows[0];
  return row ? toAgent(row) : null;
}

// 사용자가 조직에 들어갈 때 이미 연결해 둔 에이전트도 같은 조직으로 넣는다.
// 불변식: agents.org_id는 항상 users.org_id와 같다.
export async function assignAgentsToOrg(db: Queryable, userId: string, orgId: string): Promise<string[]> {
  const { rows } = await db.query(
    `UPDATE agents SET org_id = $2 WHERE user_id = $1 AND org_id IS NULL RETURNING id`,
    [userId, orgId],
  );
  return rows.map((r) => r.id as string);
}

// 토큰의 sub로 에이전트를 다시 읽는다. 토큰이 신원만 증명하고 나머지는 DB가 정본이라는 원칙의
// 에이전트 쪽 구현체 — 이게 없으면 지워진 에이전트의 토큰이 만료까지 살고,
// 조직 가입으로 agents.org_id가 채워져도 토큰의 옛 org_id가 계속 쓰인다.
export async function findAgentById(db: Queryable, agentId: string): Promise<Agent | null> {
  const { rows } = await db.query(`SELECT * FROM agents WHERE id = $1`, [agentId]);
  const row = rows[0];
  return row ? toAgent(row) : null;
}
