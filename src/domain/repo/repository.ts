import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';
import { AppError } from '../../errors.js';
import { asOrgId, asRepoId, asRepoPathId, type OrgId, type RepoId } from '../ids.js';
import type { SeedPathRule } from './seed-paths.js';
import type { OwnerRole, PathSource, RepoPath } from './types.js';

export type Repo = {
  id: RepoId;
  orgId: OrgId;
  fullName: string;
  githubRepoId: number | null;
  defaultBranch: string;
  // 서버가 커밋 diff를 읽을 곳(V3). NULL이면 V3는 SKIPPED로 기록된다.
  cloneUrl: string | null;
  // 배포된 개발 서버 주소(V1B). NULL이면 V1B는 SKIPPED.
  devBaseUrl: string | null;
  // 기능 완료 시 머지 대상. 브릿지는 여기로 push하지 않는다(태스크 브랜치에만 push).
  devBranch: string;
  createdAt: string;
};

// PostgreSQL unique_violation 에러 코드(23505) 여부를 판별한다.
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === '23505';
}

function violatedConstraint(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const constraint = (err as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

function toRepo(row: QueryResultRow): Repo {
  return {
    id: asRepoId(row.id),
    orgId: asOrgId(row.org_id),
    fullName: row.full_name,
    githubRepoId: row.github_repo_id === null ? null : Number(row.github_repo_id),
    defaultBranch: row.default_branch,
    cloneUrl: row.clone_url ?? null,
    devBaseUrl: row.dev_base_url ?? null,
    devBranch: row.dev_branch,
    createdAt: row.created_at,
  };
}

function toRepoPath(row: QueryResultRow): RepoPath {
  return {
    id: asRepoPathId(row.id),
    repoId: asRepoId(row.repo_id),
    pathPattern: row.path_pattern,
    ownerRole: row.owner_role,
    access: row.access,
    actionKey: row.action_key,
    priority: row.priority,
    source: row.source,
    createdAt: row.created_at,
  };
}

// repos 한 행을 INSERT한다. (org_id, full_name) 중복이면 REPO_ALREADY_CONNECTED(409).
export async function insertRepo(
  db: Queryable,
  input: { orgId: string; fullName: string; githubRepoId?: number; defaultBranch?: string },
): Promise<Repo> {
  try {
    const { rows } = await db.query(
      `INSERT INTO repos (id, org_id, full_name, github_repo_id, default_branch)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [randomUUID(), input.orgId, input.fullName, input.githubRepoId ?? null, input.defaultBranch ?? 'main'],
    );
    const row = rows[0];
    if (!row) throw new Error('insertRepo: insert returned no row');
    return toRepo(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError('REPO_ALREADY_CONNECTED', `repo "${input.fullName}" is already connected`);
    }
    throw err;
  }
}

// repo_id + org_id로 레포를 조회한다. org_id 조건이 CROSS_ORG_ACCESS 방지의 핵심이다.
export async function findRepoByIdForOrg(db: Queryable, orgId: string, repoId: string): Promise<Repo | null> {
  const { rows } = await db.query(`SELECT * FROM repos WHERE id = $1 AND org_id = $2`, [repoId, orgId]);
  const row = rows[0];
  return row ? toRepo(row) : null;
}

// 조직에 연결된 모든 레포를 조회한다. members의 GitHub collaborator 확인에 쓰인다.
export async function listReposByOrg(db: Queryable, orgId: string): Promise<Repo[]> {
  const { rows } = await db.query(`SELECT * FROM repos WHERE org_id = $1 ORDER BY created_at ASC`, [orgId]);
  return rows.map(toRepo);
}

// 소유 역할이 하나라도 지정된 레포 id. project/repository.ts의 findReposWithoutOwnership과 같은 기준
// (owner_role이 NULL이 아닌 규칙이 있는가) — 목록의 표시와 프로젝트 생성의 422가 같은 답을 내야 한다.
export async function listRepoIdsWithOwnership(db: Queryable, orgId: string): Promise<Set<string>> {
  const { rows } = await db.query(
    `SELECT DISTINCT r.id FROM repos r
       JOIN repo_paths p ON p.repo_id = r.id AND p.owner_role IS NOT NULL
      WHERE r.org_id = $1`,
    [orgId],
  );
  return new Set(rows.map((row) => row.id as string));
}

// org 필터 없이 repo_id만으로 조회한다. "존재하지 않음(404)"과 "다른 조직 소유(403)"를
// 구분해야 하는 호출부(assertRepoInOrg)에서만 쓴다.
// 레포 설정(github_repo_id·clone_url) 변경. 넘긴 키만 바꾼다 — undefined는 그대로, null은 비운다.
export async function updateRepoSettings(
  db: Queryable,
  repoId: string,
  updates: { githubRepoId?: number | null; cloneUrl?: string | null },
): Promise<Repo> {
  const setClauses: string[] = [];
  const values: unknown[] = [repoId];
  if (updates.githubRepoId !== undefined) {
    values.push(updates.githubRepoId);
    setClauses.push(`github_repo_id = $${values.length}`);
  }
  if (updates.cloneUrl !== undefined) {
    values.push(updates.cloneUrl);
    setClauses.push(`clone_url = $${values.length}`);
  }
  const sql =
    setClauses.length === 0
      ? `SELECT * FROM repos WHERE id = $1`
      : `UPDATE repos SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`;
  const { rows } = await db.query(sql, values);
  const row = rows[0];
  if (!row) throw new Error('updateRepoSettings: no row');
  return toRepo(row);
}

// 같은 조직에서 이 GitHub 레포를 이미 가리키는 다른 레포 행. 둘이 같은 GitHub 레포를 가리키면
// V3가 엉뚱한 레포 행의 규칙으로 판정하게 된다.
export async function findOtherRepoByGithubId(
  db: Queryable,
  orgId: string,
  githubRepoId: number,
  exceptRepoId: string,
): Promise<Repo | null> {
  const { rows } = await db.query(
    `SELECT * FROM repos WHERE org_id = $1 AND github_repo_id = $2 AND id <> $3 LIMIT 1`,
    [orgId, githubRepoId, exceptRepoId],
  );
  return rows[0] ? toRepo(rows[0]) : null;
}

export async function findRepoById(db: Queryable, repoId: string): Promise<Repo | null> {
  const { rows } = await db.query(`SELECT * FROM repos WHERE id = $1`, [repoId]);
  const row = rows[0];
  return row ? toRepo(row) : null;
}

// 레포 연결 시 seed-paths.ts에 정의된 규칙들을 repo_paths에 일괄 삽입한다 (source='seed').
export async function insertSeedRepoPaths(
  db: Queryable,
  repoId: string,
  rules: readonly SeedPathRule[],
): Promise<RepoPath[]> {
  const inserted: RepoPath[] = [];
  for (const rule of rules) {
    const { rows } = await db.query(
      `INSERT INTO repo_paths (id, repo_id, path_pattern, owner_role, access, action_key, priority, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'seed') RETURNING *`,
      [randomUUID(), repoId, rule.pathPattern, rule.ownerRole, rule.access, rule.actionKey, rule.priority],
    );
    const row = rows[0];
    if (!row) throw new Error('insertSeedRepoPaths: insert returned no row');
    inserted.push(toRepoPath(row));
  }
  return inserted;
}

// [min, max] 대역에서 이미 쓰인 가장 큰 priority. 비어 있으면 null.
export async function maxPriorityInBand(
  db: Queryable,
  repoId: string,
  min: number,
  max: number,
): Promise<number | null> {
  const { rows } = await db.query(
    `SELECT max(priority) AS max FROM repo_paths WHERE repo_id = $1 AND priority BETWEEN $2 AND $3`,
    [repoId, min, max],
  );
  const value = rows[0]?.max;
  return value === null || value === undefined ? null : Number(value);
}

// 대표가 손으로 추가하는 경로 규칙 하나를 INSERT한다.
// (repo_id, path_pattern) 중복이면 PATH_PATTERN_DUPLICATE, (repo_id, priority) 중복이면 PATH_PRIORITY_TAKEN(409).
export async function insertRepoPath(
  db: Queryable,
  input: {
    repoId: string;
    pathPattern: string;
    ownerRole: OwnerRole | null;
    access: 'write' | 'read' | 'denied';
    actionKey: string | null;
    priority: number;
    source: PathSource;
  },
): Promise<RepoPath> {
  try {
    const { rows } = await db.query(
      `INSERT INTO repo_paths (id, repo_id, path_pattern, owner_role, access, action_key, priority, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        randomUUID(),
        input.repoId,
        input.pathPattern,
        input.ownerRole,
        input.access,
        input.actionKey,
        input.priority,
        input.source,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('insertRepoPath: insert returned no row');
    return toRepoPath(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      if (violatedConstraint(err) === 'uq_repo_paths_priority') {
        throw new AppError('PATH_PRIORITY_TAKEN', `priority ${input.priority} is already used on this repo`);
      }
      throw new AppError('PATH_PATTERN_DUPLICATE', `path pattern "${input.pathPattern}" already exists on this repo`);
    }
    throw err;
  }
}

// 레포의 경로 규칙 목록을 priority 내림차순으로 조회한다.
export async function listRepoPaths(db: Queryable, repoId: string): Promise<RepoPath[]> {
  const { rows } = await db.query(`SELECT * FROM repo_paths WHERE repo_id = $1 ORDER BY priority DESC`, [
    repoId,
  ]);
  return rows.map(toRepoPath);
}

// repo_id로 스코프를 좁혀 경로 규칙 하나를 조회한다 (repoId는 호출자가 이미 org 소유를 검증한 값).
export async function findRepoPathById(db: Queryable, repoId: string, pathId: string): Promise<RepoPath | null> {
  const { rows } = await db.query(`SELECT * FROM repo_paths WHERE id = $1 AND repo_id = $2`, [
    pathId,
    repoId,
  ]);
  const row = rows[0];
  return row ? toRepoPath(row) : null;
}

// 경로 규칙의 owner_role / access만 부분 수정한다. action_key, priority는 이 함수로 건드릴 수 없다.
// updates에 키가 아예 없으면 해당 컬럼은 건드리지 않고, ownerRole: null처럼 명시적으로 준
// 값은 그대로 반영한다 (COALESCE를 쓰면 "값을 null로 지운다"와 "안 건드린다"를 구분할 수 없다).
export async function updateRepoPathOwnership(
  db: Queryable,
  pathId: string,
  updates: { ownerRole?: OwnerRole | null; access?: 'write' | 'read' | 'denied' },
): Promise<RepoPath> {
  const setClauses: string[] = [];
  const values: unknown[] = [pathId];

  if ('ownerRole' in updates) {
    values.push(updates.ownerRole);
    setClauses.push(`owner_role = $${values.length}`);
  }
  if ('access' in updates) {
    values.push(updates.access);
    setClauses.push(`access = $${values.length}`);
  }

  const sql =
    setClauses.length === 0
      ? `SELECT * FROM repo_paths WHERE id = $1`
      : `UPDATE repo_paths SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`;

  const { rows } = await db.query(sql, values);
  const row = rows[0];
  if (!row) throw new Error('updateRepoPathOwnership: update returned no row');
  return toRepoPath(row);
}
