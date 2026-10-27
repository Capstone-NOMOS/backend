import { describe, expect, it } from 'vitest';
import { specInputSchema, taskFieldsSchema } from '../src/domain/authoring/schema.js';
import { buildProbe, parseScenarios, PROBE_SCENARIOS } from '../scripts/lib/question-probe.js';

// 질문 중계 점검 스크립트(scripts/question-probe.ts)가 만드는 명세·태스크가 작성 API의 입력 형식을 통과해야 한다 —
// 통합 테스트 날 422로 막히면 점검을 못 한다.
describe('질문 중계 점검 시나리오', () => {
  it('시나리오마다 명세·태스크가 작성 입력 형식을 통과하고, 키·제목이 겹치지 않는다', () => {
    const built = PROBE_SCENARIOS.map((s) => buildProbe(s, 'abc123'));
    for (const b of built) {
      expect(specInputSchema.safeParse(b.spec).success).toBe(true);
      expect(taskFieldsSchema.safeParse(b.task).success).toBe(true);
      expect(b.spec.content).toContain('AskUserQuestion');
      expect(b.spec.content).toContain(b.definition.question);
    }
    expect(new Set(built.map((b) => b.spec.featureKey)).size).toBe(built.length);
    expect(new Set(built.map((b) => b.task.title)).size).toBe(built.length);
    // 꼬리표가 다르면 다시 실행해도 같은 제목 거부에 걸리지 않는다.
    expect(buildProbe('be', 'x1').task.title).not.toBe(buildProbe('be', 'x2').task.title);
  });

  it('묻는 쪽과 예상 대상이 서로 다르다(자기에게 묻는 시나리오는 없다)', () => {
    for (const s of PROBE_SCENARIOS) {
      const { definition } = buildProbe(s, 't');
      expect(definition.expectedTarget).not.toBe(definition.askerRole);
    }
  });

  it('--only를 해석한다', () => {
    expect(parseScenarios(undefined)).toEqual(['be', 'fe', 'pm']);
    expect(parseScenarios('PM, be,pm')).toEqual(['pm', 'be']);
    expect(() => parseScenarios('qa')).toThrow(/모르는 시나리오/);
  });
});
