import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';
import { AppError } from '../../errors.js';
import { asOrgId, asUserId, type OrgId, type UserId } from '../ids.js';

export type OrgRole = 'REPRESENTATIVE' | 'MEMBER';

export type Organization = {
  id: OrgId;
  name: string;
  createdBy: UserId;
  createdAt: string;
};

// password_hash·connect_key_hash는 일부러 뺐다. 이 타입이 응답으로 새어 나가도 비밀값이 섞이지 않게.
export type User = {
  id: UserId;
  orgId: OrgId | null;
  loginId: string | null;
  nickname: string | null;
  githubId: number | null;
  githubLogin: string | null;
  name: string | null;
  orgRole: OrgRole;
  createdAt: string;
};

function toOrganization(row: QueryResultRow): Organization {
  return {
    id: asOrgId(row.id),
    name: row.name,
    createdBy: asUserId(row.created_by),
    createdAt: row.created_at,
  };
}

function toUser(row: QueryResultRow): User {
  return {
    id: asUserId(row.id),
    orgId: row.org_id === null ? null : asOrgId(row.org_id),
    loginId: row.login_id,
    nickname: row.nickname,
    // Number(null)은 0이 되므로 null을 먼저 걸러야 한다.
    githubId: row.github_id === null ? null : Number(row.github_id),
    githubLogin: row.github_login,
    name: row.name,
    orgRole: row.org_role,
    createdAt: row.created_at,
  };
}

function isUniqueViolationOn(err: unknown, constraint: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && e.constraint === constraint;
}

export async function insertOrganization(
  db: Queryable,
  input: { id: string; name: string; createdBy: string },
): Promise<Organization> {
  const { rows } = await db.query(
    `INSERT INTO organizations (id, name, created_by) VALUES ($1, $2, $3) RETURNING *`,
    [input.id, input.name, input.createdBy],
  );
  const row = rows[0];
  if (!row) throw new Error('insertOrganization: insert returned no row');
  return toOrganization(row);
}

export type NewUser = {
  id: string;
  orgId?: string | null;
  orgRole?: OrgRole;
  loginId?: string | null;
  passwordHash?: string | null;
  nickname?: string | null;
  connectKeyHash?: string | null;
  githubId?: number | null;
  githubLogin?: string | null;
  name?: string | null;
};

// login_id 중복은 LOGIN_ID_TAKEN(409). 다른 유니크 위반(대표 2명 등)은 그대로 던진다.
export async function insertUser(db: Queryable, input: NewUser): Promise<User> {
  try {
    const { rows } = await db.query(
      `INSERT INTO users (id, org_id, org_role, login_id, password_hash, nickname, connect_key_hash,
                          github_id, github_login, name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        input.id,
        input.orgId ?? null,
        input.orgRole ?? 'MEMBER',
        input.loginId ?? null,
        input.passwordHash ?? null,
        input.nickname ?? null,
        input.connectKeyHash ?? null,
        input.githubId ?? null,
        input.githubLogin ?? null,
        input.name ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('insertUser: insert returned no row');
    return toUser(row);
  } catch (err) {
    if (isUniqueViolationOn(err, 'uq_users_login_id')) {
      throw new AppError('LOGIN_ID_TAKEN', 'login id is already taken');
    }
    throw err;
  }
}

export async function findUserById(db: Queryable, userId: string): Promise<User | null> {
  const { rows } = await db.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  const row = rows[0];
  return row ? toUser(row) : null;
}

// 비밀번호가 없는 계정(GitHub 전용)은 로컬 로그인 대상이 아니므로 없는 것으로 취급한다.
export async function findCredentialsByLoginId(
  db: Queryable,
  loginId: string,
): Promise<{ user: User; passwordHash: string } | null> {
  const { rows } = await db.query(
    `SELECT * FROM users WHERE login_id = $1 AND password_hash IS NOT NULL`,
    [loginId],
  );
  const row = rows[0];
  return row ? { user: toUser(row), passwordHash: row.password_hash } : null;
}

export async function findUserByConnectKeyHash(db: Queryable, connectKeyHash: string): Promise<User | null> {
  const { rows } = await db.query(`SELECT * FROM users WHERE connect_key_hash = $1`, [connectKeyHash]);
  const row = rows[0];
  return row ? toUser(row) : null;
}

export async function updateConnectKeyHash(
  db: Queryable,
  userId: string,
  connectKeyHash: string,
): Promise<User | null> {
  const { rows } = await db.query(
    `UPDATE users SET connect_key_hash = $2 WHERE id = $1 RETURNING *`,
    [userId, connectKeyHash],
  );
  const row = rows[0];
  return row ? toUser(row) : null;
}

// org_id가 NULL인 사용자만 조직에 넣는다. 이미 조직이 있으면 null — 다른 조직으로 옮기는 경로는 없다.
// 동시에 두 번 호출돼도 두 번째 UPDATE는 행 잠금 뒤 WHERE를 다시 평가해 0행이 된다.
export async function assignUserToOrg(
  db: Queryable,
  userId: string,
  orgId: string,
  orgRole: OrgRole,
): Promise<User | null> {
  const { rows } = await db.query(
    `UPDATE users SET org_id = $2, org_role = $3 WHERE id = $1 AND org_id IS NULL RETURNING *`,
    [userId, orgId, orgRole],
  );
  const row = rows[0];
  return row ? toUser(row) : null;
}

export async function findOrganizationById(db: Queryable, orgId: string): Promise<Organization | null> {
  const { rows } = await db.query(`SELECT * FROM organizations WHERE id = $1`, [orgId]);
  const row = rows[0];
  return row ? toOrganization(row) : null;
}

export async function listUsersByOrg(db: Queryable, orgId: string): Promise<User[]> {
  const { rows } = await db.query(`SELECT * FROM users WHERE org_id = $1 ORDER BY created_at ASC`, [
    orgId,
  ]);
  return rows.map(toUser);
}
