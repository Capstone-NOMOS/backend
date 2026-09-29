import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';
import type { TeamRole } from '../roles.js';

export type AutonomyPreset = 'L1' | 'L2' | 'L3' | 'L4';

export type Project = {
  id: string;
  orgId: string;
  name: string;
  autonomyPreset: AutonomyPreset;
  policyHash: string;
  constitutionHash: string | null;
  pmBudgetUsd: string;
  budgetUsd: string | null;
  deadline: string | null;
  status: string;
  startedAt: string | null;
  createdBy: string;
  createdAt: string;
};

// `date` 컬럼은 pg가 JS Date(로컬 자정)로 파싱한다. 그대로 JSON에 실으면 UTC 타임스탬프가 되어
// KST 서버에서는 하루 빠른 날짜가 나간다 — 입력 '2026-10-31'이 응답 '2026-10-30T15:00:00.000Z'로 보였다.
// 마감일은 시각이 아니라 날짜이므로 받은 형식(YYYY-MM-DD) 그대로 돌려준다.
// 전역 타입 파서로 바꾸지 말 것 — 나중에 추가되는 모든 date 컬럼에 조용히 영향을 준다.
function toDateString(value: unknown): string | null {
  if (value instanceof Date) {
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  // 파서가 문자열을 주는 경우(설정 변경·이미 잘린 값)도 날짜 부분만 남긴다.
  return typeof value === 'string' ? value.slice(0, 10) : null;
}

function toProject(row: QueryResultRow): Project {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    autonomyPreset: row.autonomy_preset,
    policyHash: row.policy_hash,
    constitutionHash: row.constitution_hash,
    pmBudgetUsd: row.pm_budget_usd,
    budgetUsd: row.budget_usd,
    deadline: toDateString(row.deadline),
    status: row.status,
    startedAt: row.started_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// policy_hash는 NOT NULL인데 계산하려면 project_policies가 먼저 있어야 한다.
// 그래서 자리값으로 넣고 같은 트랜잭션에서 recomputeProjectPolicyHash가 덮어쓴다 —
// 트랜잭션 밖으로는 자리값이 절대 보이지 않는다.
export async function insertProject(
  db: Queryable,
  input: {
    orgId: string;
    name: string;
    autonomyPreset: AutonomyPreset;
    pmBudgetUsd: number;
    budgetUsd: number | null;
    deadline: string | null;
    constitution: unknown;
    constitutionHash: string;
    createdBy: string;
  },
): Promise<Project> {
  const { rows } = await db.query(
    `INSERT INTO projects (org_id, name, autonomy_preset, policy_hash, constitution, constitution_hash,
                           pm_budget_usd, budget_usd, deadline, status, created_by)
     VALUES ($1, $2, $3, 'pending', $4::jsonb, $5, $6, $7, $8, 'planning', $9)
     RETURNING *`,
    [
      input.orgId,
      input.name,
      input.autonomyPreset,
      JSON.stringify(input.constitution ?? {}),
      input.constitutionHash,
      input.pmBudgetUsd,
      input.budgetUsd,
      input.deadline,
      input.createdBy,
    ],
  );
  return toProject(rows[0]!);
}

// 프로젝트 목록. userId를 주면 그 사람의 에이전트가 배정된 프로젝트만 — "볼 수 있는가"는
// visibility.ts(대표는 전체, 팀원은 배정된 것만)와 같은 정의다.
export async function listProjectsByOrg(
  db: Queryable,
  orgId: string,
  onlyForUserId: string | null,
): Promise<Project[]> {
  const { rows } = await db.query(
    `SELECT p.* FROM projects p
      WHERE p.org_id = $1
        AND ($2::uuid IS NULL OR EXISTS (
              SELECT 1 FROM project_members m JOIN agents a ON a.id = m.agent_id
               WHERE m.project_id = p.id AND a.user_id = $2))
      ORDER BY p.created_at DESC`,
    [orgId, onlyForUserId],
  );
  return rows.map(toProject);
}

// 에이전트가 이미 맡고 있는 진행 중 프로젝트(이 프로젝트 제외). policy/repository.ts의 findAgentMembership과
// 같은 "진행 중" 정의(completed·aborted 제외)를 쓴다 — 어긋나면 토큰이 다른 프로젝트를 가리킨다.
export async function findOtherActiveAssignment(
  db: Queryable,
  agentId: string,
  exceptProjectId: string,
): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT m.project_id FROM project_members m
       JOIN projects p ON p.id = m.project_id
      WHERE m.agent_id = $1 AND m.project_id <> $2 AND p.status NOT IN ('completed', 'aborted')
      LIMIT 1`,
    [agentId, exceptProjectId],
  );
  return rows[0]?.project_id ?? null;
}

export async function findProjectById(db: Queryable, projectId: string): Promise<Project | null> {
  const { rows } = await db.query(`SELECT * FROM projects WHERE id = $1`, [projectId]);
  const row = rows[0];
  return row ? toProject(row) : null;
}

export async function linkProjectRepos(db: Queryable, projectId: string, repoIds: string[]): Promise<void> {
  await db.query(
    `INSERT INTO project_repos (project_id, repo_id) SELECT $1, unnest($2::uuid[])`,
    [projectId, repoIds],
  );
}

// 허용 레벨의 해당 열을 그대로 복사한다. 이후 판정은 이 사본만 본다(리플레이 재현성).
// 열 이름을 문자열로 이어붙이지 않고 CASE로 고른다 — 바인딩만 쓴다는 규칙을 지키기 위해서다.
// lock_key도 함께 복사해야 007의 복합 FK가 🔒 위조를 막을 수 있다.
export async function copyPoliciesFromCatalog(
  db: Queryable,
  projectId: string,
  preset: AutonomyPreset,
): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO project_policies (project_id, action_key, mode, lock_key)
     SELECT $1, action_key,
            CASE $2::text
              WHEN 'L1' THEN mode_l1
              WHEN 'L2' THEN mode_l2
              WHEN 'L3' THEN mode_l3
              ELSE mode_l4
            END,
            lock_key
       FROM action_catalog`,
    [projectId, preset],
  );
  return rowCount ?? 0;
}

export async function findOrgConstitution(db: Queryable, orgId: string): Promise<unknown> {
  const { rows } = await db.query(`SELECT constitution FROM organizations WHERE id = $1`, [orgId]);
  return rows[0]?.constitution ?? {};
}

export type RepoRow = { id: string; orgId: string; fullName: string };

export async function findReposByIds(db: Queryable, repoIds: string[]): Promise<RepoRow[]> {
  const { rows } = await db.query(
    `SELECT id, org_id, full_name FROM repos WHERE id = ANY($1::uuid[])`,
    [repoIds],
  );
  return rows.map((r) => ({ id: r.id, orgId: r.org_id, fullName: r.full_name }));
}

// 소유 역할이 지정된 경로 규칙이 하나도 없는 레포. 시드 15행은 전부 owner_role이 NULL이므로
// 연결만 하고 소유권을 안 정한 레포가 여기 걸린다. 입력 순서를 유지해 메시지가 결정적이게 한다.
export async function findReposWithoutOwnership(db: Queryable, repoIds: string[]): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT r.id FROM unnest($1::uuid[]) WITH ORDINALITY AS r(id, ord)
      WHERE NOT EXISTS (
        SELECT 1 FROM repo_paths p WHERE p.repo_id = r.id AND p.owner_role IS NOT NULL
      )
      ORDER BY r.ord`,
    [repoIds],
  );
  return rows.map((r) => r.id as string);
}

// 진행 중(planning·active) 프로젝트가 이미 쓰고 있는 레포. 겹치면 경로 소유권이 두 프로젝트에 걸린다.
export async function findReposInActiveProjects(
  db: Queryable,
  repoIds: string[],
): Promise<{ repoId: string; projectId: string }[]> {
  const { rows } = await db.query(
    `SELECT pr.repo_id, pr.project_id FROM project_repos pr
       JOIN projects p ON p.id = pr.project_id
      WHERE pr.repo_id = ANY($1::uuid[]) AND p.status IN ('planning', 'active')`,
    [repoIds],
  );
  return rows.map((r) => ({ repoId: r.repo_id, projectId: r.project_id }));
}

export async function listProjectRepos(db: Queryable, projectId: string): Promise<RepoRow[]> {
  const { rows } = await db.query(
    `SELECT r.id, r.org_id, r.full_name FROM project_repos pr
       JOIN repos r ON r.id = pr.repo_id
      WHERE pr.project_id = $1
      ORDER BY r.full_name`,
    [projectId],
  );
  return rows.map((r) => ({ id: r.id, orgId: r.org_id, fullName: r.full_name }));
}

export type ProjectMember = { agentId: string; agentName: string; teamRole: TeamRole; userId: string };

export async function listProjectMembers(db: Queryable, projectId: string): Promise<ProjectMember[]> {
  const { rows } = await db.query(
    `SELECT m.agent_id, m.team_role, a.name, a.user_id FROM project_members m
       JOIN agents a ON a.id = m.agent_id
      WHERE m.project_id = $1
      ORDER BY m.team_role`,
    [projectId],
  );
  return rows.map((r) => ({
    agentId: r.agent_id,
    agentName: r.name,
    teamRole: r.team_role as TeamRole,
    userId: r.user_id,
  }));
}

export async function insertProjectMember(
  db: Queryable,
  projectId: string,
  agentId: string,
  teamRole: TeamRole,
): Promise<void> {
  await db.query(
    `INSERT INTO project_members (project_id, agent_id, team_role) VALUES ($1, $2, $3)`,
    [projectId, agentId, teamRole],
  );
}

export async function deleteProjectMember(
  db: Queryable,
  projectId: string,
  agentId: string,
): Promise<TeamRole | null> {
  const { rows } = await db.query(
    `DELETE FROM project_members WHERE project_id = $1 AND agent_id = $2 RETURNING team_role`,
    [projectId, agentId],
  );
  return rows[0]?.team_role ?? null;
}

export async function findAgentOrg(db: Queryable, agentId: string): Promise<string | null | undefined> {
  const { rows } = await db.query(`SELECT org_id FROM agents WHERE id = $1`, [agentId]);
  return rows.length === 0 ? undefined : (rows[0]!.org_id as string | null);
}
