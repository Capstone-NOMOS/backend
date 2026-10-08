import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';
import type { TeamRole } from '../roles.js';

// 에이전트 질문(018). SQL만 둔다.

// Claude Code AskUserQuestion의 질문 형식 그대로.
export type QuestionOption = { label: string; description?: string };
export type AskedQuestion = { question: string; header?: string; options: QuestionOption[]; multiSelect?: boolean };

export type QuestionStatus = 'pending' | 'agent_answered' | 'answered' | 'expired' | 'self_owned';
export type AnswerSource = 'agent' | 'human' | 'agent_confirmed' | 'human_override';

export type RoutingDetail = { confidence: number | null; reason: string | null; latencyMs: number; fallback: string | null };

// 상담 실행의 초안. decided[질문] = 코드·명세가 이미 정한 답인가(아니면 제안일 뿐이다).
export type QuestionDraft = { answers: Record<string, string>; decided: Record<string, boolean>; basis: Record<string, string[]> };

export type AgentQuestion = {
  id: string;
  projectId: string;
  taskId: string;
  askedByAgentId: string;
  askerRole: TeamRole;
  targetRole: TeamRole;
  routedBy: string;
  routing: RoutingDetail;
  questions: AskedQuestion[];
  status: QuestionStatus;
  draft: QuestionDraft | null;
  draftedByAgentId: string | null;
  draftedAt: string | null;
  answers: Record<string, string> | null;
  answerSource: AnswerSource | null;
  answeredBy: string | null;
  answeredAt: string | null;
  expiresAt: string;
  createdAt: string;
};

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

function toQuestion(row: QueryResultRow): AgentQuestion {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    askedByAgentId: row.asked_by_agent,
    askerRole: row.asker_role,
    targetRole: row.target_role,
    routedBy: row.routed_by,
    routing: row.routing,
    questions: row.questions,
    status: row.status,
    draft: row.draft ?? null,
    draftedByAgentId: row.drafted_by_agent ?? null,
    draftedAt: iso(row.drafted_at),
    answers: row.answers ?? null,
    answerSource: row.answer_source ?? null,
    answeredBy: row.answered_by ?? null,
    answeredAt: iso(row.answered_at),
    expiresAt: iso(row.expires_at)!,
    createdAt: iso(row.created_at)!,
  };
}

export async function insertQuestion(
  db: Queryable,
  input: {
    projectId: string;
    taskId: string;
    askedByAgentId: string;
    askerRole: TeamRole;
    targetRole: TeamRole;
    routedBy: string;
    routing: RoutingDetail;
    status: 'pending' | 'self_owned';
    questions: AskedQuestion[];
    timeoutMs: number;
  },
): Promise<AgentQuestion> {
  const { rows } = await db.query(
    `INSERT INTO agent_questions (project_id, task_id, asked_by_agent, asker_role, target_role, routed_by, routing, status, questions, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10::double precision / 1000))
     RETURNING *`,
    [input.projectId, input.taskId, input.askedByAgentId, input.askerRole, input.targetRole, input.routedBy, JSON.stringify(input.routing), input.status, JSON.stringify(input.questions), input.timeoutMs],
  );
  return toQuestion(rows[0]!);
}

export async function findQuestion(db: Queryable, id: string, options: { forUpdate?: boolean } = {}): Promise<AgentQuestion | null> {
  const { rows } = await db.query(`SELECT * FROM agent_questions WHERE id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0] ? toQuestion(rows[0]) : null;
}

// 만료는 읽을 때 판정한다(타이머 없이). 대기 중이고 시각이 지났을 때만 바뀐다 — 동시에 답이 와도 한쪽만 이긴다.
export async function expireIfDue(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE agent_questions SET status = 'expired' WHERE id = $1 AND status = 'pending' AND expires_at <= now()`,
    [id],
  );
  return rowCount === 1;
}

// 사람이 답한다. 대기 중이면 직접 답(human), 에이전트가 이미 답했으면 확인(agent_confirmed) 또는 뒤집기(human_override).
// 기대한 상태일 때만 바뀐다 — 동시에 두 사람이 눌러도 한쪽만 이긴다.
export async function markAnsweredByHuman(
  db: Queryable,
  id: string,
  from: 'pending' | 'agent_answered',
  answers: Record<string, string>,
  source: AnswerSource,
  answeredBy: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE agent_questions SET status = 'answered', answers = $3, answer_source = $4, answered_by = $5, answered_at = now()
      WHERE id = $1 AND status = $2 AND ($2 = 'agent_answered' OR expires_at > now())`,
    [id, from, JSON.stringify(answers), source, answeredBy],
  );
  return rowCount === 1;
}

// 상담 실행의 초안을 저장한다(처음 한 번만). asAnswer면 초안이 곧 답이다(전부 decided) — agent_answered.
export async function saveDraft(db: Queryable, id: string, draft: QuestionDraft, agentId: string, asAnswer: boolean): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE agent_questions
        SET draft = $2, drafted_by_agent = $3, drafted_at = now(),
            status = CASE WHEN $4 THEN 'agent_answered' ELSE status END,
            answers = CASE WHEN $4 THEN $5::jsonb ELSE answers END,
            answer_source = CASE WHEN $4 THEN 'agent' ELSE answer_source END,
            answered_at = CASE WHEN $4 THEN now() ELSE answered_at END
      WHERE id = $1 AND status = 'pending' AND draft IS NULL AND expires_at > now()`,
    [id, JSON.stringify(draft), agentId, asAnswer, JSON.stringify(draft.answers)],
  );
  return rowCount === 1;
}

export async function listQuestions(
  db: Queryable,
  projectId: string,
  status: QuestionStatus | 'all',
  limit: number,
): Promise<AgentQuestion[]> {
  const { rows } = await db.query(
    `SELECT * FROM agent_questions
      WHERE project_id = $1 AND ($2 = 'all' OR status = $2)
      ORDER BY created_at DESC, id
      LIMIT $3`,
    [projectId, status, limit],
  );
  return rows.map(toQuestion);
}

// 상담 실행이 맡을 질문 — 이 역할 대상이고, 대기 중이며, 아직 초안이 없는 것.
export async function listUndraftedForRole(db: Queryable, projectId: string, role: TeamRole): Promise<AgentQuestion[]> {
  const { rows } = await db.query(
    `SELECT * FROM agent_questions
      WHERE project_id = $1 AND target_role = $2 AND status = 'pending' AND draft IS NULL AND expires_at > now()
      ORDER BY created_at, id
      LIMIT 10`,
    [projectId, role],
  );
  return rows.map(toQuestion);
}

// 재개할 때 브리핑에 넣을, 이 태스크에서 받은 답.
export async function listTaskAnswers(db: Queryable, taskId: string): Promise<AgentQuestion[]> {
  const { rows } = await db.query(
    `SELECT * FROM agent_questions WHERE task_id = $1 AND status IN ('agent_answered', 'answered') ORDER BY created_at, id`,
    [taskId],
  );
  return rows.map(toQuestion);
}

export async function countPendingForTask(db: Queryable, taskId: string): Promise<number> {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM agent_questions WHERE task_id = $1 AND status = 'pending'`, [taskId]);
  return rows[0]!.n as number;
}

// 상담 실행이 읽을 레포 — 이 프로젝트의 레포 중 이 역할이 소유한 경로 규칙이 있는 것.
export type ConsultRepo = { id: string; fullName: string; cloneUrl: string | null; defaultBranch: string };

export async function listRoleRepos(db: Queryable, projectId: string, role: TeamRole): Promise<ConsultRepo[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT r.id, r.full_name, r.clone_url, r.default_branch
       FROM project_repos pr
       JOIN repos r ON r.id = pr.repo_id
       JOIN repo_paths p ON p.repo_id = r.id AND p.owner_role = $2
      WHERE pr.project_id = $1
      ORDER BY r.full_name`,
    [projectId, role],
  );
  return rows.map((r) => ({ id: r.id, fullName: r.full_name, cloneUrl: r.clone_url ?? null, defaultBranch: r.default_branch }));
}
