import { env } from '../../config/env.js';
import { anthropicModel } from './anthropic-model.js';
import type { PmModel } from './model-types.js';
import { relayModel } from './relay.js';

export type { PmModel, PmModelRequest, PmModelResponse, RelayPurpose } from './model-types.js';

// PM이 모델을 부르는 자리. 인터페이스 뒤에 두어 테스트가 가짜 모델을 끼운다(CI는 실제 API를 부르지 않는다 — 비용 0).
// 타입은 model-types.ts, API 호출은 anthropic-model.ts(둘 다 env 없이 — 평가 스크립트가 같이 쓴다).

let override: PmModel | null = null;
let cached: PmModel | null = null;

// 테스트가 가짜 모델을 끼운다. 운영 코드에서는 부르지 않는다. 되돌릴 때 쓰도록 이전 값을 돌려준다.
export function setPmModel(next: PmModel | null): PmModel | null {
  const previous = override;
  override = next;
  return previous;
}

// PM_PROVIDER=relay면 대표 노트북의 pm-worker가 실행한다(결제 전 임시). api면 서버가 Anthropic API를 직접 부른다.
// api인데 키가 없으면 null — PM API만 503 PM_UNAVAILABLE이고 나머지 기능은 그대로 돈다.
export function getPmModel(): PmModel | null {
  if (override) return override;
  if (env.PM_PROVIDER === 'relay') return relayModel;
  return apiModel();
}

function apiModel(): PmModel | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  cached ??= anthropicModel(env.ANTHROPIC_API_KEY);
  return cached;
}

// 질문 라우터(llm)가 쓰는 모델. QUESTION_ROUTER_LLM_PROVIDER=api면 PM이 중계 모드여도 서버 키로 직접 부르고, pm이면 PM과 같은 경로다.
// 테스트가 끼운 가짜 모델은 어느 쪽이든 그대로 쓴다.
export function getRouterModel(): PmModel | null {
  if (override) return override;
  return env.QUESTION_ROUTER_LLM_PROVIDER === 'api' ? apiModel() : getPmModel();
}
