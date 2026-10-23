import type { Queryable } from '../../config/db.js';

// 질문 라우팅 평가 기록(026). SQL만 둔다.

export type RoutingRunInput = {
  questionId: string;
  router: string;
  mode: 'primary' | 'shadow';
  target: string | null;
  confidence: number | null;
  latencyMs: number;
  costUsd: number | null;
  error: string | null;
};

export async function insertRoutingRun(db: Queryable, run: RoutingRunInput): Promise<void> {
  await db.query(
    `INSERT INTO question_routing_runs (question_id, router, mode, target, confidence, latency_ms, cost_usd, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [run.questionId, run.router, run.mode, run.target, run.confidence, run.latencyMs, run.costUsd, run.error],
  );
}

export async function setGoldTarget(
  db: Queryable,
  input: { questionId: string; target: string; userId: string; note: string | null },
): Promise<{ previous: string | null } | null> {
  const { rows } = await db.query(
    `UPDATE agent_questions q SET gold_target = $2, gold_labeled_by = $3, gold_labeled_at = now(), gold_note = $4
       FROM (SELECT gold_target AS previous FROM agent_questions WHERE id = $1 FOR UPDATE) old
      WHERE q.id = $1
      RETURNING old.previous`,
    [input.questionId, input.target, input.userId, input.note],
  );
  return rows[0] ? { previous: (rows[0].previous as string | null) ?? null } : null;
}

export type EvalQuestionRow = {
  questionId: string;
  askedAt: string;
  askerRole: string;
  status: string;
  firstQuestion: string;
  goldTarget: string | null;
  answeredAt: string | null;
  runs: { router: string; mode: string; target: string | null; confidence: number | null; latencyMs: number; costUsd: number | null; error: string | null }[];
};

export async function listEvalQuestions(db: Queryable, projectId: string): Promise<EvalQuestionRow[]> {
  const { rows } = await db.query(
    `SELECT q.id, q.created_at, q.asker_role, q.status, q.questions->0->>'question' AS first_question, q.gold_target, q.answered_at,
            coalesce(json_agg(json_build_object(
              'router', r.router, 'mode', r.mode, 'target', r.target, 'confidence', r.confidence,
              'latencyMs', r.latency_ms, 'costUsd', r.cost_usd, 'error', r.error) ORDER BY r.id) FILTER (WHERE r.id IS NOT NULL), '[]') AS runs
       FROM agent_questions q LEFT JOIN question_routing_runs r ON r.question_id = q.id
      WHERE q.project_id = $1
      GROUP BY q.id
      ORDER BY q.created_at`,
    [projectId],
  );
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
  return rows.map((r) => ({
    questionId: r.id as string,
    askedAt: iso(r.created_at)!,
    askerRole: r.asker_role as string,
    status: r.status as string,
    firstQuestion: (r.first_question as string | null) ?? '',
    goldTarget: (r.gold_target as string | null) ?? null,
    answeredAt: iso(r.answered_at),
    runs: (r.runs as EvalQuestionRow['runs']).map((x) => ({ ...x, costUsd: x.costUsd === null ? null : Number(x.costUsd) })),
  }));
}
