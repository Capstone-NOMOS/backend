import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';

// CLI 브라우저 승인(device flow, RFC 8628)의 요청 행.

export type DeviceRequestStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'CONSUMED';

export type DeviceRequest = {
  id: string;
  userCode: string;
  agentName: string;
  harness: string;
  skills: string[];
  maxConcurrent: number;
  clientIp: string | null;
  status: DeviceRequestStatus;
  decidedBy: string | null;
  pollInterval: number;
  lastPolledAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
};

function toDeviceRequest(row: QueryResultRow): DeviceRequest {
  return {
    id: row.id,
    userCode: row.user_code,
    agentName: row.agent_name,
    harness: row.harness,
    skills: row.skills,
    maxConcurrent: row.max_concurrent,
    clientIp: row.client_ip,
    status: row.status,
    decidedBy: row.decided_by,
    pollInterval: row.poll_interval,
    lastPolledAt: row.last_polled_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export async function insertDeviceRequest(
  db: Queryable,
  row: {
    id: string;
    deviceCodeHash: string;
    userCode: string;
    agentName: string;
    harness: string;
    skills: string[];
    maxConcurrent: number;
    clientIp: string | null;
    pollInterval: number;
    expiresAt: Date;
  },
): Promise<DeviceRequest> {
  const { rows } = await db.query(
    `INSERT INTO agent_device_requests
       (id, device_code_hash, user_code, agent_name, harness, skills, max_concurrent, client_ip, poll_interval, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      row.id,
      row.deviceCodeHash,
      row.userCode,
      row.agentName,
      row.harness,
      row.skills,
      row.maxConcurrent,
      row.clientIp,
      row.pollInterval,
      row.expiresAt,
    ],
  );
  return toDeviceRequest(rows[0]!);
}

export async function findDeviceRequestByCodeHash(db: Queryable, deviceCodeHash: string): Promise<DeviceRequest | null> {
  const { rows } = await db.query(`SELECT * FROM agent_device_requests WHERE device_code_hash = $1 FOR UPDATE`, [
    deviceCodeHash,
  ]);
  const row = rows[0];
  return row ? toDeviceRequest(row) : null;
}

// 같은 userCode가 끝난 요청에 다시 쓰일 수 있다(살아 있는 요청끼리만 유일). 가장 최근 것을 본다.
export async function findDeviceRequestByUserCode(
  db: Queryable,
  userCode: string,
  options: { forUpdate?: boolean } = {},
): Promise<DeviceRequest | null> {
  const { rows } = await db.query(
    `SELECT * FROM agent_device_requests WHERE user_code = $1 ORDER BY created_at DESC LIMIT 1${options.forUpdate ? ' FOR UPDATE' : ''}`,
    [userCode],
  );
  const row = rows[0];
  return row ? toDeviceRequest(row) : null;
}

export async function decideDeviceRequest(
  db: Queryable,
  id: string,
  status: 'APPROVED' | 'DENIED',
  userId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE agent_device_requests SET status = $2, decided_by = $3, decided_at = now()
      WHERE id = $1 AND status = 'PENDING'`,
    [id, status, userId],
  );
  return rowCount === 1;
}

export async function recordDevicePoll(db: Queryable, id: string, pollInterval: number): Promise<void> {
  await db.query(`UPDATE agent_device_requests SET last_polled_at = now(), poll_interval = $2 WHERE id = $1`, [
    id,
    pollInterval,
  ]);
}

// 토큰은 한 번만 나간다 — APPROVED에서 CONSUMED로 넘어간 요청 하나만 토큰을 받는다.
export async function consumeDeviceRequest(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE agent_device_requests SET status = 'CONSUMED' WHERE id = $1 AND status = 'APPROVED'`,
    [id],
  );
  return rowCount === 1;
}
