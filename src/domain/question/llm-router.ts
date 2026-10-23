import { env } from '../../config/env.js';
import { getPmModel } from '../pm/model.js';
import { costOfAttempts } from '../pm/pricing.js';
import { relayWorkerLastSeen } from '../pm/relay.js';
import { buildRoutingPrompt, parseRoutingResponse, ROUTING_JSON_SCHEMA, ROUTING_PROMPT_VERSION, type QuestionRouter } from './router.js';

// LLM 라우터 — PM 모델(대표 노트북의 PM 에이전트, 또는 API 모드면 서버 키)에게 "이 결정의 권한이 FE·BE·PM 중 누구에게 있나"를 묻는다.
// 프롬프트·해석은 평가 장치와 같은 한 벌(router.ts)이라, 오프라인 비교 결과가 운영과 같은 조건이다.
// Decision AI(Jev 등)로 바꿀 때는 QuestionRouter를 하나 더 만들어 router-registry에서 고른다 — 서버의 나머지는 바뀌지 않는다.
//
// 실패(노트북 꺼짐·시간 초과·형식 오류)는 던진다 — routeQuestion이 규칙 라우터로 대체하고 그 사실(fallback)을 기록한다.

// 대표 노트북의 pm-worker는 3초마다 작업을 묻는다. 이만큼 조용하면 꺼진 것으로 보고 바로 대체한다(30초를 기다리지 않게).
const RELAY_STALE_MS = 30_000;
const ROUTER_MAX_TOKENS = 2_000;

export const llmQuestionRouter: QuestionRouter = {
  name: `llm:pm-model:${ROUTING_PROMPT_VERSION}`,
  async route(input) {
    const model = getPmModel();
    if (!model) throw new Error('no PM model configured (ANTHROPIC_API_KEY or PM_PROVIDER=relay)');
    const orgId = input.context?.orgId;
    if (!orgId) throw new Error('router needs the organization');
    if (model.kind === 'relay') {
      const seen = relayWorkerLastSeen(orgId);
      if (!seen || Date.now() - seen.getTime() > RELAY_STALE_MS) throw new Error("the representative's PM agent (pm-worker) is offline");
    }
    const routedBy = `llm:${model.kind}:${env.PM_MODEL}:${ROUTING_PROMPT_VERSION}`;
    const response = await model.generate({
      model: env.PM_MODEL,
      effort: 'low',
      maxTokens: ROUTER_MAX_TOKENS,
      system: '너는 소프트웨어 팀의 질문 라우터다. 지정한 JSON 형식으로만 답한다.',
      user: buildRoutingPrompt(input),
      jsonSchema: ROUTING_JSON_SCHEMA,
      signal: AbortSignal.timeout(30_000),
      context: { orgId, planId: null, purpose: 'route' },
    });
    if (response.stopReason === 'refusal' || response.stopReason === 'max_tokens') throw new Error(`router stopped: ${response.stopReason}`);
    return { ...parseRoutingResponse(response.text, input, routedBy), costUsd: costOfAttempts(response.attempts) };
  },
};
