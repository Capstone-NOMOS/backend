import { env } from '../../config/env.js';
import { httpQuestionRouter } from './http-router.js';
import { llmQuestionRouter } from './llm-router.js';
import { oppositeRoleRouter, type QuestionRouter, type RoutingDecision, type RoutingInput } from './router.js';

// 지금 쓰는 라우터 — QUESTION_ROUTER로 고른다(기본 llm: PM 모델이 FE·BE·PM 중 고른다). rule은 반대 역할 규칙(PM으로는 가지 않는다).
// Decision AI(Jev 등)를 붙일 때는 QuestionRouter 구현을 하나 더 만들고 여기 선택지에 넣는다 — 서버의 나머지는 인터페이스만 본다.
// 테스트는 setQuestionRouter로 바꿔 끼운다(PM 모델·커밋 검사기와 같은 방식).

// 이름 → 라우터. decision은 DECISION_ROUTER_URL이 있을 때만 있다.
export function routerByName(name: string): QuestionRouter | null {
  if (name === 'rule') return oppositeRoleRouter;
  if (name === 'llm') return llmQuestionRouter;
  if (name === 'decision') return env.DECISION_ROUTER_URL ? httpQuestionRouter(env.DECISION_ROUTER_URL) : null;
  return null;
}

let override: QuestionRouter | null = null;
let shadowOverride: QuestionRouter[] | null = null;

function configured(): QuestionRouter {
  return override ?? routerByName(env.QUESTION_ROUTER) ?? oppositeRoleRouter;
}

// 평가용 그림자 라우터(026) — 실제로 보내지 않고 같은 입력으로 돌려 기록만 한다. 실제로 보낸 라우터와 같은 이름은 뺀다.
export function shadowRouters(primaryName: string): QuestionRouter[] {
  const list =
    shadowOverride ??
    env.QUESTION_SHADOW_ROUTERS.split(',')
      .map((n) => n.trim())
      .filter(Boolean)
      .flatMap((n) => routerByName(n) ?? []);
  return list.filter((r) => r.name !== primaryName);
}

// 테스트용.
export function setShadowRouters(next: QuestionRouter[] | null): void {
  shadowOverride = next;
}

export function setQuestionRouter(next: QuestionRouter | null): QuestionRouter {
  const previous = configured();
  override = next;
  return previous;
}

export const ROUTER_TIMEOUT_MS = 30_000;

// attempted: 먼저 시도한 라우터 이름 — 대체(fallback)됐으면 routedBy와 다르다. 평가 기록(026)이 그 라우터의 실패로 센다.
export type RoutedResult = RoutingDecision & { latencyMs: number; fallback: string | null; attempted: string };

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
    return { ...decision, latencyMs: Date.now() - started, fallback: null, attempted: router.name };
  } catch (err) {
    const decision = await oppositeRoleRouter.route(input);
    return {
      ...decision,
      latencyMs: Date.now() - started,
      fallback: `${router.name}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      attempted: router.name,
    };
  }
}
