import { pool, withTransaction } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../errors.js';
import { appendEvent } from '../events/append.js';
import { findProjectById } from '../project/repository.js';
import { assertProjectVisibleToUser, type UserContext } from '../project/visibility.js';
import { findQuestion } from './repository.js';
import { shadowRouters, ROUTER_TIMEOUT_MS, type RoutedResult } from './router-registry.js';
import type { RoutingInput } from './router.js';
import { insertRoutingRun, listEvalQuestions, setGoldTarget, type EvalQuestionRow } from './routing-eval-repository.js';

// 질문 라우팅 평가(026) — 서비스가 아니라 발표 지표를 위한 기록이다. 서비스 동작(누구에게 보내나)은 바꾸지 않는다.
//
// 지표(발표 15~20쪽):
//   ① 최초 수신자-정답 담당자 일치율 — 라우터 판정이 사람이 붙인 정답(gold_target)과 같은 비율
//      조건 A(기존 다인 개발: 질문한 사람에게 간다) = 모든 질문을 SELF로 본 기준선 'baseline:asker'
//   ② 요청당 비용 — 판정의 모델 비용(USD)   ③ 분류 지연 — 판정에 걸린 시간(ms)
// 같은 실제 질문에 LLM·Decision AI·규칙을 함께 돌려(그림자 실행) 같은 조건에서 비교한다. 기록 실패는 질문 흐름을 막지 않는다.

const BASELINE = 'baseline:asker';
const inflight = new Set<Promise<void>>();

// 질문이 커밋된 뒤 부른다. 실제로 보낸 판정(primary)을 남기고, 그림자 라우터를 뒤에서 돌린다.
export function recordRouting(questionId: string, input: RoutingInput, routed: RoutedResult): void {
  const job = (async () => {
    // 먼저 시도한 라우터가 실패해 규칙으로 대체됐으면, 그 실패도 그 라우터의 기록으로 남긴다(실패율).
    if (routed.fallback !== null) {
      await insertRoutingRun(pool, {
        questionId, router: routed.attempted, mode: 'primary', target: null, confidence: null,
        latencyMs: routed.latencyMs, costUsd: null, error: routed.fallback,
      });
    }
    await insertRoutingRun(pool, {
      questionId,
      router: routed.routedBy,
      mode: 'primary',
      target: routed.target,
      confidence: routed.confidence,
      latencyMs: routed.fallback === null ? routed.latencyMs : 0,
      costUsd: routed.costUsd ?? null,
      error: null,
    });
    await Promise.all(
      shadowRouters(routed.attempted).map(async (router) => {
        const started = Date.now();
        try {
          const decision = await Promise.race([
            router.route(input),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ROUTER_TIMEOUT_MS}ms`)), ROUTER_TIMEOUT_MS).unref()),
          ]);
          await insertRoutingRun(pool, {
            questionId, router: decision.routedBy, mode: 'shadow', target: decision.target, confidence: decision.confidence,
            latencyMs: Date.now() - started, costUsd: decision.costUsd ?? null, error: null,
          });
        } catch (err) {
          await insertRoutingRun(pool, {
            questionId, router: router.name, mode: 'shadow', target: null, confidence: null,
            latencyMs: Date.now() - started, costUsd: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
          });
        }
      }),
    );
  })()
    .catch((err: unknown) => logger.warn('라우팅 평가 기록 실패 — 질문 흐름에는 영향 없음', { questionId, error: String(err) }))
    .finally(() => inflight.delete(job));
  inflight.add(job);
}

// 테스트용.
export async function drainRoutingRecords(): Promise<void> {
  while (inflight.size > 0) await Promise.all([...inflight]);
}

// 정답 담당자 붙이기 — 대표가 질문을 보고 "원래 누구에게 갔어야 했나"를 정한다. 다시 붙이면 바뀐다(이전 값은 이벤트에).
export async function labelGold(actor: UserContext, questionId: string, target: string, note: string | null): Promise<{ questionId: string; goldTarget: string }> {
  if (actor.orgRole !== 'REPRESENTATIVE') throw new AppError('NOT_REPRESENTATIVE', 'only the representative labels the correct owner');
  const question = await findQuestion(pool, questionId);
  if (!question) throw new AppError('QUESTION_NOT_FOUND', `question ${questionId} not found`);
  const project = await findProjectById(pool, question.projectId);
  // 지운 프로젝트(029)의 질문은 없는 것으로 본다.
  if (!project) throw new AppError('QUESTION_NOT_FOUND', `question ${questionId} not found`);
  if (project.orgId !== actor.orgId) throw new AppError('CROSS_ORG_ACCESS', 'cannot access another organization');
  await withTransaction(async (tx) => {
    const done = await setGoldTarget(tx, { questionId, target, userId: actor.userId, note });
    if (!done) throw new AppError('QUESTION_NOT_FOUND', `question ${questionId} not found`);
    await appendEvent(tx, {
      orgId: actor.orgId,
      projectId: question.projectId,
      type: 'QUESTION_GOLD_LABELED',
      onBehalfOf: actor.userId,
      payload: { questionId, goldTarget: target, previousGoldTarget: done.previous },
    });
  });
  return { questionId, goldTarget: target };
}

export type RouterStats = {
  router: string;
  mode: 'primary' | 'shadow' | 'baseline';
  decisions: number;
  errors: number;
  labeled: number;
  aligned: number;
  // 정답이 붙은 질문 중 판정이 정답과 같은 비율(0~1). 정답이 붙은 질문이 없으면 null.
  alignmentRate: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  avgCostUsd: number | null;
  totalCostUsd: number | null;
};

export type RoutingReport = {
  projectId: string;
  questions: number;
  labeled: number;
  routers: RouterStats[];
  // 질문부터 답까지(실제로 보낸 라우터 기준) — 답이 온 질문만.
  answer: { answered: number; medianMs: number | null };
  rows: (Omit<EvalQuestionRow, 'runs'> & { decisions: Record<string, string | null> })[];
};

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const avg = (values: number[]) => (values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length);

export async function routingReport(actor: UserContext, projectId: string): Promise<RoutingReport> {
  if (actor.orgRole !== 'REPRESENTATIVE') throw new AppError('NOT_REPRESENTATIVE', 'only the representative reads the routing report');
  await assertProjectVisibleToUser(pool, actor, projectId);
  const questions = await listEvalQuestions(pool, projectId);

  type Sample = { questionId: string; target: string | null; latencyMs: number; costUsd: number | null; error: string | null };
  const byRouter = new Map<string, { mode: RouterStats['mode']; samples: Sample[] }>();
  const add = (router: string, mode: RouterStats['mode'], s: Sample) => {
    const entry = byRouter.get(router) ?? { mode, samples: [] };
    entry.samples.push(s);
    byRouter.set(router, entry);
  };
  for (const q of questions) {
    add(BASELINE, 'baseline', { questionId: q.questionId, target: 'SELF', latencyMs: 0, costUsd: 0, error: null });
    for (const r of q.runs) add(r.router, r.mode as 'primary' | 'shadow', { questionId: q.questionId, ...r });
  }
  const gold = new Map(questions.map((q) => [q.questionId, q.goldTarget]));

  const routers: RouterStats[] = [...byRouter.entries()].map(([router, { mode, samples }]) => {
    const decided = samples.filter((s) => s.target !== null);
    const labeled = decided.filter((s) => gold.get(s.questionId) != null);
    const aligned = labeled.filter((s) => s.target === gold.get(s.questionId)).length;
    const latencies = decided.map((s) => s.latencyMs);
    const costs = decided.map((s) => s.costUsd).filter((c): c is number => c !== null);
    return {
      router,
      mode,
      decisions: decided.length,
      errors: samples.length - decided.length,
      labeled: labeled.length,
      aligned,
      alignmentRate: labeled.length === 0 ? null : aligned / labeled.length,
      avgLatencyMs: avg(latencies) === null ? null : Math.round(avg(latencies)!),
      p95LatencyMs: percentile(latencies, 95),
      avgCostUsd: avg(costs),
      totalCostUsd: costs.length === 0 ? null : costs.reduce((s, c) => s + c, 0),
    };
  });

  const answeredMs = questions
    .filter((q) => q.answeredAt !== null)
    .map((q) => new Date(q.answeredAt!).getTime() - new Date(q.askedAt).getTime());

  return {
    projectId,
    questions: questions.length,
    labeled: questions.filter((q) => q.goldTarget !== null).length,
    routers: routers.sort((a, b) => a.mode.localeCompare(b.mode) || a.router.localeCompare(b.router)),
    answer: { answered: answeredMs.length, medianMs: percentile(answeredMs, 50) },
    rows: questions.map(({ runs, ...q }) => ({
      ...q,
      decisions: Object.fromEntries([[BASELINE, 'SELF'], ...runs.map((r) => [r.router, r.target] as const)]),
    })),
  };
}
