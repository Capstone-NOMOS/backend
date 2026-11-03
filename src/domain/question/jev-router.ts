import { buildRoutingContext, normalizeTarget, PM_TARGET, ROUTING_PROMPT_VERSION, selfRule, TARGET_DESCRIPTIONS, type QuestionRouter, type RoutingInput } from './router.js';

// Jev 라우터 — TypeSafe의 결정 모델(System One API, https://docs.typesafe.ai/api). 글을 생성하지 않고 choice 질문에 확률로 답한다.
// 발표 비교의 한 축(Claude · OpenAI · Jev). LLM 계열과 **같은 맥락 문장**(buildRoutingContext)을 state로, 같은 후보 설명(TARGET_DESCRIPTIONS)을
// choice의 기준(criteria)으로 넣고, 고른 값은 같은 해석(normalizeTarget)을 탄다 — 입력이 갈리면 모델 비교가 아니라 프롬프트 비교가 된다.
// 이 파일은 설정(env)을 import하지 않는다 — 오프라인 평가 장치가 서버 비밀값 없이 그대로 쓴다.
// 조직 id(context)는 보내지 않는다. 질문·명세 본문이 TypeSafe로 나간다.

// 1M 입력 토큰당 USD — TypeSafe 공식 가격(2026-11, https://docs.typesafe.ai/models). 출력 토큰은 지금 무료다. 바뀌면 여기 한 곳만.
// 별칭(jev-latest·jev-preview)은 가리키는 버전이 바뀌므로 응답의 model(실제로 답한 버전)로 값을 찾는다. 모르는 모델은 비용 null.
const JEV_INPUT_PRICES: Record<string, number> = {
  'jev-1.14.0': 0.042,
  'jev-1.13.0': 0.042,
};

// 운영은 고정 버전을 쓴다 — 별칭은 실험 도중 모델이 바뀌어 같은 라우터 이름 아래 다른 모델의 결과가 섞인다.
export const JEV_DEFAULT_MODEL = 'jev-1.14.0';
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const QUESTION_KEY = 'owner';
const SELF = 'SELF';

type JevResponse = {
  model?: string;
  answers?: Record<string, { type?: string; choice?: unknown; confidence?: unknown; probabilities?: Record<string, unknown> }>;
  usage?: { input_tokens?: number };
};

// 고를 수 있는 값과 그 설명. 질문한 역할 자신은 SELF 하나로만 둔다 — 둘 다 두면 확률이 FRONTEND와 SELF로 갈라져 엉뚱한 쪽이 최댓값이 된다
// (LLM 해석이 자기 역할 이름을 SELF로 바꾸는 것과 같은 뜻). PM이 물으면 SELF가 없고 PM 소관은 PM(대표가 확정)이다.
export function jevCriteria(input: RoutingInput): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const role of input.roles) {
    if (role !== input.askerRole) criteria[role] = TARGET_DESCRIPTIONS[role];
  }
  criteria[PM_TARGET] = TARGET_DESCRIPTIONS[PM_TARGET];
  if (input.askerRole !== 'PM') criteria[SELF] = `질문한 역할(${input.askerRole}) 자신이 정할 수 있는 것 — 남에게 물을 일이 아니다`;
  return criteria;
}

export function jevRequestBody(model: string, input: RoutingInput): Record<string, unknown> {
  return {
    model,
    state: buildRoutingContext(input).filter((line) => line !== '').join('\n'),
    questions: {
      [QUESTION_KEY]: {
        type: 'choice',
        instructions: ['이 질문의 답을 정할 권한이 어느 역할에 있는가?', selfRule(input), '질문이 여러 개면 대부분을 정할 역할 하나를 고른다.'].join('\n'),
        criteria: jevCriteria(input),
      },
    },
  };
}

export function jevCost(model: string, inputTokens: number | undefined): number | null {
  const price = JEV_INPUT_PRICES[model];
  if (price === undefined || inputTokens === undefined) return null;
  return Math.round(((inputTokens * price) / 1_000_000) * 1e9) / 1e9;
}

export type JevRouterOptions = {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
};

export function jevQuestionRouter(options: JevRouterOptions): QuestionRouter {
  const model = options.model ?? JEV_DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const routedBy = `jev:${model}:${ROUTING_PROMPT_VERSION}`;
  return {
    name: routedBy,
    async route(input) {
      // 판정 시간(modelLatencyMs) = 요청을 보내 응답 본문을 다 받을 때까지(openai 라우터와 같은 정의).
      const requestBody = JSON.stringify(jevRequestBody(model, input));
      const started = Date.now();
      const res = await fetchImpl(JEV_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
        body: requestBody,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`${routedBy} returned ${res.status}`);
      const body = (await res.json()) as JevResponse;
      const modelLatencyMs = Date.now() - started;
      const answer = body.answers?.[QUESTION_KEY];
      if (!answer || answer.type !== 'choice') throw new Error(`${routedBy} returned no choice answer`);
      const target = normalizeTarget(answer.choice, input);
      const confidence = typeof answer.confidence === 'number' && answer.confidence >= 0 && answer.confidence <= 1 ? answer.confidence : null;
      // Jev는 이유 문장을 내지 않는다 — 대신 후보별 확률을 남긴다(판정이 얼마나 갈렸는지가 보인다).
      const reason = Object.entries(answer.probabilities ?? {})
        .flatMap(([k, p]) => (typeof p === 'number' ? [[k, p] as const] : []))
        .sort((a, b) => b[1] - a[1])
        .map(([k, p]) => `${k} ${p.toFixed(2)}`)
        .join(', ');
      return { target, confidence, reason: reason ? `확률: ${reason}`.slice(0, 300) : null, routedBy, costUsd: jevCost(body.model ?? model, body.usage?.input_tokens), modelLatencyMs };
    },
  };
}
