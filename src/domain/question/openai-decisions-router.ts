import { jevCriteria } from './jev-router.js';
import { buildRoutingContext, normalizeTarget, ROUTING_PROMPT_VERSION, selfRule, type QuestionRouter, type RoutingInput } from './router.js';

// OpenAI Decisions API 라우터 — OpenAI의 결정 전용 엔드포인트(POST /v1/decisions, GA 2026-10-22, 모델은 gpt-6-luna 하나).
// 글을 생성하지 않고 choice 질문에 확률로 답한다 — TypeSafe Jev와 같은 종류라 "결정 전용 API끼리" 비교하는 축이다(대표 결정 2026-11-13).
// 입력은 Jev와 한 벌이다: 같은 맥락 문장(buildRoutingContext)을 input으로, 같은 후보·설명(jevCriteria)을 choices로, 같은 지시문을 instructions로.
// 고른 값은 같은 해석(normalizeTarget)을 탄다 — 입력이 갈리면 모델 비교가 아니라 프롬프트 비교가 된다.
// 형식은 공식 문서(developers.openai.com/api/reference/resources/decisions/methods/create, guides/decisions) 기준.
// 이 파일은 설정(env)을 import하지 않는다 — 오프라인 평가 장치가 서버 비밀값 없이 그대로 쓴다. 조직 id(context)는 보내지 않는다.

// 1M 토큰당 USD — 공식 가격(guides/decisions·pricing, 2026-11): 캐시 안 된 입력 $0.10, 캐시 읽기 $0.01, 캐시 쓰기(30분) $0.125. 출력은 과금하지 않는다.
// cached·cache_write 토큰은 usage.input_tokens 안에 들어 있다(문서: "don't add them to that total"). 모르는 모델은 비용 null.
const DECISIONS_PRICES: Record<string, { input: number; cachedInput: number; cacheWrite: number }> = {
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125 },
};

export const OPENAI_DECISIONS_MODEL = 'gpt-6-luna'; // Decisions API가 받는 유일한 모델
const DECISIONS_URL = 'https://api.openai.com/v1/decisions';
const QUESTION_NAME = 'owner';

type DecisionsUsage = {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
};

type DecisionsResponse = {
  model?: string;
  answers?: { type?: string; name?: string | null; choice?: unknown; confidence?: unknown; probabilities?: { value?: unknown; probability?: unknown }[] }[];
  usage?: DecisionsUsage;
};

export function decisionsRequestBody(model: string, input: RoutingInput): Record<string, unknown> {
  return {
    model,
    input: buildRoutingContext(input).filter((line) => line !== '').join('\n'),
    questions: [
      {
        type: 'choice',
        name: QUESTION_NAME,
        instructions: ['이 질문의 답을 정할 권한이 어느 역할에 있는가?', selfRule(input), '질문이 여러 개면 대부분을 정할 역할 하나를 고른다.'].join('\n'),
        choices: Object.entries(jevCriteria(input)).map(([value, description]) => ({ value, description })),
      },
    ],
  };
}

export function decisionsCost(model: string, usage: DecisionsUsage | undefined): number | null {
  const price = DECISIONS_PRICES[model];
  if (!price || usage?.input_tokens === undefined) return null;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const written = usage.input_tokens_details?.cache_write_tokens ?? 0;
  const fresh = Math.max(0, usage.input_tokens - cached - written);
  const usd = (fresh * price.input + cached * price.cachedInput + written * price.cacheWrite) / 1_000_000;
  return Math.round(usd * 1e9) / 1e9;
}

export type OpenAiDecisionsRouterOptions = {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
};

export function openAiDecisionsQuestionRouter(options: OpenAiDecisionsRouterOptions): QuestionRouter {
  const model = options.model ?? OPENAI_DECISIONS_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const routedBy = `openai-decisions:${model}:${ROUTING_PROMPT_VERSION}`;
  return {
    name: routedBy,
    async route(input) {
      // 판정 시간(modelLatencyMs) = 요청을 보내 응답 본문을 다 받을 때까지(openai·jev 라우터와 같은 정의).
      const requestBody = JSON.stringify(decisionsRequestBody(model, input));
      const started = Date.now();
      const res = await fetchImpl(DECISIONS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
        body: requestBody,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`${routedBy} returned ${res.status}`);
      const body = (await res.json()) as DecisionsResponse;
      const modelLatencyMs = Date.now() - started;
      const answer = body.answers?.find((a) => a.name === QUESTION_NAME) ?? body.answers?.[0];
      if (answer?.type === 'refusal') throw new Error(`${routedBy} refused to answer`);
      if (!answer || answer.type !== 'choice') throw new Error(`${routedBy} returned no choice answer`);
      const target = normalizeTarget(answer.choice, input);
      const confidence = typeof answer.confidence === 'number' && answer.confidence >= 0 && answer.confidence <= 1 ? answer.confidence : null;
      // 이유 문장 대신 후보별 확률을 남긴다(Jev와 같은 모양).
      const reason = (answer.probabilities ?? [])
        .flatMap((p) => (typeof p.probability === 'number' ? [[String(p.value), p.probability] as const] : []))
        .sort((a, b) => b[1] - a[1])
        .map(([k, p]) => `${k} ${p.toFixed(2)}`)
        .join(', ');
      return { target, confidence, reason: reason ? `확률: ${reason}`.slice(0, 300) : null, routedBy, costUsd: decisionsCost(body.model ?? model, body.usage), modelLatencyMs };
    },
  };
}
