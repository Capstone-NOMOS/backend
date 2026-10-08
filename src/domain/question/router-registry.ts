import { oppositeRoleRouter, type QuestionRouter, type RoutingDecision, type RoutingInput } from './router.js';

// 지금 쓰는 라우터. 서버 기본은 반대 역할 규칙이고, 실험·테스트가 setQuestionRouter로 바꿔 끼운다(PM 모델·커밋 검사기와 같은 방식).
// 다른 구현(LLM·Jev)은 평가 장치에서 먼저 비교하고, 서버에 붙일 때 여기에 설정값으로 고르는 자리를 만든다.

let current: QuestionRouter = oppositeRoleRouter;

export function setQuestionRouter(next: QuestionRouter | null): QuestionRouter {
  const previous = current;
  current = next ?? oppositeRoleRouter;
  return previous;
}

export const ROUTER_TIMEOUT_MS = 30_000;

export type RoutedResult = RoutingDecision & { latencyMs: number; fallback: string | null };

// 라우터가 실패하거나 늦으면 규칙 라우터로 대체한다 — 질문이 라우팅 때문에 막히면 에이전트가 멈춘다.
// 대체된 사실(fallback)은 기록한다. 조용히 넘기면 그 라우터의 실패율이 지표에서 사라진다.
export async function routeQuestion(input: RoutingInput): Promise<RoutedResult> {
  const router = current;
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
