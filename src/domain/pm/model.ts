import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.js';
import type { AttemptUsage } from './pricing.js';

// PM이 모델을 부르는 자리. 인터페이스 뒤에 두어 테스트가 가짜 모델을 끼운다(CI는 실제 API를 부르지 않는다 — 비용 0).

export type PmModelRequest = {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens: number;
  // 바뀌지 않는 지침. 앞에 두고 캐시한다(프롬프트 캐시는 앞부분 일치다).
  system: string;
  // 프로젝트 맥락·지시·(교정이면) 위반 목록. 매번 새 단발 호출이다 — 대화를 이어 붙이지 않는다.
  user: string;
  jsonSchema: Record<string, unknown>;
  signal: AbortSignal;
};

export type PmModelResponse = {
  // 해석하기 전에 반드시 먼저 본다. refusal·max_tokens면 JSON이 스키마와 맞지 않을 수 있다.
  stopReason: string | null;
  servedModel: string | null;
  text: string;
  // 시도마다의 사용량(대체 모델이 돌면 둘 이상). 비용은 항목마다 그 모델 가격으로 더한다.
  attempts: AttemptUsage[];
};

export type PmModel = {
  kind: string;
  generate(request: PmModelRequest): Promise<PmModelResponse>;
};

function anthropicModel(apiKey: string): PmModel {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return {
    kind: 'anthropic',
    async generate(req) {
      // 출력이 길어(명세·태스크 수십 개 + 생각) 스트리밍으로 받는다 — 비스트리밍은 HTTP 시간 제한에 걸린다.
      // 대체 모델(fallbacks)은 쓰지 않는다. 계획 작성이 안전 거절에 걸릴 일은 드물고, 켜면 "어느 모델이 한 번 더 도는지"를
      // 서버가 정해 호출 한 번의 비용 상한을 가장 비싼 모델 기준으로 잡아야 했다($3.9). 거절되면 failed(refused) → 대표가 다시 요청한다.
      const stream = client.beta.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          output_config: { effort: req.effort, format: { type: 'json_schema', schema: req.jsonSchema } },
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: req.user }],
        },
        { signal: req.signal },
      );
      const message = await stream.finalMessage();

      const text = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      // usage.iterations가 시도별 정본이다(대체 모델을 다시 켜도 그대로 맞게). 없으면 최상위 usage 하나다.
      const iterations = message.usage.iterations ?? [];
      const attempts: AttemptUsage[] = iterations.flatMap((it) =>
        it.type === 'message' || it.type === 'fallback_message'
          ? [
              {
                model: it.model ?? message.model,
                inputTokens: it.input_tokens,
                outputTokens: it.output_tokens,
                cacheWriteTokens: it.cache_creation_input_tokens,
                cacheReadTokens: it.cache_read_input_tokens,
              },
            ]
          : [],
      );
      if (attempts.length === 0) {
        attempts.push({
          model: message.model,
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        });
      }
      return { stopReason: message.stop_reason, servedModel: message.model, text, attempts };
    },
  };
}

let override: PmModel | null = null;
let cached: PmModel | null = null;

// 테스트가 가짜 모델을 끼운다. 운영 코드에서는 부르지 않는다. 되돌릴 때 쓰도록 이전 값을 돌려준다.
export function setPmModel(next: PmModel | null): PmModel | null {
  const previous = override;
  override = next;
  return previous;
}

// 키가 없으면 null — PM API만 503 PM_UNAVAILABLE이고 나머지 기능은 그대로 돈다.
export function getPmModel(): PmModel | null {
  if (override) return override;
  if (!env.ANTHROPIC_API_KEY) return null;
  cached ??= anthropicModel(env.ANTHROPIC_API_KEY);
  return cached;
}
