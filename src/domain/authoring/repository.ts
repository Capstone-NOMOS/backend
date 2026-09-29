import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';
import type { TeamRole } from '../roles.js';
import type { TaskKind } from './schema.js';

// 명세·태스크 작성의 SQL. **SELECT와 INSERT만 둔다** — 이 폴더는 운영 DB에 직접 쓰는 seed:tasks가 import하므로
// 지우거나 고치는 문장이 끼어들면 운영 데이터를 건드리는 경로가 생긴다(tests/seed-remote-tasks.test.ts가 폴더 전체를 검사한다).
// 수정·삭제가 필요해지면 그 함수는 이 폴더 밖(스크립트가 import하지 않는 곳)에 둔다.
//
// config/db에서는 타입만 가져온다(런타임 import는 env.ts를 끌고 온다).

export type LockedProject = { id: string; orgId: string; status: string; policyHash: string };

// 같은 프로젝트의 작성 요청을 한 줄로 세운다. 사전 검사(같은 제목·같은 명세 키)와 INSERT 사이에 다른 요청이 끼면
// 둘 다 검사를 통과해 중복이 생긴다. FOR UPDATE가 아니라 FOR NO KEY UPDATE인 이유: FOR UPDATE는 외래 키 검사의
// FOR KEY SHARE와도 충돌해, 그동안 이 프로젝트를 참조하는 모든 INSERT(이벤트·노트·제출)가 줄을 서게 된다.
// 잠근 뒤 status를 읽으므로 "planning·active만 허용" 검사도 상태 변경과 순서가 정해진다.
export async function lockProjectForAuthoring(db: Queryable, projectId: string): Promise<LockedProject | null> {
  const { rows } = await db.query(
    `SELECT id, org_id, status, policy_hash FROM projects WHERE id = $1 FOR NO KEY UPDATE`,
    [projectId],
  );
  const row = rows[0];
  return row ? { id: row.id, orgId: row.org_id, status: row.status, policyHash: row.policy_hash } : null;
}

export async function findActor(db: Queryable, userId: string): Promise<{ orgId: string | null; orgRole: string } | null> {
  const { rows } = await db.query(`SELECT org_id, org_role FROM users WHERE id = $1`, [userId]);
  const row = rows[0];
  return row ? { orgId: row.org_id, orgRole: row.org_role } : null;
}

// 검증에 필요한 프로젝트의 현재 상태를 한 번에 읽는다. validate.ts는 이것만 보고 판정한다(SQL을 모른다).
export type ProjectSnapshot = {
  repos: { id: string; fullName: string }[];
  specs: { id: string; featureKey: string }[];
  taskTitles: Set<string>;
  taskIds: Set<string>;
};

export async function loadProjectSnapshot(db: Queryable, projectId: string): Promise<ProjectSnapshot> {
  const repos = await db.query(
    `SELECT r.id, r.full_name FROM project_repos pr JOIN repos r ON r.id = pr.repo_id WHERE pr.project_id = $1`,
    [projectId],
  );
  // 개정된(superseded) 명세는 가리킬 수 없다 — 최신판만.
  const specs = await db.query(
    `SELECT id, feature_key FROM specs WHERE project_id = $1 AND superseded_by IS NULL`,
    [projectId],
  );
  const tasks = await db.query(`SELECT id, title FROM tasks WHERE project_id = $1`, [projectId]);
  return {
    repos: repos.rows.map((r) => ({ id: r.id as string, fullName: r.full_name as string })),
    specs: specs.rows.map((r) => ({ id: r.id as string, featureKey: r.feature_key as string })),
    taskTitles: new Set(tasks.rows.map((r) => r.title as string)),
    taskIds: new Set(tasks.rows.map((r) => r.id as string)),
  };
}

export type SpecTestView = { id: string; criterion: string; testCode: string; lockedAt: string | null };
export type SpecView = {
  id: string;
  featureKey: string;
  title: string;
  content: string;
  version: number;
  createdAt: string;
  tests: SpecTestView[];
};

function toSpecTest(row: QueryResultRow): SpecTestView {
  return { id: row.id, criterion: row.criterion, testCode: row.test_code, lockedAt: row.locked_at };
}

export async function insertSpec(
  db: Queryable,
  projectId: string,
  spec: { featureKey: string; title: string; content: string },
): Promise<Omit<SpecView, 'tests'>> {
  const { rows } = await db.query(
    `INSERT INTO specs (project_id, feature_key, title, content) VALUES ($1, $2, $3, $4)
     RETURNING id, feature_key, title, content, version, created_at`,
    [projectId, spec.featureKey, spec.title, spec.content],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    featureKey: row.feature_key,
    title: row.title,
    content: row.content,
    version: row.version,
    createdAt: row.created_at,
  };
}

// 잠금은 만들 때만 정한다 — locked면 지금 시각을 박는다. 나중에 잠그는 경로는 두지 않는다.
export async function insertSpecTest(
  db: Queryable,
  specId: string,
  test: { criterion: string; testCode: string; locked: boolean },
): Promise<SpecTestView> {
  const { rows } = await db.query(
    `INSERT INTO spec_tests (spec_id, criterion, test_code, locked_at)
     VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN now() END)
     RETURNING id, criterion, test_code, locked_at`,
    [specId, test.criterion, test.testCode, test.locked],
  );
  return toSpecTest(rows[0]!);
}

// plan_id는 비워 둔다 — 사람이 만든 태스크는 PM 계획(plans)에서 나온 것이 아니다. 그래서 M6b 리플레이 그룹핑에서 빠진다.
export async function insertTask(
  db: Queryable,
  projectId: string,
  task: { repoId: string; specId: string | null; title: string; kind: TaskKind; teamRole: TeamRole | null },
): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO tasks (project_id, repo_id, spec_id, title, kind, team_role, state)
     VALUES ($1, $2, $3, $4, $5, $6, 'READY') RETURNING id`,
    [projectId, task.repoId, task.specId, task.title, task.kind, task.teamRole],
  );
  return rows[0]!.id as string;
}

export async function insertTaskDependency(db: Queryable, taskId: string, dependsOn: string): Promise<void> {
  await db.query(`INSERT INTO task_deps (task_id, depends_on) VALUES ($1, $2)`, [taskId, dependsOn]);
}

// 명세 목록(시험지 포함). lockedTestsOnly면 잠긴 시험지만 — 에이전트에게는 초안을 보이지 않는다(브리핑과 같은 규칙).
export async function listSpecs(
  db: Queryable,
  projectId: string,
  options: { lockedTestsOnly: boolean },
): Promise<SpecView[]> {
  const specs = await db.query(
    `SELECT id, feature_key, title, content, version, created_at FROM specs
      WHERE project_id = $1 AND superseded_by IS NULL
      ORDER BY feature_key, version`,
    [projectId],
  );
  if (specs.rows.length === 0) return [];
  const tests = await db.query(
    `SELECT t.id, t.spec_id, t.criterion, t.test_code, t.locked_at FROM spec_tests t
      WHERE t.spec_id = ANY($1::uuid[]) AND ($2::boolean = false OR t.locked_at IS NOT NULL)
      ORDER BY t.created_at, t.id`,
    [specs.rows.map((r) => r.id), options.lockedTestsOnly],
  );
  return specs.rows.map((r) => ({
    id: r.id,
    featureKey: r.feature_key,
    title: r.title,
    content: r.content,
    version: r.version,
    createdAt: r.created_at,
    tests: tests.rows.filter((t) => t.spec_id === r.id).map(toSpecTest),
  }));
}
