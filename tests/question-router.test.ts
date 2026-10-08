import { describe, expect, it } from 'vitest';
import { buildRoutingPrompt, oppositeRoleRouter, parseRoutingResponse, type RoutingInput } from '../src/domain/question/router.js';

const INPUT: RoutingInput = {
  askerRole: 'FRONTEND',
  roles: ['FRONTEND', 'BACKEND'],
  task: { title: 'F-10 멤버 목록 화면', kind: 'IMPLEMENT' },
  spec: { featureKey: 'F-10', title: '멤버 목록 화면', content: '멤버 목록은 GET /api/studies/:id/members 에서 받는다.' },
  repo: { fullName: 'acme/study-web' },
  questions: [{ question: '응답 본문은 어떤 형태인가요?', options: [{ label: '{ members }' }, { label: '배열' }] }],
};

describe('질문 라우터', () => {
  it('규칙 라우터는 내용을 보지 않고 반대 역할을 고른다', async () => {
    expect(await oppositeRoleRouter.route(INPUT)).toEqual({ target: 'BACKEND', confidence: null, reason: null, routedBy: 'role_rule:opposite' });
    expect((await oppositeRoleRouter.route({ ...INPUT, askerRole: 'BACKEND' })).target).toBe('FRONTEND');
  });

  it('LLM 프롬프트에 질문·선택지·묻는 역할·명세가 들어간다', () => {
    const prompt = buildRoutingPrompt(INPUT);
    for (const part of ['응답 본문은 어떤 형태인가요?', '{ members } / 배열', '질문한 에이전트의 역할: FRONTEND', 'GET /api/studies/:id/members', 'SELF']) {
      expect(prompt, part).toContain(part);
    }
  });

  it('LLM 응답을 해석한다 — 코드 블록을 벗기고, 자기 역할 이름은 SELF로 본다', () => {
    expect(parseRoutingResponse('{"target":"BACKEND","confidence":0.9,"reason":"API 계약"}', INPUT, 'llm:v1')).toEqual({ target: 'BACKEND', confidence: 0.9, reason: 'API 계약', routedBy: 'llm:v1' });
    expect(parseRoutingResponse('```json\n{"target":"FRONTEND","confidence":0.7}\n```', INPUT, 'llm:v1').target).toBe('SELF');
    expect(parseRoutingResponse('{"target":"SELF","confidence":2}', INPUT, 'llm:v1')).toMatchObject({ target: 'SELF', confidence: null });
  });

  it('모르는 역할·깨진 응답은 예외다 — 호출부가 규칙 라우터로 대체한다(틀린 판정을 조용히 쓰지 않는다)', () => {
    expect(() => parseRoutingResponse('{"target":"QA"}', INPUT, 'llm')).toThrow();
    expect(() => parseRoutingResponse('BACKEND인 것 같습니다', INPUT, 'llm')).toThrow();
  });
});
