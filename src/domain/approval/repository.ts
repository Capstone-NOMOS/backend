import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';

// 승인 대기열(015). SQL만 둔다.

export type ApprovalGate = 'G1' | 'G2' | 'G3' | 'ACTION';
export type ApprovalDecision = 'APPROVE' | 'REJECT';
export type ApprovalStatusFilter = 'pending' | 'decided' | 'all';
// 030: ACTION 카드는 역할 담당의 1차 검토(role_review) → 대표 최종(final) 두 단계다. G1·G2·G3와 그 이전 카드는 final뿐이다.
export type ApprovalStage = 'role_review' | 'final';
export type ApprovalStageFilter = ApprovalStage | 'all';

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
  stage: ApprovalStage;
  reviewerUserId: string | null;
};

// 1차 검토를 통과한 final 카드의 payload.roleReview — 누가 언제 통과시켰나.
export type RoleReviewRecord = { by: string; nickname: string | null; at: string; decidedByRepresentative: boolean; note?: string };

// 목록용 — 지금 상태(태스크 제목·상태, 프로젝트 이름)를 함께 붙인다. 카드의 스냅샷은 payload에 따로 있다.
export type ApprovalView = Omit<ApprovalRow, 'subjectId' | 'reviewerUserId'> & {
  // role_review 카드를 볼 역할 담당. final은 null(대표가 본다).
  reviewer: { userId: string; nickname: string | null } | null;
  // final 카드가 1차 검토를 거쳤으면 그 결과(payload.roleReview). 거치지 않았으면 null — 이유는 payload.roleReviewSkipped.
  roleReview: RoleReviewRecord | null;
  projectName: string;
  // ACTION은 그 태스크, G3(통합 확인·완료)는 프로젝트 전체라 null.
  taskId: string | null;
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
    stage: row.stage,
    reviewerUserId: row.reviewer_user_id ?? null,
  };
}

export async function insertApproval(
  db: Queryable,
  input: {
    projectId: string;
    gate: ApprovalGate;
    subjectId: string;
    artifactId: string | null;
    gateMode: string | null;
    payload: Record<string, unknown>;
    stage: ApprovalStage;
    reviewerUserId: string | null;
  },
): Promise<ApprovalRow> {
  const { rows } = await db.query(
    `INSERT INTO approvals (project_id, gate, subject_id, artifact_id, gate_mode, payload, stage, reviewer_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [input.projectId, input.gate, input.subjectId, input.artifactId, input.gateMode, input.payload, input.stage, input.reviewerUserId],
  );
  return toApproval(rows[0]!);
}

export async function findApprovalForUpdate(db: Queryable, approvalId: string): Promise<(ApprovalRow & { orgId: string }) | null> {
  const { rows } = await db.query(
    `SELECT a.*, p.org_id FROM approvals a JOIN projects p ON p.id = a.project_id WHERE a.id = $1 AND p.deleted_at IS NULL FOR UPDATE OF a`,
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

// 그 역할의 담당(사람, 028)과 그 사람이 대표인지. 역할 제한이 없는 태스크(teamRole null)나 비어 있는 역할이면 null.
export async function findRoleOwner(
  db: Queryable,
  projectId: string,
  teamRole: string | null,
): Promise<{ userId: string; nickname: string | null; isRepresentative: boolean } | null> {
  if (teamRole === null) return null;
  const { rows } = await db.query(
    `SELECT m.user_id, u.nickname, u.org_role
       FROM project_members m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = $1 AND m.team_role = $2`,
    [projectId, teamRole],
  );
  const row = rows[0];
  return row
    ? { userId: row.user_id as string, nickname: (row.nickname as string | null) ?? null, isRepresentative: row.org_role === 'REPRESENTATIVE' }
    : null;
}

export async function findUserNickname(db: Queryable, userId: string): Promise<string | null> {
  const { rows } = await db.query(`SELECT nickname FROM users WHERE id = $1`, [userId]);
  return (rows[0]?.nickname as string | null | undefined) ?? null;
}

// 승인·반려 직전에 태스크 행을 잠그고 상태와 담당 에이전트의 주인을 읽는다.
export async function lockApprovalTask(
  db: Queryable,
  taskId: string,
): Promise<{ state: string; teamRole: string | null; assigneeAgentId: string | null; assigneeOwnerId: string | null } | null> {
  const { rows } = await db.query(
    `SELECT t.state, t.team_role, t.assignee_agent_id, a.user_id AS owner_id
       FROM tasks t LEFT JOIN agents a ON a.id = t.assignee_agent_id
      WHERE t.id = $1
      FOR UPDATE OF t`,
    [taskId],
  );
  const row = rows[0];
  return row
    ? {
        state: row.state as string,
        teamRole: (row.team_role as string | null) ?? null,
        assigneeAgentId: (row.assignee_agent_id as string | null) ?? null, assigneeOwnerId: (row.owner_id as string | null) ?? null,
      }
    : null;
}

export async function listApprovals(
  db: Queryable,
  filter: {
    orgId?: string;
    projectId?: string;
    status: ApprovalStatusFilter;
    stage?: ApprovalStageFilter;
    // 이 사람이 지금 그 역할 담당인 role_review 카드만(GET /me/approvals). 역할에서 빠졌으면 대표만 결정할 수 있어 보이지 않는다.
    reviewerUserId?: string;
    limit: number;
  },
): Promise<ApprovalView[]> {
  const { rows } = await db.query(
    `SELECT a.*, p.name AS project_name, t.title AS task_title, t.state AS task_state, ru.nickname AS reviewer_nickname
       FROM approvals a
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN tasks t ON t.id = a.subject_id
       LEFT JOIN users ru ON ru.id = a.reviewer_user_id
      WHERE ($1::uuid IS NULL OR p.org_id = $1)
        AND ($2::uuid IS NULL OR a.project_id = $2)
        AND p.deleted_at IS NULL
        AND ($3 = 'all' OR ($3 = 'pending' AND a.decision IS NULL AND p.status <> 'aborted') OR ($3 = 'decided' AND a.decision IS NOT NULL))
        AND ($5 = 'all' OR a.stage = $5)
        AND ($6::uuid IS NULL OR (a.reviewer_user_id = $6 AND EXISTS (
              SELECT 1 FROM project_members m WHERE m.project_id = a.project_id AND m.user_id = $6 AND m.team_role = t.team_role)))
      ORDER BY a.requested_at DESC, a.id
      LIMIT $4`,
    [filter.orgId ?? null, filter.projectId ?? null, filter.status, filter.limit, filter.stage ?? 'all', filter.reviewerUserId ?? null],
  );
  return rows.map((row) => {
    // subject_id는 ACTION 게이트에서 태스크 id, G3에서는 프로젝트 id다 — 응답에는 태스크일 때만 taskId로 낸다.
    const { subjectId: _subject, reviewerUserId, ...approval } = toApproval(row);
    const roleReview = approval.payload.roleReview;
    return {
    ...approval,
    reviewer: reviewerUserId === null ? null : { userId: reviewerUserId, nickname: (row.reviewer_nickname as string | null) ?? null },
    roleReview: typeof roleReview === 'object' && roleReview !== null ? (roleReview as RoleReviewRecord) : null,
    projectName: row.project_name as string,
    taskId: approval.gate === 'ACTION' ? (row.subject_id as string) : null,
    taskTitle: (row.task_title as string | null) ?? null,
    taskState: (row.task_state as string | null) ?? null,
    };
  });
}

// 이 태스크의 가장 최근 반려 — 다음 시도의 브리핑에 들어간다.
export async function findLatestRejection(
  db: Queryable,
  taskId: string,
): Promise<{
  approvalId: string;
  reason: string;
  decidedAt: string;
  artifactId: string | null;
  commitSha: string | null;
  // 누가 반려했나(030) — 1차 검토에서 역할 담당이(role_owner), 또는 대표가(최종 승인이나 1차 검토를 대신 처리).
  rejectedBy: 'role_owner' | 'representative';
} | null> {
  const { rows } = await db.query(
    `SELECT id, reason, decided_at, artifact_id, payload->>'commitSha' AS commit_sha,
            (stage = 'role_review' AND decided_by = reviewer_user_id) AS by_role_owner
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
        rejectedBy: row.by_role_owner === true ? 'role_owner' : 'representative',
      }
    : null;
}

// ── G3: 통합 확인·완료 승인 ──────────────────────────────────────────────

// 모든 태스크가 DONE인가(하나 이상 있을 때). 프로젝트가 진행 중(active)일 때만 의미가 있다.
// 프로젝트 행을 먼저 잠그고(FOR NO KEY UPDATE — FOR UPDATE는 외래 키 검사와 충돌한다) **다음 문장에서** 다시 읽는다:
// 두 태스크가 동시에 DONE이 되면 서로의 DONE이 안 보여 둘 다 카드를 안 만들 수 있다. 잠금 뒤 새 문장은 먼저 커밋된 쪽을 본다.
export async function isProjectReadyForRelease(db: Queryable, projectId: string): Promise<boolean> {
  await db.query(`SELECT 1 FROM projects WHERE id = $1 FOR NO KEY UPDATE`, [projectId]);
  const { rows } = await db.query(
    `SELECT p.status = 'active'
            AND EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.state = 'DONE')
            AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.state NOT IN ('DONE', 'CANCELLED'))
            AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.project_id = p.id AND a.gate = 'G3'
                             AND (a.decision IS NULL OR a.decision = 'APPROVE')) AS ready
       FROM projects p WHERE p.id = $1`,
    [projectId],
  );
  return rows[0]?.ready === true;
}

// 적용된 계획들의 통합 확인 항목(PM이 쓴 것). 옛 초안에는 없다.
export async function listIntegrationChecks(db: Queryable, projectId: string): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT jsonb_array_elements_text(COALESCE(dag_snapshot->'integrationChecks', '[]'::jsonb)) AS check_text
       FROM plans WHERE project_id = $1 AND applied_at IS NOT NULL
      ORDER BY applied_at, id`,
    [projectId],
  );
  return rows.map((r) => r.check_text as string);
}

// 카드에 붙일 태스크 요약 — 사람이 머지·실행해 볼 브랜치와 마지막 커밋.
export async function listReleaseTasks(
  db: Queryable,
  projectId: string,
): Promise<{ taskId: string; title: string; teamRole: string | null; repo: string; branchName: string | null; commitSha: string | null }[]> {
  const { rows } = await db.query(
    `SELECT t.id, t.title, t.team_role, r.full_name, t.branch_name,
            (SELECT ar.commit_sha FROM artifacts ar WHERE ar.task_id = t.id ORDER BY ar.attempt DESC LIMIT 1) AS commit_sha
       FROM tasks t JOIN repos r ON r.id = t.repo_id
      WHERE t.project_id = $1 AND t.state <> 'CANCELLED'
      ORDER BY t.created_at, t.id`,
    [projectId],
  );
  return rows.map((r) => ({
    taskId: r.id as string,
    title: r.title as string,
    teamRole: (r.team_role as string | null) ?? null,
    repo: r.full_name as string,
    branchName: (r.branch_name as string | null) ?? null,
    commitSha: (r.commit_sha as string | null) ?? null,
  }));
}

// 대기 중인 G3는 프로젝트당 하나(uq_approvals_pending_subject). 이미 있으면 아무것도 하지 않고 null — 상태 변경을 롤백시키지 않는다.
export async function insertReleaseApproval(db: Queryable, projectId: string, payload: Record<string, unknown>): Promise<string | null> {
  const { rows } = await db.query(
    `INSERT INTO approvals (project_id, gate, subject_id, payload) VALUES ($1, 'G3', $1, $2)
     ON CONFLICT (subject_id) WHERE decision IS NULL DO NOTHING
     RETURNING id`,
    [projectId, payload],
  );
  return (rows[0]?.id as string | undefined) ?? null;
}

export async function markProjectCompleted(db: Queryable, projectId: string): Promise<void> {
  await db.query(`UPDATE projects SET status = 'completed' WHERE id = $1 AND status = 'active'`, [projectId]);
}
