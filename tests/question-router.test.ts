import { describe, expect, it } from 'vitest';
import { llmQuestionRouter } from '../src/domain/question/llm-router.js';
import { buildRoutingPrompt, oppositeRoleRouter, parseRoutingResponse, ROUTING_PROMPT_VERSION, type RoutingInput } from '../src/domain/question/router.js';

const INPUT: RoutingInput = {
  stage: 'implementation',
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
    for (const part of ['응답 본문은 어떤 형태인가요?', '{ members } / 배열', '질문한 쪽: FRONTEND', 'GET /api/studies/:id/members', 'SELF']) {
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

// 단계(stage)별 프롬프트 — 다음 PR에서 기획 단계 질문(PM의 기능 명세 초안, BE의 API 계약 초안)도 같은 라우터로 보낸다.
// 이번 PR에서 실제로 이 경로를 타는 것은 implementation뿐이라 분기를 여기서 고정한다.
describe('질문 라우터 — 단계별 프롬프트 (v3)', () => {
  const FEATURE: RoutingInput = {
    stage: 'feature_spec',
    askerRole: 'PM',
    roles: ['FRONTEND', 'BACKEND'],
    task: null,
    spec: { featureKey: 'F-20', title: '스터디 멤버 목록', content: '스터디 상세 아래에 멤버 목록이 보인다.' },
    repo: null,
    questions: [{ question: '탈퇴한 멤버도 목록에 남기나요?', options: [] }],
    contract: null,
  };
  const CONTRACT: RoutingInput = {
    ...FEATURE,
    stage: 'contract',
    askerRole: 'BACKEND',
    repo: { fullName: 'acme/study-api' },
    questions: [{ question: '목록 응답에 가입일을 넣나요?', options: [] }],
    // contract 단계는 계약을 쓰는 중이라 요약이 들어와도 프롬프트에 넣지 않는다.
    contract: { featureKey: 'F-20', summary: '쓰는 중인 계약' },
  };

  it('프롬프트 버전 v3 — LLM 라우터 이름(routedBy)에 들어간다', () => {
    expect(ROUTING_PROMPT_VERSION).toBe('v3');
    expect(llmQuestionRouter.name).toContain(':v3');
  });

  it('implementation: 개발 에이전트가 구현하다 물었다 — 태스크·확정한 명세·확정한 계약 요약, SELF 허용', () => {
    const prompt = buildRoutingPrompt({ ...INPUT, contract: { featureKey: 'F-10', summary: 'data.members[]' } });
    expect(prompt).toContain('FRONTEND 개발 에이전트가 태스크를 구현하다가 물었다');
    expect(prompt).toContain('태스크: F-10 멤버 목록 화면 (IMPLEMENT)');
    expect(prompt).toContain('확정한 기능 명세 F-10');
    expect(prompt).toContain('확정한 API 계약(F-10) 요약: data.members[]');
    expect(prompt).toContain('"SELF"');
    expect(prompt).toContain('자신에게 있으면 SELF다');
  });

  it('feature_spec: PM 에이전트가 기능 명세 초안을 쓰다 물었다 — 태스크 없음, 초안, SELF 없음', () => {
    const prompt = buildRoutingPrompt(FEATURE);
    expect(prompt).toContain('PM 에이전트가 대표의 요구로 기능 명세 초안을 쓰다가 물었다');
    expect(prompt).toContain('쓰고 있는 기능 명세 초안 F-20');
    expect(prompt).not.toContain('태스크:');
    expect(prompt).not.toContain('"SELF"');
    expect(prompt).toContain('SELF는 없다');
    expect(prompt).toContain('질문한 쪽: PM');
  });

  it('contract: BE가 API 계약 초안을 쓰다 물었다 — 확정한 명세, 계약 요약은 넣지 않는다, SELF 허용', () => {
    const prompt = buildRoutingPrompt(CONTRACT);
    expect(prompt).toContain('BACKEND 에이전트가 확정한 기능 명세를 보고 API 계약 초안(OpenAPI)을 쓰다가 물었다');
    expect(prompt).toContain('확정한 기능 명세 F-20');
    expect(prompt).not.toContain('쓰는 중인 계약');
    expect(prompt).toContain('"SELF"');
  });

  it('PM이 묻는 쪽이면 PM 소관은 대상 PM이다 — SELF로 답해도 PM(대표가 확정), SELF가 되지 않는다', () => {
    expect(parseRoutingResponse('{"target":"PM","confidence":0.8}', FEATURE, 'llm').target).toBe('PM');
    expect(parseRoutingResponse('{"target":"SELF","confidence":0.8}', FEATURE, 'llm').target).toBe('PM');
    expect(parseRoutingResponse('{"target":"BACKEND"}', FEATURE, 'llm').target).toBe('BACKEND');
    // 계약 단계의 BE는 자기 이름을 고르면 SELF(계약은 BE 소관).
    expect(parseRoutingResponse('{"target":"BACKEND"}', CONTRACT, 'llm').target).toBe('SELF');
  });

  it('규칙 라우터 — PM이 물으면 PM(반대 역할이 없다)', async () => {
    expect((await oppositeRoleRouter.route(FEATURE)).target).toBe('PM');
  });
});
