import { buildRoutingPrompt, parseRoutingResponse, ROUTING_JSON_SCHEMA, ROUTING_PROMPT_VERSION, type QuestionRouter } from './router.js';

// OpenAI 라우터 — llm(Claude)과 **같은 프롬프트·해석**(router.ts)으로 OpenAI 모델에게 판정을 시킨다. 발표 비교의 한 축(Claude · OpenAI · Jev).
// Responses API를 fetch로 부른다(SDK 의존성 없음). 출력은 엄격한 JSON Schema(strict)로 강제한다 — ROUTING_JSON_SCHEMA가 그 조건(전 필드 required,
// additionalProperties false)을 이미 만족한다.
// 이 파일은 설정(env)을 import하지 않는다 — 오프라인 평가 장치(scripts/eval-question-router.ts)가 서버 비밀값 없이 그대로 쓴다.
// 조직 id(context)는 보내지 않는다. 질문·명세 본문이 OpenAI로 나간다.

// 1M 토큰당 USD — OpenAI 공식 가격(standard, 2026-11 기준). 바뀌면 여기 한 곳만 고친다.
// 모르는 모델은 비용 null("모름")이다 — 지표용이라 지어낸 값보다 빈칸이 낫다(PM 예산 검사처럼 최댓값으로 잡을 이유가 없다).
const OPENAI_PRICES: Record<string, { input: number; cachedInput: number; output: number }> = {
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50 },
  'gpt-6.1-sol': { input: 2, cachedInput: 0.1, output: 10 },
  'gpt-6.1-terra': { input: 1, cachedInput: 0.05, output: 5 },
  'gpt-6-sol': { input: 2, cachedInput: 0.2, output: 10 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
};

export const OPENAI_ROUTER_DEFAULT_MODEL = 'gpt-6.1-sol'; // Claude Sonnet 5.5(llm 기본)와 같은 가격대 — 같은 체급끼리 비교한다
export const OPENAI_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type OpenAiReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number];

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const MAX_OUTPUT_TOKENS = 2_000; // llm 라우터와 같다(생각 + 짧은 JSON)
const SYSTEM = '너는 소프트웨어 팀의 질문 라우터다. 지정한 JSON 형식으로만 답한다.'; // llm 라우터와 같은 문장

type OpenAiUsage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
type OpenAiResponse = {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: OpenAiUsage;
};

export function openAiCost(model: string, usage: OpenAiUsage | undefined): number | null {
  const price = OPENAI_PRICES[model];
  if (!price || !usage) return null;
  const input = usage.input_tokens ?? 0;
  const cached = Math.min(usage.input_tokens_details?.cached_tokens ?? 0, input);
  const usd = ((input - cached) * price.input + cached * price.cachedInput + (usage.output_tokens ?? 0) * price.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export type OpenAiRouterOptions = {
  apiKey: string;
  model?: string;
  effort?: OpenAiReasoningEffort;
  fetchImpl?: typeof fetch;
};

export function openAiQuestionRouter(options: OpenAiRouterOptions): QuestionRouter {
  const model = options.model ?? OPENAI_ROUTER_DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const routedBy = `openai:${model}:${ROUTING_PROMPT_VERSION}`;
  return {
    name: routedBy,
    async route(input) {
      // 판정 시간(modelLatencyMs) = 요청을 보내 응답 본문을 다 받을 때까지. 프롬프트 조립·해석은 넣지 않는다.
      const body = JSON.stringify({
        model,
        instructions: SYSTEM,
        input: buildRoutingPrompt(input),
        max_output_tokens: MAX_OUTPUT_TOKENS,
        ...(options.effort ? { reasoning: { effort: options.effort } } : {}),
        text: { format: { type: 'json_schema', name: 'routing', strict: true, schema: ROUTING_JSON_SCHEMA } },
        store: false,
      });
      const started = Date.now();
      const res = await fetchImpl(OPENAI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      // 응답 본문은 에러 메시지에 싣지 않는다 — 상태 코드만(본문에 요청 일부가 되돌아올 수 있다).
      if (!res.ok) throw new Error(`${routedBy} returned ${res.status}`);
      const response = (await res.json()) as OpenAiResponse;
      const modelLatencyMs = Date.now() - started;
      // llm 라우터처럼 끝난 이유부터 본다 — 잘렸거나 거절이면 JSON이 스키마와 맞지 않을 수 있다.
      if (response.status !== 'completed') throw new Error(`router stopped: ${response.incomplete_details?.reason ?? response.status ?? 'unknown'}`);
      const parts = (response.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []);
      if (parts.some((p) => p.type === 'refusal')) throw new Error('router stopped: refusal');
      const text = parts.flatMap((p) => (p.type === 'output_text' && p.text ? [p.text] : [])).join('');
      return { ...parseRoutingResponse(text, input, routedBy), costUsd: openAiCost(model, response.usage), modelLatencyMs };
    },
  };
}
