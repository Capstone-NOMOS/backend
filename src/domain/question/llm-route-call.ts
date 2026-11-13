import { costOfAttempts } from '../pm/pricing.js';
import type { PmModel, RelayPurpose } from '../pm/model-types.js';
import { buildRoutingPrompt, parseRoutingResponse, ROUTING_JSON_SCHEMA, type RoutingDecision, type RoutingInput } from './router.js';

// llm 라우터의 모델 호출 한 벌 — 운영(llm-router.ts)과 오프라인 평가(scripts/lib/question-routers.ts의 claude-api)가 같이 쓴다.
// 지침·노력 수준·출력 한도·시간 제한이 갈리면 라우터 비교가 설정 비교가 된다. 서버 설정(env)을 import하지 않는다.
export const LLM_ROUTER_SYSTEM = '너는 소프트웨어 팀의 질문 라우터다. 지정한 JSON 형식으로만 답한다.';
const ROUTER_MAX_TOKENS = 2_000;

export async function routeWithLlm(
  model: PmModel,
  modelName: string,
  input: RoutingInput,
  routedBy: string,
  context?: { orgId: string; planId: null; purpose: RelayPurpose },
): Promise<RoutingDecision> {
  const response = await model.generate({
    model: modelName,
    effort: 'low',
    maxTokens: ROUTER_MAX_TOKENS,
    system: LLM_ROUTER_SYSTEM,
    user: buildRoutingPrompt(input),
    jsonSchema: ROUTING_JSON_SCHEMA,
    signal: AbortSignal.timeout(30_000),
    ...(context ? { context } : {}),
  });
  if (response.stopReason === 'refusal' || response.stopReason === 'max_tokens') throw new Error(`router stopped: ${response.stopReason}`);
  return { ...parseRoutingResponse(response.text, input, routedBy), costUsd: costOfAttempts(response.attempts), modelLatencyMs: response.modelLatencyMs ?? null };
}
