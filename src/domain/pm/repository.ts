import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';
import type { PlanDraft } from './draft.js';
import type { PlanContext } from './prompt.js';

export type PlanStatus = 'pending' | 'ready' | 'failed' | 'applied' | 'rejected';
export type PlanErrorReason = 'refused' | 'truncated' | 'timeout' | 'invalid' | 'restart' | 'budget' | 'api_error';

export type PlanRow = {
  id: string;
  projectId: string;
  status: PlanStatus;
  instruction: string | null;
  feedback: string | null;
  parentPlanId: string | null;
  rootPlanId: string;
  requestedBy: string;
  mode: string | null;
  draft: PlanDraft | null;
  dagHash: string | null;
  errorReason: PlanErrorReason | null;
  errorDetail: unknown;
  inflightMaxCostUsd: string | null;
  createdAt: string;
  appliedAt: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
};

function toPlan(row: QueryResultRow): PlanRow {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    instruction: row.instruction,
    feedback: row.feedback,
    parentPlanId: row.parent_plan_id,
    rootPlanId: row.root_plan_id,
    requestedBy: row.requested_by,
    mode: row.mode,
    draft: row.dag_snapshot,
    dagHash: row.dag_hash,
    errorReason: row.error_reason,
    errorDetail: row.error_detail,
    inflightMaxCostUsd: row.inflight_max_cost_usd,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
    rejectedAt: row.rejected_at,
    rejectReason: row.reject_reason,
  };
}

export async function insertPendingPlan(
  db: Queryable,
  plan: {
    id: string;
    projectId: string;
    requestedBy: string;
    instruction: string;
    feedback: string | null;
    parentPlanId: string | null;
    rootPlanId: string;
  },
): Promise<PlanRow> {
  const { rows } = await db.query(
    `INSERT INTO plans (id, project_id, requested_by, instruction, feedback, parent_plan_id, root_plan_id, source, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'planner', 'pending') RETURNING *`,
    [plan.id, plan.projectId, plan.requestedBy, plan.instruction, plan.feedback, plan.parentPlanId, plan.rootPlanId],
  );
  return toPlan(rows[0]!);
}

export async function findPlan(db: Queryable, planId: string, options: { forUpdate?: boolean } = {}): Promise<PlanRow | null> {
  const { rows } = await db.query(`SELECT * FROM plans WHERE id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`, [planId]);
  const row = rows[0];
  return row ? toPlan(row) : null;
}

export async function listPlans(db: Queryable, projectId: string): Promise<PlanRow[]> {
  const { rows } = await db.query(`SELECT * FROM plans WHERE project_id = $1 ORDER BY created_at DESC`, [projectId]);
  return rows.map(toPlan);
}

export async function findPendingPlan(db: Queryable, projectId: string): Promise<PlanRow | null> {
  const { rows } = await db.query(`SELECT * FROM plans WHERE project_id = $1 AND status = 'pending'`, [projectId]);
  const row = rows[0];
  return row ? toPlan(row) : null;
}

export async function listAllPendingPlans(db: Queryable): Promise<PlanRow[]> {
  const { rows } = await db.query(`SELECT * FROM plans WHERE status = 'pending'`);
  return rows.map(toPlan);
}

// 수정 체인에서 이미 받은 수정 요청 수(원본 요청 제외, 실패한 수정 요청도 센다 — 요청마다 PM을 한 번 부른다).
export async function countChainRevisions(db: Queryable, rootPlanId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM plans WHERE root_plan_id = $1 AND parent_plan_id IS NOT NULL`,
    [rootPlanId],
  );
  return rows[0]!.n as number;
}

export async function chainHasAppliedPlan(db: Queryable, rootPlanId: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM plans WHERE root_plan_id = $1 AND status = 'applied' LIMIT 1`, [rootPlanId]);
  return rows.length > 0;
}

// ── 상태 전이. 전부 "지금 그 상태일 때만" 쓴다 — 이미 failed로 정리된 계획을 종료 중인 프로세스가 뒤늦게 덮어쓰지 못하게.

// 호출 직전에 이번 호출의 최대 비용을 기록한다. 끊기면(재시작·시간 제한) 이 값으로 정산한다.
export async function setInflightMaxCost(db: Queryable, planId: string, usd: number | null): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE plans SET inflight_max_cost_usd = $2 WHERE id = $1 AND status = 'pending'`,
    [planId, usd],
  );
  return rowCount === 1;
}

export async function markPlanReady(
  db: Queryable,
  planId: string,
  draft: PlanDraft,
  structure: unknown,
  dagHash: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE plans SET status = 'ready', dag_snapshot = $2, structure = $3, dag_hash = $4, mode = $5, inflight_max_cost_usd = NULL
      WHERE id = $1 AND status = 'pending'`,
    [planId, JSON.stringify(draft), JSON.stringify(structure), dagHash, draft.mode],
  );
  return rowCount === 1;
}

export async function markPlanFailed(
  db: Queryable,
  planId: string,
  reason: PlanErrorReason,
  detail: unknown,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE plans SET status = 'failed', error_reason = $2, error_detail = $3, inflight_max_cost_usd = NULL
      WHERE id = $1 AND status = 'pending'`,
    [planId, reason, JSON.stringify(detail ?? null)],
  );
  return rowCount === 1;
}

// 반려는 ready에서만. 조건부 UPDATE라 동시에 적용이 먼저 끝났으면 false다(적용은 같은 행을 FOR UPDATE로 잡고 본다).
export async function markPlanRejected(db: Queryable, planId: string, reason: string | null): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE plans SET status = 'rejected', rejected_at = now(), reject_reason = $2 WHERE id = $1 AND status = 'ready'`,
    [planId, reason],
  );
  return rowCount === 1;
}

// 역할 → 그 프로젝트에 배정된 에이전트. 역할당 에이전트는 하나다(uq_project_members_role).
export type RoleAssignee = { agentId: string; agentName: string; userId: string; nickname: string | null };

export async function listRoleAssignees(db: Queryable, projectId: string): Promise<Map<string, RoleAssignee>> {
  const { rows } = await db.query(
    `SELECT m.team_role, a.id AS agent_id, a.name AS agent_name, u.id AS user_id, u.nickname
       FROM project_members m
       JOIN agents a ON a.id = m.agent_id
       JOIN users u ON u.id = a.user_id
      WHERE m.project_id = $1`,
    [projectId],
  );
  return new Map(
    rows.map((r) => [
      r.team_role as string,
      { agentId: r.agent_id as string, agentName: r.agent_name as string, userId: r.user_id as string, nickname: (r.nickname as string | null) ?? null },
    ]),
  );
}

export async function markPlanApplied(db: Queryable, planId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE plans SET status = 'applied', applied_at = now() WHERE id = $1 AND status = 'ready'`,
    [planId],
  );
  return rowCount === 1;
}

// ── 비용

// 이 프로젝트의 PM 누적 비용(USD). 예산 검사의 기준이다.
export async function pmSpentUsd(db: Queryable, projectId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT coalesce(sum(token_cost), 0)::float8 AS usd FROM events WHERE project_id = $1 AND type = 'PM_CALL'`,
    [projectId],
  );
  return rows[0]!.usd as number;
}

export async function planCostsUsd(db: Queryable, planIds: string[]): Promise<Map<string, number>> {
  if (planIds.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT payload->>'planId' AS plan_id, sum(token_cost)::float8 AS usd FROM events
      WHERE type = 'PM_CALL' AND payload->>'planId' = ANY($1::text[])
      GROUP BY 1`,
    [planIds],
  );
  return new Map(rows.map((r) => [r.plan_id as string, r.usd as number]));
}

// ── 맥락

export type ProjectForPm = { id: string; orgId: string; name: string; deadline: string | null; pmBudgetUsd: number; policyHash: string };

export async function findProjectForPm(db: Queryable, projectId: string): Promise<ProjectForPm | null> {
  const { rows } = await db.query(
    `SELECT id, org_id, name, to_char(deadline, 'YYYY-MM-DD') AS deadline, pm_budget_usd::float8 AS pm_budget_usd, policy_hash
       FROM projects WHERE id = $1`,
    [projectId],
  );
  const r = rows[0];
  return r
    ? { id: r.id, orgId: r.org_id, name: r.name, deadline: r.deadline, pmBudgetUsd: r.pm_budget_usd, policyHash: r.policy_hash }
    : null;
}

export async function loadPlanContext(db: Queryable, project: ProjectForPm): Promise<PlanContext> {
  const repos = await db.query(
    `SELECT r.full_name, coalesce(array_agg(DISTINCT p.owner_role) FILTER (WHERE p.owner_role IS NOT NULL), '{}') AS roles
       FROM project_repos pr
       JOIN repos r ON r.id = pr.repo_id
       LEFT JOIN repo_paths p ON p.repo_id = r.id
      WHERE pr.project_id = $1
      GROUP BY r.full_name
      ORDER BY r.full_name`,
    [project.id],
  );
  const members = await db.query(
    `SELECT m.team_role, a.name FROM project_members m JOIN agents a ON a.id = m.agent_id WHERE m.project_id = $1 ORDER BY m.team_role`,
    [project.id],
  );
  const specs = await db.query(
    `SELECT feature_key, title FROM specs WHERE project_id = $1 AND superseded_by IS NULL ORDER BY feature_key`,
    [project.id],
  );
  const tasks = await db.query(`SELECT title FROM tasks WHERE project_id = $1 ORDER BY created_at`, [project.id]);
  const constitution = await db.query(`SELECT constitution FROM projects WHERE id = $1`, [project.id]);
  return {
    projectName: project.name,
    deadline: project.deadline,
    repos: repos.rows.map((r) => ({ fullName: r.full_name as string, ownerRoles: r.roles as string[] })),
    members: members.rows.map((m) => ({ teamRole: m.team_role as string, agentName: m.name as string })),
    existingSpecs: specs.rows.map((s) => ({ featureKey: s.feature_key as string, title: s.title as string })),
    existingTaskTitles: tasks.rows.map((t) => t.title as string),
    constitution: constitution.rows[0]?.constitution ?? {},
  };
}
