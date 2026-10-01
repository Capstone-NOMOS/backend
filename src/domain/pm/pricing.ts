// PM 호출 비용 계산(USD). 가격은 1M 토큰당 — Anthropic 공식 가격(2026-09 기준). 바뀌면 여기 한 곳만 고친다.
//
// 비용은 **시도마다** 그 시도를 실행한 모델의 가격으로 계산해 더한다(지금은 대체 모델을 쓰지 않아 시도는 하나지만,
// 다시 켜면 거절된 첫 시도도 과금되므로 최종 응답의 model 하나로 계산하면 적게 잡힌다). 캐시 쓰기(입력가 × 1.25, 5분)와 읽기(모델별)는 가격이 달라
// 따로 센다 — "캐시 토큰"으로 묶으면 틀린다.

export type ModelPrice = { input: number; output: number; cacheRead: number };

const PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
};

const CACHE_WRITE_MULTIPLIER = 1.25; // 5분 캐시 쓰기

// 모르는 모델(새 대체 모델 등)은 표에서 가장 비싼 가격으로 계산한다 — 예산 검사가 느슨해지는 쪽으로 틀리지 않게.
const MOST_EXPENSIVE: ModelPrice = Object.values(PRICES).reduce((max, p) => ({
  input: Math.max(max.input, p.input),
  output: Math.max(max.output, p.output),
  cacheRead: Math.max(max.cacheRead, p.cacheRead),
}));

export function priceOf(model: string): ModelPrice {
  return PRICES[model] ?? MOST_EXPENSIVE;
}

export type AttemptUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

export function costOfAttempts(attempts: AttemptUsage[]): number {
  let usd = 0;
  for (const a of attempts) {
    const p = priceOf(a.model);
    usd +=
      (a.inputTokens * p.input +
        a.cacheWriteTokens * p.input * CACHE_WRITE_MULTIPLIER +
        a.cacheReadTokens * p.cacheRead +
        a.outputTokens * p.output) /
      1_000_000;
  }
  return round6(usd);
}

// 호출 한 번의 최대 비용 — 예산 사전 검사와, 끊긴 호출(재시작·시간 제한)의 정산에 쓴다.
// 대체 모델을 쓰지 않으므로 그 모델로 한 번 도는 경우가 최대다(출력은 max_tokens 전부, 입력은 전부 캐시 쓰기로 가정).
// 대체 모델(fallbacks)을 다시 켜면 두 번 도는 경우를 더해야 한다 — 안 그러면 예산 검사가 실제보다 느슨해진다.
export function maxCallCost(model: string, inputTokensEstimate: number, maxTokens: number): number {
  const primary = priceOf(model);
  const perAttempt = (p: ModelPrice) =>
    (inputTokensEstimate * p.input * CACHE_WRITE_MULTIPLIER + maxTokens * p.output) / 1_000_000;
  return round6(perAttempt(primary));
}

// 입력 토큰 추정. 한국어는 대략 글자당 1토큰 이상이라 글자 수를 그대로 쓴다(보수적).
export function estimateInputTokens(...texts: string[]): number {
  return texts.reduce((n, t) => n + t.length, 0);
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
