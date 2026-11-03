import { describe, expect, it } from 'vitest';
import { jevCriteria, jevQuestionRouter } from '../src/domain/question/jev-router.js';
import { llmQuestionRouter } from '../src/domain/question/llm-router.js';
import { openAiQuestionRouter } from '../src/domain/question/openai-router.js';
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

// 발표 비교의 세 축(Claude · OpenAI · Jev) 중 API로 부르는 둘. 실제 API는 부르지 않는다 — 가짜 fetch가 요청을 받아 두고 정해진 응답을 낸다.
type Captured = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown, captured: Captured[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

describe('OpenAI 라우터', () => {
  const ok = (text: string, extra: Record<string, unknown> = {}) => ({
    status: 'completed',
    output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 1_000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 100 },
    ...extra,
  });

  it('llm과 같은 프롬프트를 엄격한 JSON Schema로 보내고, 같은 해석·실제 사용량 비용을 낸다', async () => {
    const captured: Captured[] = [];
    const router = openAiQuestionRouter({ apiKey: 'sk-test', model: 'gpt-6.1-sol', effort: 'low', fetchImpl: fakeFetch(200, ok('{"target":"BACKEND","confidence":0.8,"reason":"응답 형식"}'), captured) });
    const decision = await router.route({ ...INPUT, context: { orgId: 'org-secret' } });

    expect(decision).toEqual({ target: 'BACKEND', confidence: 0.8, reason: '응답 형식', routedBy: `openai:gpt-6.1-sol:${ROUTING_PROMPT_VERSION}`, costUsd: 0.00262, modelLatencyMs: expect.any(Number) });
    expect(router.name).toBe(decision.routedBy); // 그림자 실행이 이름으로 실제 라우터를 뺀다
    const req = captured[0]!;
    expect(req.url).toBe('https://api.openai.com/v1/responses');
    expect((req.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(req.init.body)) as Record<string, unknown>;
    expect(body.input).toBe(buildRoutingPrompt(INPUT));
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'low' }, store: false, text: { format: { type: 'json_schema', strict: true } } });
    expect(String(req.init.body)).not.toContain('org-secret'); // 조직 id는 외부로 보내지 않는다
  });

  it('자기 역할을 고르면 SELF, 모르는 모델은 비용 null(지어내지 않는다)', async () => {
    const router = openAiQuestionRouter({ apiKey: 'k', model: 'gpt-unknown', fetchImpl: fakeFetch(200, ok('{"target":"FRONTEND","confidence":0.6,"reason":"화면"}'), []) });
    expect(await router.route(INPUT)).toMatchObject({ target: 'SELF', costUsd: null });
  });

  it('잘림·거절·HTTP 오류·모르는 역할은 예외다 — 호출부가 대표에게 보내고 실패로 기록한다', async () => {
    const make = (status: number, body: unknown) => openAiQuestionRouter({ apiKey: 'k', fetchImpl: fakeFetch(status, body, []) });
    await expect(make(200, ok('{"target":"BACKEND"', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })).route(INPUT)).rejects.toThrow(/max_output_tokens/);
    await expect(make(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: '안 됨' }] }] }).route(INPUT)).rejects.toThrow(/refusal/);
    await expect(make(401, { error: { message: 'bad key' } }).route(INPUT)).rejects.toThrow(/401/);
    await expect(make(200, ok('{"target":"QA","confidence":1,"reason":"x"}')).route(INPUT)).rejects.toThrow(/unknown target/);
  });
});

describe('Jev 라우터 (TypeSafe 결정 모델)', () => {
  const answer = (choice: string, probabilities: Record<string, number>, extra: Record<string, unknown> = {}) => ({
    model: 'jev-1.14.0',
    answers: { owner: { type: 'choice', choice, confidence: 0.82, probabilities } },
    usage: { input_tokens: 1_000_000, output_tokens: 3 },
    ...extra,
  });

  it('같은 맥락을 state로, 같은 후보 설명을 choice 기준으로 보낸다 — 묻는 역할 자신은 SELF 하나로만', async () => {
    const captured: Captured[] = [];
    const router = jevQuestionRouter({ apiKey: 'ts-test', fetchImpl: fakeFetch(200, answer('BACKEND', { BACKEND: 0.82, SELF: 0.1, PM: 0.08 }), captured) });
    const decision = await router.route({ ...INPUT, context: { orgId: 'org-secret' } });

    expect(decision).toEqual({
      target: 'BACKEND',
      confidence: 0.82,
      reason: '확률: BACKEND 0.82, SELF 0.10, PM 0.08',
      routedBy: `jev:jev-1.14.0:${ROUTING_PROMPT_VERSION}`,
      costUsd: 0.042,
      modelLatencyMs: expect.any(Number), // 판정 시간(035) — 요청 ~ 응답 본문
    });
    const req = captured[0]!;
    expect(req.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((req.init.headers as Record<string, string>).Authorization).toBe('Bearer ts-test');
    const body = JSON.parse(String(req.init.body)) as { model: string; state: string; questions: { owner: { type: string; criteria: Record<string, string> } } };
    expect(body.model).toBe('jev-1.14.0');
    expect(body.state).toContain('응답 본문은 어떤 형태인가요?');
    expect(body.state).not.toContain('JSON'); // 출력 형식 지시는 LLM 계열에만
    expect(body.questions.owner.type).toBe('choice');
    expect(Object.keys(body.questions.owner.criteria)).toEqual(['BACKEND', 'PM', 'SELF']);
    expect(String(req.init.body)).not.toContain('org-secret');
  });

  it('PM이 물으면 SELF가 없고 PM 소관은 PM이다', () => {
    const pmInput: RoutingInput = { ...INPUT, stage: 'feature_spec', askerRole: 'PM', task: null, repo: null };
    expect(Object.keys(jevCriteria(pmInput))).toEqual(['FRONTEND', 'BACKEND', 'PM']);
  });

  it('별칭으로 불러도 실제로 답한 버전의 가격으로 센다, 모르는 모델은 비용 null', async () => {
    const aliased = jevQuestionRouter({ apiKey: 'k', model: 'jev-latest', fetchImpl: fakeFetch(200, answer('PM', { PM: 1 }), []) });
    expect(await aliased.route(INPUT)).toMatchObject({ target: 'PM', costUsd: 0.042, routedBy: `jev:jev-latest:${ROUTING_PROMPT_VERSION}` });
    const unknown = jevQuestionRouter({ apiKey: 'k', model: 'jev-9', fetchImpl: fakeFetch(200, answer('PM', { PM: 1 }, { model: 'jev-9' }), []) });
    expect((await unknown.route(INPUT)).costUsd).toBeNull();
  });

  it('HTTP 오류·choice 답 없음·모르는 값은 예외다', async () => {
    const make = (status: number, body: unknown) => jevQuestionRouter({ apiKey: 'k', fetchImpl: fakeFetch(status, body, []) });
    await expect(make(429, { detail: 'rate limited' }).route(INPUT)).rejects.toThrow(/429/);
    await expect(make(200, { model: 'jev-1.14.0', answers: {} }).route(INPUT)).rejects.toThrow(/no choice answer/);
    await expect(make(200, answer('QA', { QA: 1 })).route(INPUT)).rejects.toThrow(/unknown target/);
  });
});
