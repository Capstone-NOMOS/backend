import { env } from '../../config/env.js';
import { llmQuestionRouter } from './llm-router.js';
import { oppositeRoleRouter, type QuestionRouter, type RoutingDecision, type RoutingInput } from './router.js';

// 지금 쓰는 라우터 — QUESTION_ROUTER로 고른다(기본 llm: PM 모델이 FE·BE·PM 중 고른다). rule은 반대 역할 규칙(PM으로는 가지 않는다).
// Decision AI(Jev 등)를 붙일 때는 QuestionRouter 구현을 하나 더 만들고 여기 선택지에 넣는다 — 서버의 나머지는 인터페이스만 본다.
// 테스트는 setQuestionRouter로 바꿔 끼운다(PM 모델·커밋 검사기와 같은 방식).

const ROUTERS: Record<string, QuestionRouter> = { rule: oppositeRoleRouter, llm: llmQuestionRouter };

let override: QuestionRouter | null = null;

function configured(): QuestionRouter {
  return override ?? ROUTERS[env.QUESTION_ROUTER] ?? oppositeRoleRouter;
}

export function setQuestionRouter(next: QuestionRouter | null): QuestionRouter {
  const previous = configured();
  override = next;
  return previous;
}

export const ROUTER_TIMEOUT_MS = 30_000;

export type RoutedResult = RoutingDecision & { latencyMs: number; fallback: string | null };

// 라우터가 실패하거나 늦으면 규칙 라우터로 대체한다 — 질문이 라우팅 때문에 막히면 에이전트가 멈춘다.
// 대체된 사실(fallback)은 기록한다. 조용히 넘기면 그 라우터의 실패율이 지표에서 사라진다.
export async function routeQuestion(input: RoutingInput): Promise<RoutedResult> {
  const router = configured();
  const started = Date.now();
  try {
    const decision = await Promise.race([
      router.route(input),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`router timed out after ${ROUTER_TIMEOUT_MS}ms`)), ROUTER_TIMEOUT_MS).unref()),
    ]);
    return { ...decision, latencyMs: Date.now() - started, fallback: null };
  } catch (err) {
    const decision = await oppositeRoleRouter.route(input);
    return { ...decision, latencyMs: Date.now() - started, fallback: `${router.name}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
  }
}
