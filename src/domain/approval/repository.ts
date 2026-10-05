import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';

// 승인 대기열(015). SQL만 둔다.

export type ApprovalGate = 'G1' | 'G2' | 'G3' | 'ACTION';
export type ApprovalDecision = 'APPROVE' | 'REJECT';
export type ApprovalStatusFilter = 'pending' | 'decided' | 'all';

export type ApprovalRow = {
  id: string;
  projectId: string;
  gate: ApprovalGate;
  subjectId: string;
  artifactId: string | null;
  gateMode: string | null;
  payload: Record<string, unknown>;
  decision: ApprovalDecision | null;
  decidedBy: string | null;
  reason: string | null;
  requestedAt: string;
  decidedAt: string | null;
};

// 목록용 — 지금 상태(태스크 제목·상태, 프로젝트 이름)를 함께 붙인다. 카드의 스냅샷은 payload에 따로 있다.
export type ApprovalView = Omit<ApprovalRow, 'subjectId'> & {
  projectName: string;
  taskId: string;
  taskTitle: string | null;
  taskState: string | null;
};

const toIso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

function toApproval(row: QueryResultRow): ApprovalRow {
  return {
    id: row.id,
    projectId: row.project_id,
    gate: row.gate,
    subjectId: row.subject_id,
    artifactId: row.artifact_id ?? null,
    gateMode: row.gate_mode ?? null,
    payload: row.payload,
    decision: row.decision ?? null,
    decidedBy: row.decided_by ?? null,
    reason: row.reason ?? null,
    requestedAt: toIso(row.requested_at)!,
    decidedAt: toIso(row.decided_at),
  };
}

export async function insertApproval(
  db: Queryable,
  input: { projectId: string; gate: ApprovalGate; subjectId: string; artifactId: string; gateMode: string; payload: Record<string, unknown> },
): Promise<ApprovalRow> {
  const { rows } = await db.query(
    `INSERT INTO approvals (project_id, gate, subject_id, artifact_id, gate_mode, payload)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.projectId, input.gate, input.subjectId, input.artifactId, input.gateMode, input.payload],
  );
  return toApproval(rows[0]!);
}

export async function findApprovalForUpdate(db: Queryable, approvalId: string): Promise<(ApprovalRow & { orgId: string }) | null> {
  const { rows } = await db.query(
    `SELECT a.*, p.org_id FROM approvals a JOIN projects p ON p.id = a.project_id WHERE a.id = $1 FOR UPDATE OF a`,
    [approvalId],
  );
  const row = rows[0];
  return row ? { ...toApproval(row), orgId: row.org_id as string } : null;
}

// 결정은 한 번뿐 — 대기 중일 때만 바뀐다. 동시에 승인·반려가 눌려도 한쪽만 이긴다.
export async function decideApproval(
  db: Queryable,
  approvalId: string,
  decision: ApprovalDecision,
  decidedBy: string,
  reason: string | null,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE approvals SET decision = $2, decided_by = $3, reason = $4, decided_at = now()
      WHERE id = $1 AND decision IS NULL`,
    [approvalId, decision, decidedBy, reason],
  );
  return rowCount === 1;
}

// 승인·반려 직전에 태스크 행을 잠그고 상태와 담당 에이전트의 주인을 읽는다.
export async function lockApprovalTask(
  db: Queryable,
  taskId: string,
): Promise<{ state: string; assigneeAgentId: string | null; assigneeOwnerId: string | null } | null> {
  const { rows } = await db.query(
    `SELECT t.state, t.assignee_agent_id, a.user_id AS owner_id
       FROM tasks t LEFT JOIN agents a ON a.id = t.assignee_agent_id
      WHERE t.id = $1
      FOR UPDATE OF t`,
    [taskId],
  );
  const row = rows[0];
  return row
    ? { state: row.state as string, assigneeAgentId: (row.assignee_agent_id as string | null) ?? null, assigneeOwnerId: (row.owner_id as string | null) ?? null }
    : null;
}

export async function listApprovals(
  db: Queryable,
  filter: { orgId?: string; projectId?: string; status: ApprovalStatusFilter; limit: number },
): Promise<ApprovalView[]> {
  const { rows } = await db.query(
    `SELECT a.*, p.name AS project_name, t.title AS task_title, t.state AS task_state
       FROM approvals a
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN tasks t ON t.id = a.subject_id
      WHERE ($1::uuid IS NULL OR p.org_id = $1)
        AND ($2::uuid IS NULL OR a.project_id = $2)
        AND ($3 = 'all' OR ($3 = 'pending' AND a.decision IS NULL) OR ($3 = 'decided' AND a.decision IS NOT NULL))
      ORDER BY a.requested_at DESC, a.id
      LIMIT $4`,
    [filter.orgId ?? null, filter.projectId ?? null, filter.status, filter.limit],
  );
  return rows.map((row) => {
    // subject_id는 ACTION 게이트에서 태스크 id다 — 응답에는 taskId로만 낸다.
    const { subjectId: _subject, ...approval } = toApproval(row);
    return {
    ...approval,
    projectName: row.project_name as string,
    taskId: row.subject_id as string,
    taskTitle: (row.task_title as string | null) ?? null,
    taskState: (row.task_state as string | null) ?? null,
    };
  });
}

// 이 태스크의 가장 최근 반려 — 다음 시도의 브리핑에 들어간다.
export async function findLatestRejection(
  db: Queryable,
  taskId: string,
): Promise<{ approvalId: string; reason: string; decidedAt: string; artifactId: string | null; commitSha: string | null } | null> {
  const { rows } = await db.query(
    `SELECT id, reason, decided_at, artifact_id, payload->>'commitSha' AS commit_sha
       FROM approvals
      WHERE subject_id = $1 AND decision = 'REJECT'
      ORDER BY decided_at DESC
      LIMIT 1`,
    [taskId],
  );
  const row = rows[0];
  return row
    ? {
        approvalId: row.id as string,
        reason: row.reason as string,
        decidedAt: toIso(row.decided_at)!,
        artifactId: (row.artifact_id as string | null) ?? null,
        commitSha: (row.commit_sha as string | null) ?? null,
      }
    : null;
}
