import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';
import { asRepoId, asRepoPathId } from '../ids.js';
import type { RepoPath } from '../repo/types.js';
import type { TeamRole } from '../roles.js';
import type { PolicyMode } from './pm-review-fallback.js';

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

export type ProjectAuthRow = {
  status: string;
  policyHash: string;
  orgId: string;
  startedAt: string | null;
};

// 0a·0b단계가 매 요청 읽는 최소 정보. 정지 상태와 정책 해시는 토큰이 아니라 DB가 정본이다.
export async function findProjectAuthRow(db: Queryable, projectId: string): Promise<ProjectAuthRow | null> {
  const { rows } = await db.query(
    `SELECT status, policy_hash, org_id, started_at FROM projects WHERE id = $1`,
    [projectId],
  );
  const row = rows[0];
  return row
    ? { status: row.status, policyHash: row.policy_hash, orgId: row.org_id, startedAt: row.started_at }
    : null;
}

// 프로젝트에 묶인 모든 레포의 경로 규칙. 해시 재현성을 위해 정렬이 결정적이어야 한다.
export async function listProjectRepoPaths(db: Queryable, projectId: string): Promise<RepoPath[]> {
  const { rows } = await db.query(
    `SELECT p.* FROM repo_paths p
       JOIN project_repos pr ON pr.repo_id = p.repo_id
      WHERE pr.project_id = $1
      ORDER BY p.repo_id, p.priority`,
    [projectId],
  );
  return rows.map(toRepoPath);
}

export type PolicyRow = { actionKey: string; mode: PolicyMode; lockKey: string };

export async function listProjectPolicies(db: Queryable, projectId: string): Promise<PolicyRow[]> {
  const { rows } = await db.query(
    `SELECT action_key, mode, lock_key FROM project_policies WHERE project_id = $1 ORDER BY action_key`,
    [projectId],
  );
  return rows.map((r) => ({ actionKey: r.action_key, mode: r.mode as PolicyMode, lockKey: r.lock_key }));
}

export async function findConstitutionHash(db: Queryable, projectId: string): Promise<string | null> {
  const { rows } = await db.query(`SELECT constitution_hash FROM projects WHERE id = $1`, [projectId]);
  return rows[0]?.constitution_hash ?? null;
}

export async function updateProjectPolicyHash(db: Queryable, projectId: string, hash: string): Promise<void> {
  await db.query(`UPDATE projects SET policy_hash = $2 WHERE id = $1`, [projectId, hash]);
}

// 이 레포를 쓰는 프로젝트들. 경로 규칙이 바뀌면 이들의 policy_hash를 다시 계산해야 한다.
export async function listProjectIdsByRepo(db: Queryable, repoId: string): Promise<string[]> {
  const { rows } = await db.query(`SELECT project_id FROM project_repos WHERE repo_id = $1`, [repoId]);
  return rows.map((r) => r.project_id as string);
}

export type AgentMembership = { projectId: string; teamRole: TeamRole };

// 에이전트가 속한 진행 중 프로젝트. v1은 에이전트당 활성 프로젝트 1개를 가정하고,
// 혹시 여러 개면 가장 최근 것을 결정적으로 고른다 (정렬 없이 고르면 토큰 내용이 요청마다 흔들린다).
export async function findAgentMembership(db: Queryable, agentId: string): Promise<AgentMembership | null> {
  const { rows } = await db.query(
    `SELECT m.project_id, m.team_role FROM project_members m
       JOIN projects p ON p.id = m.project_id
      WHERE m.agent_id = $1 AND p.status NOT IN ('completed', 'aborted')
      ORDER BY p.created_at DESC
      LIMIT 1`,
    [agentId],
  );
  const row = rows[0];
  return row ? { projectId: row.project_id, teamRole: row.team_role as TeamRole } : null;
}
