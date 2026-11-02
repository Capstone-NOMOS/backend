import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';

// 무인 실험(034)의 조회 — 자동으로 통과시킬 것을 찾는다. 상태를 바꾸는 쓰기는 전부 원래 서비스(pm·contract·approval·task)를 탄다.
// 모든 쿼리는 실험 모드(question_mode = experiment) 프로젝트만 본다 — 기본 모드 프로젝트는 여기서 걸러져 아무것도 일어나지 않는다.

export type ExperimentProject = {
  id: string;
  orgId: string;
  status: string;
  policyHash: string;
  // 조직 대표(실험을 켠 사람). DB 행의 사람 칸(approved_by·decided_by·requested_by)에 적는다 — 명의는 system:experiment.
  representativeUserId: string | null;
};

const OPEN = `p.status IN ('planning', 'active') AND p.deleted_at IS NULL AND p.question_mode = 'experiment'`;

function toProject(row: QueryResultRow): ExperimentProject {
  return { id: row.id, orgId: row.org_id, status: row.status, policyHash: row.policy_hash, representativeUserId: row.representative_user_id ?? null };
}

const PROJECT_COLUMNS = `p.id, p.org_id, p.status, p.policy_hash,
       (SELECT u.id FROM users u WHERE u.org_id = p.org_id AND u.org_role = 'REPRESENTATIVE' ORDER BY u.created_at LIMIT 1) AS representative_user_id`;

// 진행 중인 실험 모드 프로젝트 하나. 아니면 null(기본 모드·끝난 프로젝트).
export async function findOpenExperimentProject(db: Queryable, projectId: string): Promise<ExperimentProject | null> {
  const { rows } = await db.query(`SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = $1 AND ${OPEN}`, [projectId]);
  return rows[0] ? toProject(rows[0]) : null;
}

export async function listOpenExperimentProjects(db: Queryable): Promise<ExperimentProject[]> {
  const { rows } = await db.query(`SELECT ${PROJECT_COLUMNS} FROM projects p WHERE ${OPEN} ORDER BY p.created_at`);
  return rows.map(toProject);
}

// 수정 체인의 마지막 판(다음 판이 없는 것) 중 아직 적용되지 않은 체인의 ready·failed.
export type PlanLeaf = {
  id: string;
  rootPlanId: string;
  kind: 'feature' | 'tasks';
  status: 'ready' | 'failed';
  errorReason: string | null;
  questionCount: number;
  pendingQuestionCount: number;
  answeredQuestionCount: number;
  retries: number;
  skipped: boolean;
};

export async function listPlanLeaves(db: Queryable, projectId: string): Promise<PlanLeaf[]> {
  const { rows } = await db.query(
    `SELECT p.id, p.root_plan_id, p.kind, p.status, p.error_reason,
            (SELECT count(*)::int FROM agent_questions q WHERE q.plan_id = p.id) AS question_count,
            (SELECT count(*)::int FROM agent_questions q WHERE q.plan_id = p.id AND q.status = 'pending') AS pending_count,
            (SELECT count(*)::int FROM agent_questions q WHERE q.plan_id = p.id AND q.status IN ('answered', 'agent_answered')) AS answered_count,
            (SELECT count(*)::int FROM plans r WHERE r.root_plan_id = p.root_plan_id AND r.revision_cause = 'retry') AS retries,
            EXISTS (SELECT 1 FROM events e WHERE e.project_id = p.project_id AND e.type = 'EXPERIMENT_SKIPPED'
                     AND e.payload->'subject'->>'planId' = p.root_plan_id::text) AS skipped
       FROM plans p
      WHERE p.project_id = $1 AND p.status IN ('ready', 'failed')
        AND NOT EXISTS (SELECT 1 FROM plans c WHERE c.parent_plan_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM plans a WHERE a.root_plan_id = p.root_plan_id AND a.status = 'applied')
      ORDER BY p.created_at`,
    [projectId],
  );
  return rows.map((r) => ({
    id: r.id,
    rootPlanId: r.root_plan_id,
    kind: r.kind,
    status: r.status,
    errorReason: r.error_reason ?? null,
    questionCount: r.question_count,
    pendingQuestionCount: r.pending_count,
    answeredQuestionCount: r.answered_count,
    retries: r.retries,
    skipped: r.skipped,
  }));
}

// 초안(draft)·실패(failed) 계약. 지금 초안의 질문 = 그 초안을 저장한 트랜잭션에서 넣은 것(created_at >= drafted_at — 질문은 clock_timestamp로 들어간다).
export type ContractCandidate = {
  id: string;
  featureKey: string;
  status: 'draft' | 'failed';
  experimentRetries: number;
  pendingQuestionCount: number;
  currentQuestionCount: number;
  currentAnsweredCount: number;
  errorReason: string | null;
  skipped: boolean;
};

export async function listContractCandidates(db: Queryable, projectId: string): Promise<ContractCandidate[]> {
  const { rows } = await db.query(
    `SELECT c.id, s.feature_key, c.status, c.experiment_retries, c.error_reason,
            (SELECT count(*)::int FROM agent_questions q WHERE q.contract_id = c.id AND q.status = 'pending') AS pending_count,
            (SELECT count(*)::int FROM agent_questions q WHERE q.contract_id = c.id AND q.created_at >= c.drafted_at) AS current_count,
            (SELECT count(*)::int FROM agent_questions q WHERE q.contract_id = c.id AND q.created_at >= c.drafted_at
                                                          AND q.status IN ('answered', 'agent_answered')) AS current_answered,
            EXISTS (SELECT 1 FROM events e WHERE e.project_id = c.project_id AND e.type = 'EXPERIMENT_SKIPPED'
                     AND e.payload->'subject'->>'contractId' = c.id::text) AS skipped
       FROM contracts c JOIN specs s ON s.id = c.spec_id
      WHERE c.project_id = $1 AND c.status IN ('draft', 'failed')
      ORDER BY s.feature_key`,
    [projectId],
  );
  return rows.map((r) => ({
    id: r.id,
    featureKey: r.feature_key,
    status: r.status,
    experimentRetries: r.experiment_retries,
    pendingQuestionCount: r.pending_count,
    currentQuestionCount: r.current_count,
    currentAnsweredCount: r.current_answered,
    errorReason: r.error_reason ?? null,
    skipped: r.skipped,
  }));
}

// 결정을 기다리는 ACTION 카드(1차 검토·최종). G3는 넣지 않는다 — 자동으로 승인하지 않는다.
export async function listPendingActionApprovals(db: Queryable, projectId: string): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT id FROM approvals WHERE project_id = $1 AND gate = 'ACTION' AND decision IS NULL ORDER BY requested_at`,
    [projectId],
  );
  return rows.map((r) => r.id as string);
}

// 태스크 나누기가 필요한가 — 태스크가 하나도 없는 명세가 있고, 그 명세가 마지막 태스크 나누기 요청보다 뒤에 생겼다.
// 뒤의 조건이 없으면 PM이 일부 명세에 태스크를 만들지 않았을 때 같은 요청을 끝없이 다시 낸다.
export async function needsTaskSplit(db: Queryable, projectId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM specs s
        WHERE s.project_id = $1
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.spec_id = s.id)
          AND s.created_at > COALESCE((SELECT max(created_at) FROM plans WHERE project_id = $1 AND kind = 'tasks'), '-infinity'::timestamptz)
     ) AS needed`,
    [projectId],
  );
  return rows[0]!.needed as boolean;
}

// 자동 답이 빠진 대기 질문(자동 답 작업이 실패했거나 서버가 그 사이 재시작했다).
export async function listStalePendingQuestions(db: Queryable, staleMs: number): Promise<{ id: string; orgId: string; projectId: string }[]> {
  const { rows } = await db.query(
    `SELECT q.id, p.org_id, q.project_id FROM agent_questions q JOIN projects p ON p.id = q.project_id
      WHERE ${OPEN} AND q.status = 'pending' AND q.created_at < now() - make_interval(secs => $1::float8 / 1000)
      ORDER BY q.created_at`,
    [staleMs],
  );
  return rows.map((r) => ({ id: r.id, orgId: r.org_id, projectId: r.project_id }));
}

// 검증 보고(V2·V4)가 오지 않은 채 VERIFYING에 머문 태스크 — 마지막 제출도, 그 뒤 검증 기록도 기준 시간보다 오래됐다.
export async function listStuckVerifying(db: Queryable, timeoutMs: number): Promise<{ taskId: string; projectId: string; orgId: string; agentId: string }[]> {
  const { rows } = await db.query(
    `SELECT t.id, t.project_id, p.org_id, t.assignee_agent_id
       FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE ${OPEN} AND t.state = 'VERIFYING' AND t.assignee_agent_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.task_id = t.id AND a.created_at > now() - make_interval(secs => $1::float8 / 1000))
        AND NOT EXISTS (SELECT 1 FROM verifications v JOIN artifacts a ON a.id = v.artifact_id
                         WHERE a.task_id = t.id AND v.created_at > now() - make_interval(secs => $1::float8 / 1000))`,
    [timeoutMs],
  );
  return rows.map((r) => ({ taskId: r.id, projectId: r.project_id, orgId: r.org_id, agentId: r.assignee_agent_id }));
}

// VERIFYING에서 멈춤으로 내린다(BLOCKED·AGENT_STOPPED — 대표가 재개하면 READY). 그 사이 결론이 났으면 0행.
export async function blockVerifyingTask(db: Queryable, taskId: string, agentId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE tasks SET state = 'BLOCKED', blocked_reason = 'AGENT_STOPPED', updated_at = now()
      WHERE id = $1 AND state = 'VERIFYING' AND assignee_agent_id = $2`,
    [taskId, agentId],
  );
  return rowCount === 1;
}
