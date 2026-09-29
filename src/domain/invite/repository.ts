import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';
import { asInviteId, asOrgId, asUserId, type InviteId, type OrgId, type UserId } from '../ids.js';
import type { TeamRole } from '../roles.js';

export type Invite = {
  id: InviteId;
  orgId: OrgId;
  token: string;
  teamRole: TeamRole | null;
  createdBy: UserId;
  expiresAt: string;
  usedBy: UserId | null;
  usedAt: string | null;
  createdAt: string;
};

function toInvite(row: QueryResultRow): Invite {
  return {
    id: asInviteId(row.id),
    orgId: asOrgId(row.org_id),
    token: row.token,
    teamRole: row.team_role,
    createdBy: asUserId(row.created_by),
    expiresAt: row.expires_at,
    usedBy: row.used_by === null ? null : asUserId(row.used_by),
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

export async function insertInvite(
  db: Queryable,
  input: {
    id: string;
    orgId: string;
    token: string;
    teamRole: TeamRole | null;
    createdBy: string;
    expiresAt: Date;
  },
): Promise<Invite> {
  const { rows } = await db.query(
    `INSERT INTO invites (id, org_id, token, team_role, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.id, input.orgId, input.token, input.teamRole, input.createdBy, input.expiresAt],
  );
  const row = rows[0];
  if (!row) throw new Error('insertInvite: insert returned no row');
  return toInvite(row);
}

export async function findInviteByToken(db: Queryable, token: string): Promise<Invite | null> {
  const { rows } = await db.query(`SELECT * FROM invites WHERE token = $1`, [token]);
  const row = rows[0];
  return row ? toInvite(row) : null;
}

// 아직 아무도 쓰지 않은 초대만 "사용됨"으로 바꾼다. 두 사람이 동시에 수락하면 한 명만 성공하고
// 나머지는 null을 받는다 — 앞서 SELECT로 확인했더라도 여기서 다시 막아야 한다.
export async function markInviteUsed(db: Queryable, inviteId: string, usedBy: string): Promise<Invite | null> {
  const { rows } = await db.query(
    `UPDATE invites SET used_by = $2, used_at = now() WHERE id = $1 AND used_by IS NULL RETURNING *`,
    [inviteId, usedBy],
  );
  const row = rows[0];
  return row ? toInvite(row) : null;
}
