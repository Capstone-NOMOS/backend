import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';

// API 계약(023). 상태 전이는 전부 "지금 그 상태일 때만" 쓴다 — 두 번 누르기·늦게 온 초안이 덮어쓰지 못하게.

export type ContractStatus = 'pending' | 'draft' | 'approved' | 'failed';

export type ContractView = {
  id: string;
  projectId: string;
  specId: string;
  featureKey: string;
  specTitle: string;
  status: ContractStatus;
  attempt: number;
  feedback: string | null;
  schemaYaml: string | null;
  summary: string | null;
  openQuestions: string[];
  draftedByAgentId: string | null;
  draftedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  errorReason: string | null;
  createdAt: string;
  updatedAt: string;
};

function toContract(row: QueryResultRow): ContractView {
  return {
    id: row.id,
    projectId: row.project_id,
    specId: row.spec_id,
    featureKey: row.feature_key,
    specTitle: row.spec_title,
    status: row.status,
    attempt: row.attempt,
    feedback: row.feedback ?? null,
    schemaYaml: row.schema_yaml ?? null,
    summary: row.summary ?? null,
    openQuestions: (row.open_questions as string[] | null) ?? [],
    draftedByAgentId: row.drafted_by_agent ?? null,
    draftedAt: row.drafted_at ?? null,
    approvedBy: row.approved_by ?? null,
    approvedAt: row.approved_at ?? null,
    errorReason: row.error_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = `SELECT c.*, s.feature_key, s.title AS spec_title FROM contracts c JOIN specs s ON s.id = c.spec_id`;

// 기능 명세를 확정한 그 트랜잭션에서 API가 필요한 명세마다 작성 대기 계약을 만든다. 이미 있으면 건너뛴다.
export async function insertPendingContracts(db: Queryable, projectId: string, specIds: string[]): Promise<string[]> {
  if (specIds.length === 0) return [];
  const { rows } = await db.query(
    `INSERT INTO contracts (project_id, spec_id) SELECT $1, unnest($2::uuid[])
     ON CONFLICT (spec_id) DO NOTHING RETURNING id`,
    [projectId, specIds],
  );
  return rows.map((r) => r.id as string);
}

export async function listContracts(db: Queryable, projectId: string): Promise<ContractView[]> {
  const { rows } = await db.query(`${SELECT} WHERE c.project_id = $1 ORDER BY s.feature_key`, [projectId]);
  return rows.map(toContract);
}

export async function findContract(db: Queryable, contractId: string, options: { forUpdate?: boolean } = {}): Promise<ContractView | null> {
  const { rows } = await db.query(`${SELECT} WHERE c.id = $1${options.forUpdate ? ' FOR UPDATE OF c' : ''}`, [contractId]);
  return rows[0] ? toContract(rows[0]) : null;
}

// BE 노트북이 쓸 작업 — 작성 대기 계약과, 그 기능 명세 본문·오가는 데이터.
export type ContractJob = ContractView & { specContent: string; apiNeeds: string | null };

export async function listPendingContractJobs(db: Queryable, projectId: string): Promise<ContractJob[]> {
  const { rows } = await db.query(
    `SELECT c.*, s.feature_key, s.title AS spec_title, s.content AS spec_content, s.api_needs
       FROM contracts c JOIN specs s ON s.id = c.spec_id
      WHERE c.project_id = $1 AND c.status = 'pending'
      ORDER BY s.feature_key`,
    [projectId],
  );
  return rows.map((r) => ({ ...toContract(r), specContent: r.spec_content as string, apiNeeds: (r.api_needs as string | null) ?? null }));
}

export async function markContractDrafted(
  db: Queryable,
  input: { contractId: string; attempt: number; schemaYaml: string; summary: string; openQuestions: string[]; agentId: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE contracts SET status = 'draft', schema_yaml = $3, summary = $4, open_questions = $5, drafted_by_agent = $6,
            drafted_at = now(), error_reason = NULL, updated_at = now()
      WHERE id = $1 AND status = 'pending' AND attempt = $2`,
    [input.contractId, input.attempt, input.schemaYaml, input.summary, JSON.stringify(input.openQuestions), input.agentId],
  );
  return rowCount === 1;
}

export async function markContractFailed(db: Queryable, contractId: string, attempt: number, reason: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE contracts SET status = 'failed', error_reason = $3, updated_at = now() WHERE id = $1 AND status = 'pending' AND attempt = $2`,
    [contractId, attempt, reason],
  );
  return rowCount === 1;
}

export async function markContractApproved(db: Queryable, contractId: string, userId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE contracts SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1 AND status = 'draft'`,
    [contractId, userId],
  );
  return rowCount === 1;
}

// 수정 요청(초안·실패에서) — 다음 회차로 다시 작성 대기. 초안은 다음 작성의 "이전 초안"으로 남긴다.
export async function requestContractRedraft(db: Queryable, contractId: string, feedback: string | null): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE contracts SET status = 'pending', attempt = attempt + 1, feedback = $2, error_reason = NULL, updated_at = now()
      WHERE id = $1 AND status IN ('draft', 'failed')`,
    [contractId, feedback],
  );
  return rowCount === 1;
}

// 확정한 계약들(같은 프로젝트) — 새 계약을 쓸 때 앞서 정한 경로·형식과 맞추라고 함께 준다.
export async function listApprovedContracts(db: Queryable, projectId: string): Promise<{ featureKey: string; title: string; schemaYaml: string }[]> {
  const { rows } = await db.query(
    `SELECT s.feature_key, s.title, c.schema_yaml FROM contracts c JOIN specs s ON s.id = c.spec_id
      WHERE c.project_id = $1 AND c.status = 'approved' ORDER BY s.feature_key`,
    [projectId],
  );
  return rows.map((r) => ({ featureKey: r.feature_key as string, title: r.title as string, schemaYaml: r.schema_yaml as string }));
}

// 계약을 확정할 사람 — 이 프로젝트의 BACKEND 역할 담당(에이전트 주인). 없으면 null(대표가 대신한다).
export async function findBackendOwner(db: Queryable, projectId: string): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT m.user_id FROM project_members m WHERE m.project_id = $1 AND m.team_role = 'BACKEND'`,
    [projectId],
  );
  return (rows[0]?.user_id as string | undefined) ?? null;
}

// BE 에이전트가 읽을 레포 — BACKEND가 소유 규칙을 가진 프로젝트 레포(상담 실행과 같은 기준).
export async function listBackendRepos(db: Queryable, projectId: string): Promise<{ id: string; fullName: string; cloneUrl: string | null; defaultBranch: string }[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT r.id, r.full_name, r.clone_url, r.default_branch FROM project_repos pr
       JOIN repos r ON r.id = pr.repo_id
       JOIN repo_paths p ON p.repo_id = r.id AND p.owner_role = 'BACKEND'
      WHERE pr.project_id = $1
      ORDER BY r.full_name`,
    [projectId],
  );
  return rows.map((r) => ({ id: r.id as string, fullName: r.full_name as string, cloneUrl: (r.clone_url as string | null) ?? null, defaultBranch: r.default_branch as string }));
}

// 태스크 브리핑에 실을 계약 — 그 명세의 확정한 계약(FE·BE 둘 다 같은 계약을 받는다).
export async function findApprovedContractForSpec(
  db: Queryable,
  specId: string,
): Promise<{ id: string; featureKey: string; summary: string; schemaYaml: string } | null> {
  const { rows } = await db.query(
    `SELECT c.id, s.feature_key, c.summary, c.schema_yaml FROM contracts c JOIN specs s ON s.id = c.spec_id
      WHERE c.spec_id = $1 AND c.status = 'approved'`,
    [specId],
  );
  const r = rows[0];
  return r ? { id: r.id as string, featureKey: r.feature_key as string, summary: (r.summary as string | null) ?? '', schemaYaml: r.schema_yaml as string } : null;
}

// 프로젝트 시작 조건: 끝나지 않은 태스크가 붙은, API가 필요한 명세 중 계약이 확정되지 않은 것.
export async function listUnconfirmedContractsForOpenTasks(db: Queryable, projectId: string): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT s.feature_key FROM specs s
       JOIN tasks t ON t.spec_id = s.id AND t.state NOT IN ('DONE', 'CANCELLED')
       LEFT JOIN contracts c ON c.spec_id = s.id AND c.status = 'approved'
      WHERE s.project_id = $1 AND s.needs_api AND c.id IS NULL
      ORDER BY s.feature_key`,
    [projectId],
  );
  return rows.map((r) => r.feature_key as string);
}
