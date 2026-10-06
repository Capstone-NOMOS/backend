import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';
import type { TeamRole } from '../roles.js';

// 에이전트 질문(017). SQL만 둔다.

// Claude Code AskUserQuestion의 질문 형식 그대로.
export type QuestionOption = { label: string; description?: string };
export type AskedQuestion = { question: string; header?: string; options: QuestionOption[]; multiSelect?: boolean };

export type QuestionStatus = 'pending' | 'answered' | 'expired';

export type AgentQuestion = {
  id: string;
  projectId: string;
  taskId: string;
  askedByAgentId: string;
  askerRole: TeamRole;
  targetRole: TeamRole;
  routedBy: string;
  questions: AskedQuestion[];
  status: QuestionStatus;
  answers: Record<string, string> | null;
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
    questions: row.questions,
    status: row.status,
    answers: row.answers ?? null,
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
    questions: AskedQuestion[];
    timeoutMs: number;
  },
): Promise<AgentQuestion> {
  const { rows } = await db.query(
    `INSERT INTO agent_questions (project_id, task_id, asked_by_agent, asker_role, target_role, routed_by, questions, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8::double precision / 1000))
     RETURNING *`,
    [input.projectId, input.taskId, input.askedByAgentId, input.askerRole, input.targetRole, input.routedBy, JSON.stringify(input.questions), input.timeoutMs],
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

export async function markAnswered(db: Queryable, id: string, answers: Record<string, string>, answeredBy: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE agent_questions SET status = 'answered', answers = $2, answered_by = $3, answered_at = now()
      WHERE id = $1 AND status = 'pending' AND expires_at > now()`,
    [id, JSON.stringify(answers), answeredBy],
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
