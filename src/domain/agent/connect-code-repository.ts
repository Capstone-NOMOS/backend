import type { Queryable } from '../../config/db.js';

// 1회용 연결 코드(024). 코드는 해시로만 저장한다.

export async function insertConnectCode(db: Queryable, input: { userId: string; codeHash: string; expiresAt: Date }): Promise<{ id: string }> {
  const { rows } = await db.query(
    `INSERT INTO agent_connect_codes (user_id, code_hash, expires_at) VALUES ($1, $2, $3) RETURNING id`,
    [input.userId, input.codeHash, input.expiresAt],
  );
  return { id: rows[0]!.id as string };
}

// 아직 안 쓰였고 만료 전인 코드를 잠그고 읽는다 — 같은 코드로 두 번 연결되지 않게.
export async function lockUsableConnectCode(db: Queryable, codeHash: string): Promise<{ id: string; userId: string } | null> {
  const { rows } = await db.query(
    `SELECT id, user_id FROM agent_connect_codes
      WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
      FOR UPDATE`,
    [codeHash],
  );
  return rows[0] ? { id: rows[0].id as string, userId: rows[0].user_id as string } : null;
}

export async function markConnectCodeUsed(db: Queryable, id: string, agentId: string): Promise<void> {
  await db.query(`UPDATE agent_connect_codes SET used_at = now(), agent_id = $2 WHERE id = $1 AND used_at IS NULL`, [id, agentId]);
}
