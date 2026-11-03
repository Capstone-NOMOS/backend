import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { httpQuestionRouter } from './http-router.js';
import { jevQuestionRouter } from './jev-router.js';
import { llmQuestionRouter } from './llm-router.js';
import { openAiQuestionRouter } from './openai-router.js';
import { PM_TARGET, type QuestionRouter, type RoutingDecision, type RoutingInput } from './router.js';

// 지금 쓰는 라우터 — QUESTION_ROUTER로 고른다: llm(기본, PM 모델(Claude)이 FE·BE·PM 중 고른다) · openai(OpenAI, 같은 프롬프트) ·
// jev(TypeSafe의 결정 모델) · decision(임의의 외부 결정 모델, DECISION_ROUTER_URL). 발표 비교는 llm·openai·jev 셋이다.
// 라우터가 실패하면 대표(PM)에게 보낸다 — 대표는 어느 질문에든 답할 수 있다. 반대 역할 규칙은 쓰지 않는다(대표 결정 2026-10-24).
// 테스트는 setQuestionRouter로 바꿔 끼우고, 기본은 setup에서 정한 결정적 라우터다(CI는 모델을 부르지 않는다).

// 이름 → 라우터. llm 말고는 키·주소가 있을 때만 있다.
export function routerByName(name: string): QuestionRouter | null {
  if (name === 'llm') return llmQuestionRouter;
  if (name === 'openai') {
    return env.OPENAI_API_KEY ? openAiQuestionRouter({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_ROUTER_MODEL, effort: env.OPENAI_ROUTER_EFFORT }) : null;
  }
  if (name === 'jev') return env.TYPESAFE_API_KEY ? jevQuestionRouter({ apiKey: env.TYPESAFE_API_KEY, model: env.JEV_MODEL }) : null;
  if (name === 'decision') return env.DECISION_ROUTER_URL ? httpQuestionRouter(env.DECISION_ROUTER_URL) : null;
  return null;
}

function shadowRouterNames(): string[] {
  return env.QUESTION_SHADOW_ROUTERS.split(',')
    .map((n) => n.trim())
    .filter(Boolean);
}

// 서버 기동 때 한 번 — 그림자 라우터 중 키·주소가 없거나 이름이 틀려 빠지는 것을 알린다. 기동은 막지 않는다(서비스 동작이 아니라 평가 기록이다).
// 조용히 빠지면 보고서에서 그 라우터가 "기록 없음"으로만 보여 왜 비었는지 알 수 없다.
export function warnUnavailableShadowRouters(): void {
  const missing = shadowRouterNames().filter((n) => routerByName(n) === null);
  if (missing.length > 0) {
    logger.warn('QUESTION_SHADOW_ROUTERS 중 쓸 수 없는 라우터는 기록하지 않는다(이름이 틀렸거나 키·주소가 없다)', { missing });
  }
}

let override: QuestionRouter | null = null;
let testBase: QuestionRouter | null = null;
let shadowOverride: QuestionRouter[] | null = null;

function configured(): QuestionRouter {
  return override ?? testBase ?? routerByName(env.QUESTION_ROUTER) ?? llmQuestionRouter;
}

// 테스트 전체의 기본 라우터(tests/setup-invariants.ts). setQuestionRouter(null)이 여기로 돌아온다. 운영 코드에서는 부르지 않는다.
export function setTestBaseRouter(next: QuestionRouter | null): void {
  testBase = next;
}

// 평가용 그림자 라우터(026) — 실제로 보내지 않고 같은 입력으로 돌려 기록만 한다. 실제로 보낸 라우터와 같은 이름은 뺀다.
export function shadowRouters(primaryName: string): QuestionRouter[] {
  const list = shadowOverride ?? shadowRouterNames().flatMap((n) => routerByName(n) ?? []);
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
export const FALLBACK_ROUTED_BY = 'fallback:representative';

// attempted: 먼저 시도한 라우터 이름 — 대체(fallback)됐으면 routedBy와 다르다. 평가 기록(026)이 그 라우터의 실패로 센다.
export type RoutedResult = RoutingDecision & { latencyMs: number; fallback: string | null; attempted: string };

// 라우터가 실패하거나 늦으면 대표(PM)에게 보낸다 — 질문이 라우팅 때문에 막히면 에이전트가 멈추고, 대표는 어느 질문에든 답할 수 있다.
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
    const decision: RoutingDecision = { target: PM_TARGET, confidence: null, reason: '라우터 실패 — 대표가 판단한다', routedBy: FALLBACK_ROUTED_BY };
    return {
      ...decision,
      latencyMs: Date.now() - started,
      fallback: `${router.name}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      attempted: router.name,
    };
  }
}
