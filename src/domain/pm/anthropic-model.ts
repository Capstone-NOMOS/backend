import Anthropic from '@anthropic-ai/sdk';
import type { AttemptUsage } from './pricing.js';
import type { PmModel } from './model-types.js';

// Anthropic API를 직접 부르는 PM 모델. 서버 설정(env)을 import하지 않는다 — 키를 인자로 받아,
// 오프라인 평가 스크립트가 운영 llm 라우터와 같은 호출을 같은 코드로 한다(라우터 비교가 같은 조건이 되게).

export function anthropicModel(apiKey: string): PmModel {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return {
    kind: 'anthropic',
    async generate(req) {
      // 출력이 길어(명세·태스크 수십 개 + 생각) 스트리밍으로 받는다 — 비스트리밍은 HTTP 시간 제한에 걸린다.
      // 대체 모델(fallbacks)은 쓰지 않는다. 계획 작성이 안전 거절에 걸릴 일은 드물고, 켜면 "어느 모델이 한 번 더 도는지"를
      // 서버가 정해 호출 한 번의 비용 상한을 가장 비싼 모델 기준으로 잡아야 했다($3.9). 거절되면 failed(refused) → 대표가 다시 요청한다.
      const started = Date.now();
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
      return { stopReason: message.stop_reason, servedModel: message.model, text, attempts, modelLatencyMs: Date.now() - started };
    },
  };
}
