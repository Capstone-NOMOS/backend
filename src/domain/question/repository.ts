import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';
import type { TeamRole } from '../roles.js';
import type { QuestionTarget } from './router.js';

// 에이전트 질문(018). SQL만 둔다.

// Claude Code AskUserQuestion의 질문 형식 그대로.
export type QuestionOption = { label: string; description?: string };
export type AskedQuestion = { question: string; header?: string; options: QuestionOption[]; multiSelect?: boolean };

export type QuestionStatus = 'pending' | 'agent_answered' | 'answered' | 'expired' | 'self_owned';
export type AnswerSource = 'agent' | 'human' | 'agent_confirmed' | 'human_override';

// costUsd: 판정의 모델 비용(025, LLM 라우터). 옛 행·규칙 라우터에는 없다.
export type RoutingDetail = { confidence: number | null; reason: string | null; latencyMs: number; fallback: string | null; costUsd?: number | null };

// 상담 실행의 초안. decided[질문] = 코드·명세가 이미 정한 답인가(아니면 제안일 뿐이다).
export type QuestionDraft = { answers: Record<string, string>; decided: Record<string, boolean>; basis: Record<string, string[]> };

export type AgentQuestion = {
  id: string;
  projectId: string;
  taskId: string;
  askedByAgentId: string;
  askerRole: TeamRole;
  targetRole: QuestionTarget;
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
    targetRole: QuestionTarget;
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

// 태스크가 취소되면(027) 그 태스크의 대기 질문을 만료로 닫는다 — 답할 사람의 대기열에 남지 않게.
export async function expirePendingForTask(db: Queryable, taskId: string): Promise<string[]> {
  const { rows } = await db.query(
    `UPDATE agent_questions SET status = 'expired' WHERE task_id = $1 AND status = 'pending' RETURNING id`,
    [taskId],
  );
  return rows.map((r) => r.id as string);
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
// agentId가 null이면 PM 초안이다(025, 대표 노트북 또는 서버 키로 돈다 — DB가 PM 질문에서만 허용한다). PM 초안은 답이 되지 않는다.
export async function saveDraft(db: Queryable, id: string, draft: QuestionDraft, agentId: string | null, asAnswer: boolean): Promise<boolean> {
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

// 이 사람이 답할 질문(조직 전체) — 알림 배지·"내가 답할 질문" 목록. 답할 자격(answerQuestion과 같은 정의):
// 그 프로젝트에서 질문의 대상 역할(target_role)을 맡은 에이전트의 주인, 또는 대표(전부).
export async function listQuestionsForAnswerer(
  db: Queryable,
  input: { orgId: string; userId: string; isRepresentative: boolean; status: QuestionStatus | 'all'; limit: number },
): Promise<{ question: AgentQuestion; projectName: string; taskTitle: string }[]> {
  const { rows } = await db.query(
    `SELECT q.*, p.name AS project_name, t.title AS task_title
       FROM agent_questions q
       JOIN projects p ON p.id = q.project_id
       JOIN tasks t ON t.id = q.task_id
      WHERE p.org_id = $1
        AND ($2 = 'all' OR q.status = $2)
        AND ($3 OR EXISTS (
              SELECT 1 FROM project_members m
               WHERE m.project_id = q.project_id AND m.team_role = q.target_role AND m.user_id = $4))
      ORDER BY q.created_at DESC, q.id
      LIMIT $5`,
    [input.orgId, input.status, input.isRepresentative, input.userId, input.limit],
  );
  return rows.map((r) => ({ question: toQuestion(r), projectName: r.project_name as string, taskTitle: r.task_title as string }));
}

// 만료 시각이 지난 대기 질문(조직 id와 함께) — 아무도 읽지 않아도 만료를 처리하는 주기 정리가 쓴다.
export async function listDueQuestions(db: Queryable, limit = 100): Promise<{ question: AgentQuestion; orgId: string }[]> {
  const { rows } = await db.query(
    `SELECT q.*, p.org_id AS question_org_id FROM agent_questions q JOIN projects p ON p.id = q.project_id
      WHERE q.status = 'pending' AND q.expires_at <= now()
      ORDER BY q.expires_at LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ question: toQuestion(r), orgId: r.question_org_id as string }));
}

// 질문으로 정해진 결정(조회 API·브리핑·제출 확인) — 결정 한 줄을 그리는 데 필요한 이름을 함께 읽는다.
// decided_by: answered면 답한 사람(answered_by), agent_answered면 초안을 낸 에이전트(drafted_by_agent).
export type DecisionRow = {
  question: AgentQuestion;
  taskTitle: string;
  askedByAgentName: string;
  draftedByAgentName: string | null;
  answeredByNickname: string | null;
  answeredByIsRepresentative: boolean;
};

export async function listDecisionRows(
  db: Queryable,
  input: {
    projectId: string;
    statuses: readonly QuestionStatus[];
    role: QuestionTarget | null;
    taskId: string | null;
    excludeTaskId: string | null;
    order: 'oldest' | 'newest';
    limit: number | null;
  },
): Promise<DecisionRow[]> {
  const direction = input.order === 'oldest' ? 'ASC' : 'DESC';
  const { rows } = await db.query(
    `SELECT q.*, t.title AS task_title, asker.name AS asked_by_agent_name, drafter.name AS drafted_by_agent_name,
            u.nickname AS answered_by_nickname, (u.org_role = 'REPRESENTATIVE') AS answered_by_is_representative
       FROM agent_questions q
       JOIN tasks t ON t.id = q.task_id
       JOIN agents asker ON asker.id = q.asked_by_agent
       LEFT JOIN agents drafter ON drafter.id = q.drafted_by_agent
       LEFT JOIN users u ON u.id = q.answered_by
      WHERE q.project_id = $1
        AND q.status = ANY($2::text[])
        AND ($3::text IS NULL OR q.asker_role = $3 OR q.target_role = $3)
        AND ($4::uuid IS NULL OR q.task_id = $4)
        AND ($5::uuid IS NULL OR q.task_id <> $5)
      ORDER BY COALESCE(q.answered_at, q.created_at) ${direction}, q.id ${direction}
      LIMIT $6`,
    [input.projectId, [...input.statuses], input.role, input.taskId, input.excludeTaskId, input.limit],
  );
  return rows.map((r) => ({
    question: toQuestion(r),
    taskTitle: r.task_title as string,
    askedByAgentName: r.asked_by_agent_name as string,
    draftedByAgentName: (r.drafted_by_agent_name as string | null) ?? null,
    answeredByNickname: (r.answered_by_nickname as string | null) ?? null,
    answeredByIsRepresentative: r.answered_by_is_representative === true,
  }));
}
