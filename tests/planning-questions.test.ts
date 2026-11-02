import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { NomosClient } from '../src/bridge/nomos-client.js';
import { pool, withTransaction } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { createTask } from '../src/domain/authoring/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { requestContractsInTx } from '../src/domain/contract/service.js';
import { drainPlanningQuestions } from '../src/domain/dispatch/planning-questions.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { clearPolicyCache } from '../src/domain/policy/policy-cache.js';
import { setPmModel, type PmModel, type PmModelRequest, type PmModelResponse } from '../src/domain/pm/model.js';
import { drainPmJobs } from '../src/domain/pm/service.js';
import { assignMember, createProject } from '../src/domain/project/service.js';
import { drainAutoAnswers } from '../src/domain/question/auto-answer.js';
import { selectDecisionsForTask } from '../src/domain/question/decisions.js';
import { drainPmDrafts } from '../src/domain/question/pm-draft.js';
import { setQuestionRouter } from '../src/domain/question/router-registry.js';
import type { RoutingInput, RoutingTarget } from '../src/domain/question/router.js';
import { drainRoutingRecords } from '../src/domain/question/routing-eval.js';
import { sweepExpiredQuestions } from '../src/domain/question/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 기획 단계 질문(033) — PM이 기능 명세 초안을, BE 에이전트가 API 계약 초안을 쓰다가 혼자 정하면 안 되는 것을 질문으로 낸다.
// 같은 라우터로 FE·BE·PM에게 보내고, 답이 다 오면 초안을 다시 쓴다. 실험 모드는 상한 없이 첫 선택지로 자동 답한다.
// 실제 모델은 부르지 않는다(가짜 PM 모델·가짜 라우터). 픽스처는 서비스·HTTP를 거친다.

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await resetSchema();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await settle();
  await truncateAll();
  clearPolicyCache();
  // 질문 문장에 담당을 적어 둔 가짜 라우터 — "[BE]"·"[FE]"·"[PM]"·"[SELF]"로 끝나면 그쪽.
  setQuestionRouter({
    name: 'test:tagged',
    route: async (input: RoutingInput) => ({ target: tagOf(input), confidence: 0.9, reason: '태그', routedBy: 'test:tagged' }),
  });
});

afterEach(async () => {
  await settle();
  setQuestionRouter(null);
  setPmModel(null);
});

afterAll(async () => {
  await settle();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

function tagOf(input: RoutingInput): RoutingTarget {
  const text = input.questions[0]?.question ?? '';
  if (text.endsWith('[BE]')) return 'BACKEND';
  if (text.endsWith('[FE]')) return 'FRONTEND';
  if (text.endsWith('[SELF]')) return 'SELF';
  return 'PM';
}

// 백그라운드 작업(PM 초안·라우팅 기록·자동 답·재작성)이 다 끝날 때까지 — 서로를 낳으므로 조용해질 때까지 돈다.
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await drainPmJobs();
    await drainRoutingRecords();
    await drainAutoAnswers();
    await drainPlanningQuestions();
    await drainPmDrafts();
  }
}

const PASSWORD = 'correct-horse-battery';

async function account(loginId: string, nickname: string) {
  const { userId, connectKey } = await signup({ loginId, password: PASSWORD, nickname });
  return { userId, connectKey, token: async () => (await login({ loginId, password: PASSWORD })).accessToken };
}
type Account = Awaited<ReturnType<typeof account>>;

type Json = { data?: Record<string, unknown>; error?: { code: string; details?: unknown } };
async function http(method: string, urlPath: string, who: Account | string, body?: unknown): Promise<{ status: number; json: Json }> {
  const token = typeof who === 'string' ? who : await who.token();
  const res = await fetch(`${baseUrl}/api${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

// 대표·FE·BE와 레포 둘, 시작 전 프로젝트. 에이전트는 배정만(계약 초안은 BE 에이전트가 쓴다).
async function world(options: { experiment?: boolean } = {}) {
  const rep = await account('rep', '대표');
  const fe = await account('fe', '지수');
  const be = await account('be', '민수');
  const { orgId } = await createOrganization(rep.userId, 'Acme');
  for (const u of [fe, be]) {
    const { token } = await createInvite(orgId, rep.userId);
    await acceptInvite(token, u.userId);
  }
  const [web, api] = await connectRepos({
    orgId,
    actorUserId: rep.userId,
    actorOrgRole: 'REPRESENTATIVE',
    repos: [{ fullName: 'acme/web', ownerRole: 'FRONTEND' }, { fullName: 'acme/api', ownerRole: 'BACKEND' }],
  });
  const { project } = await createProject(orgId, rep.userId, { name: '스터디', autonomyPreset: 'L2', pmBudgetUsd: 40, repoIds: [web!.id, api!.id] });
  const repActor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' as const };
  const feAgent = await connectAgent({ connectKey: fe.connectKey, agentName: 'fe-mbp', harness: 'test', skills: [], maxConcurrent: 1 });
  const beAgent = await connectAgent({ connectKey: be.connectKey, agentName: 'be-mbp', harness: 'test', skills: [], maxConcurrent: 1 });
  await assignMember(repActor, project.id, feAgent.agentId, 'FRONTEND');
  await assignMember(repActor, project.id, beAgent.agentId, 'BACKEND');
  if (options.experiment) {
    expect((await http('PATCH', `/projects/${project.id}/settings`, rep, { questionMode: 'experiment' })).status).toBe(200);
  }
  const client = async (refreshToken: string) =>
    new NomosClient({ baseUrl, tokens: { accessToken: (await refreshAgentToken(refreshToken)).accessToken, refreshToken } });
  return {
    orgId,
    projectId: project.id,
    rep,
    fe,
    be,
    webRepoId: web!.id,
    apiRepoId: api!.id,
    feAgentId: feAgent.agentId,
    beAgentId: beAgent.agentId,
    feClient: await client(feAgent.refreshToken),
    beClient: await client(beAgent.refreshToken),
  };
}
type World = Awaited<ReturnType<typeof world>>;

// ── 가짜 PM 모델 ──

type Q = { featureKey?: string; question: string; options: { label: string }[] };
function q(question: string, featureKey = 'F-1'): Q {
  return { featureKey, question, options: [{ label: `${question} 추천안` }, { label: '다른 안' }] };
}

function featureDraft(questions: Q[]) {
  return {
    summary: '스터디 목록',
    assumptions: [],
    questions,
    features: [
      {
        featureKey: 'F-1',
        title: '스터디 목록',
        description: '스터디 목록 화면에서 모집 중인 스터디를 본다.',
        acceptance: ['모집 중인 스터디가 보인다'],
        needsApi: true,
        apiNeeds: '스터디 목록',
      },
    ],
  };
}

function respond(draft: unknown): PmModelResponse {
  return { stopReason: 'end_turn', servedModel: 'claude-sonnet-5-5', text: JSON.stringify(draft), attempts: [] };
}

// 계획 초안 호출에만 차례로 답한다(PM 답 초안 호출은 따로 센다). 받은 요청은 calls에 쌓는다.
function fakePm(...drafts: unknown[]) {
  const calls: PmModelRequest[] = [];
  const draftCalls: PmModelRequest[] = [];
  const model: PmModel = {
    kind: 'fake',
    async generate(req) {
      calls.push(req);
      if (req.context?.purpose === 'question_draft') {
        return { stopReason: 'end_turn', servedModel: 'm', text: JSON.stringify({ answers: [{ index: 1, answer: 'PM 초안', decided: false, basis: [] }] }), attempts: [] };
      }
      draftCalls.push(req);
      const draft = drafts[draftCalls.length - 1];
      if (draft === undefined) throw new Error(`unexpected PM draft call #${draftCalls.length}`);
      return respond(draft);
    },
  };
  setPmModel(model);
  return { calls, draftCalls };
}

type PlanJson = { id: string; status: string; revisionCause: string | null; questionCount: number; pendingQuestionCount: number; featureDraft: { assumptions: string[]; questions: Q[] } | null };

async function requestFeature(w: World): Promise<PlanJson> {
  const res = await http('POST', `/projects/${w.projectId}/pm/features`, w.rep, { instruction: '스터디 목록' });
  expect(res.status).toBe(202);
  await settle();
  return (await http('GET', `/projects/${w.projectId}/pm/plans/${(res.json.data as { id: string }).id}`, w.rep)).json.data as unknown as PlanJson;
}

async function plans(w: World): Promise<PlanJson[]> {
  return ((await http('GET', `/projects/${w.projectId}/pm/plans`, w.rep)).json.data as unknown as { plans: PlanJson[] }).plans;
}

type QuestionRow = {
  id: string;
  stage: string;
  task_id: string | null;
  plan_id: string | null;
  contract_id: string | null;
  asked_by_agent: string | null;
  asker_role: string;
  target_role: string;
  status: string;
  answer_source: string | null;
  answered_by: string | null;
  answers: Record<string, string> | null;
  questions: { question: string }[];
  routing_input: RoutingInput;
};
async function questionRows(where = 'TRUE', params: unknown[] = []): Promise<QuestionRow[]> {
  return (await pool.query(`SELECT * FROM agent_questions WHERE ${where} ORDER BY created_at, id`, params)).rows as QuestionRow[];
}

async function answer(who: Account, row: QuestionRow, value?: string) {
  const text = row.questions[0]!.question;
  return http('POST', `/questions/${row.id}/answer`, who, { answers: { [text]: value ?? `${text} 의 답` } });
}

describe('기능 명세 초안의 질문', () => {
  it('초안의 질문 → agent_questions(feature_spec) → 라우팅 → 답 → 답을 붙여 다시 씀 → 질문이 없으면 적용', async () => {
    const w = await world();
    const pm = fakePm(featureDraft([q('목록 한 페이지 크기는? [BE]'), q('마감된 스터디도 보이나? [PM]')]), featureDraft([]));
    const first = await requestFeature(w);
    expect(first).toMatchObject({ status: 'ready', questionCount: 2, pendingQuestionCount: 2, revisionCause: null });

    const rows = await questionRows('plan_id = $1', [first.id]);
    expect(rows.map((r) => [r.stage, r.asker_role, r.target_role, r.task_id, r.asked_by_agent, r.status])).toEqual([
      ['feature_spec', 'PM', 'BACKEND', null, null, 'pending'],
      ['feature_spec', 'PM', 'PM', null, null, 'pending'],
    ]);
    // 라우터가 본 입력 — 단계 feature_spec, 묻는 쪽 PM, 태스크 없음, 명세 = 초안의 그 기능.
    expect(rows[0]!.routing_input).toMatchObject({ stage: 'feature_spec', askerRole: 'PM', task: null, repo: null, contract: null, spec: { featureKey: 'F-1', title: '스터디 목록' } });
    // PM이 물은 질문에는 PM 답 초안을 쓰지 않는다(묻는 쪽이 자기 질문에 답하게 된다).
    expect(pm.calls.filter((c) => c.context?.purpose === 'question_draft')).toHaveLength(0);
    // 지침에 질문 규칙이 들어 있다.
    expect(pm.draftCalls[0]!.system).toContain('questions로 낸다');
    expect(pm.draftCalls[0]!.user).toContain('추천안을 맨 앞에');

    // 답 대기 중에는 적용할 수 없다.
    const blocked = await http('POST', `/projects/${w.projectId}/pm/plans/${first.id}/apply`, w.rep);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error?.code).toBe('QUESTIONS_PENDING');
    expect((blocked.json.error?.details as { questionId: string }[]).map((d) => d.questionId)).toEqual(rows.map((r) => r.id));

    // 하나만 답하면 아직 다시 쓰지 않는다.
    expect((await answer(w.be, rows[0]!, '20개')).status).toBe(200);
    await settle();
    expect(pm.draftCalls).toHaveLength(1);
    // 대표가 PM 질문에 답하면 전부 답해졌다 → 답을 붙여 새 단발 호출.
    expect((await answer(w.rep, rows[1]!, '안 보인다')).status).toBe(200);
    await settle();
    expect(pm.draftCalls).toHaveLength(2);
    expect(pm.draftCalls[1]!.user).toContain('이전 초안의 질문에 받은 답');
    expect(pm.draftCalls[1]!.user).toContain('목록 한 페이지 크기는? [BE] → 20개');

    const all = await plans(w);
    const rewritten = all.find((p) => p.id !== first.id)!;
    expect(rewritten).toMatchObject({ status: 'ready', revisionCause: 'answers', questionCount: 0, pendingQuestionCount: 0 });
    const requested = (await pool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'PM_PLAN_REQUESTED' ORDER BY id`)).rows;
    expect(requested[1]).toMatchObject({ on_behalf_of: 'system:pm', payload: { cause: 'answers', parentPlanId: first.id } });
    // 대표의 수정 요청 한도에 세지 않는다 — 3회를 다 쓸 수 있다.
    const revisions = await pool.query(`SELECT count(*)::int AS n FROM plans WHERE revision_cause = 'feedback'`);
    expect(revisions.rows[0]!.n).toBe(0);

    expect((await http('POST', `/projects/${w.projectId}/pm/plans/${rewritten.id}/apply`, w.rep)).status).toBe(200);
  });

  it('답 대기 중 acceptAssumptions로 적용하면 남은 질문을 가정으로 닫는다(confirmed_with_assumptions)', async () => {
    const w = await world();
    fakePm(featureDraft([q('정원은 몇 명? [PM]')]));
    const plan = await requestFeature(w);
    const res = await http('POST', `/projects/${w.projectId}/pm/plans/${plan.id}/apply`, w.rep, { acceptAssumptions: true });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ status: 'applied', pendingQuestionCount: 0, questionCount: 1 });
    const [row] = await questionRows('plan_id = $1', [plan.id]);
    expect(row!.status).toBe('expired');
    const expired = (await pool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'QUESTION_EXPIRED'`)).rows;
    expect(expired).toEqual([expect.objectContaining({ on_behalf_of: w.rep.userId, payload: expect.objectContaining({ questionId: row!.id, reason: 'confirmed_with_assumptions', stage: 'feature_spec' }) })]);
    const applied = (await pool.query(`SELECT payload FROM events WHERE type = 'PLAN_APPLIED'`)).rows[0]!.payload;
    expect(applied.assumedQuestionIds).toEqual([row!.id]);
  });

  it('일반 모드 상한 — 초안당 질문 수(넘는 것은 assumptions로), 답에 따른 재작성 회차', async () => {
    const w = await world();
    const many = Array.from({ length: env.PLANNING_QUESTIONS_MAX + 2 }, (_, i) => q(`질문 ${i + 1} [PM]`));
    fakePm(featureDraft(many), featureDraft([q('둘째 판 질문 [PM]')]), featureDraft([q('셋째 판 질문 [PM]')]));
    const first = await requestFeature(w);
    expect(first.questionCount).toBe(env.PLANNING_QUESTIONS_MAX);
    expect(first.featureDraft!.questions).toHaveLength(env.PLANNING_QUESTIONS_MAX);
    expect(first.featureDraft!.assumptions).toEqual([`가정: 질문 ${env.PLANNING_QUESTIONS_MAX + 1} [PM] → 질문 ${env.PLANNING_QUESTIONS_MAX + 1} [PM] 추천안`, `가정: 질문 ${env.PLANNING_QUESTIONS_MAX + 2} [PM] → 질문 ${env.PLANNING_QUESTIONS_MAX + 2} [PM] 추천안`]);

    // 답할 때마다 다시 쓴다 — PLANNING_QUESTION_ROUNDS(2)회째 재작성에서는 새 질문을 받지 않는다.
    for (const row of await questionRows('plan_id = $1', [first.id])) await answer(w.rep, row);
    await settle();
    const second = (await plans(w)).find((p) => p.revisionCause === 'answers' && p.questionCount === 1)!;
    expect(second).toBeDefined();
    for (const row of await questionRows('plan_id = $1', [second.id])) await answer(w.rep, row);
    await settle();
    const third = (await plans(w))[0]!;
    expect(third).toMatchObject({ revisionCause: 'answers', questionCount: 0 });
    expect(third.featureDraft!.assumptions).toEqual(['가정: 셋째 판 질문 [PM] → 셋째 판 질문 [PM] 추천안']);
  });
});

describe('API 계약 초안의 질문', () => {
  async function contractOf(w: World): Promise<{ id: string; attempt: number }> {
    fakePm(featureDraft([]));
    const plan = await requestFeature(w);
    expect((await http('POST', `/projects/${w.projectId}/pm/plans/${plan.id}/apply`, w.rep)).status).toBe(200);
    const jobs = (await w.beClient.listContractJobs()) as unknown as { contracts: { id: string; attempt: number }[] };
    return jobs.contracts[0]!;
  }
  const YAML = `paths:\n  /api/studies:\n    get:\n      responses:\n        '200':\n          description: 목록\n`;

  it('질문 형식 → 라우팅 → 답 → 수정 회차가 저절로 열린다(BE 담당 수정 요청 한도와 따로)', async () => {
    const w = await world();
    const job = await contractOf(w);
    await w.beClient.submitContractDraft(job.id, {
      attempt: job.attempt,
      openapiYaml: YAML,
      summary: '목록 API',
      openQuestions: [{ question: '빈 목록일 때 화면 문구가 필요한가? [FE]', options: [{ label: '필요 없다' }, { label: '서버가 준다' }] }, '가정: 인증 필요'],
    });
    await settle();
    const [row] = await questionRows('contract_id = $1', [job.id]);
    expect(row).toMatchObject({ stage: 'contract', asker_role: 'BACKEND', target_role: 'FRONTEND', task_id: null, asked_by_agent: w.beAgentId, status: 'pending' });
    expect(row!.routing_input).toMatchObject({ stage: 'contract', askerRole: 'BACKEND', task: null, contract: null, repo: { fullName: 'acme/api' }, spec: { featureKey: 'F-1' } });

    const contracts = (await http('GET', `/projects/${w.projectId}/contracts`, w.be)).json.data as unknown as { contracts: { id: string; pendingQuestionCount: number; openQuestions: string[] }[] };
    expect(contracts.contracts[0]).toMatchObject({ pendingQuestionCount: 1, openQuestions: ['가정: 인증 필요', '빈 목록일 때 화면 문구가 필요한가? [FE]'] });
    const blocked = await http('POST', `/contracts/${job.id}/approve`, w.be);
    expect(blocked.json.error?.code).toBe('QUESTIONS_PENDING');

    expect((await answer(w.fe, row!, '필요 없다')).status).toBe(200);
    await settle();
    const c = (await pool.query(`SELECT status, attempt, question_rounds FROM contracts WHERE id = $1`, [job.id])).rows[0];
    expect(c).toEqual({ status: 'pending', attempt: 2, question_rounds: 1 });
    const event = (await pool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'CONTRACT_REVISION_REQUESTED'`)).rows[0];
    expect(event).toMatchObject({ on_behalf_of: 'system:planning-questions', payload: { cause: 'answers', attempt: 2 } });
    // 다음 회차 작업에 받은 답이 있다(CLI 0.1.18이 프롬프트에 넣는다).
    const next = (await w.beClient.listContractJobs()) as unknown as { contracts: { attempt: number; answers: { question: string; answer: string }[] }[] };
    expect(next.contracts[0]).toMatchObject({ attempt: 2, answers: [{ question: '빈 목록일 때 화면 문구가 필요한가? [FE]', answer: '필요 없다' }] });

    // 질문 없이 다시 쓰면 확정할 수 있고, BE 담당의 수정 요청 한도는 그대로(답으로 연 회차는 세지 않는다).
    await w.beClient.submitContractDraft(job.id, { attempt: 2, openapiYaml: YAML, summary: '목록 API v2', openQuestions: [] });
    for (let i = 0; i < 3; i += 1) {
      expect((await http('POST', `/contracts/${job.id}/revise`, w.be, { feedback: `고쳐 ${i}` })).status).toBe(200);
      const j = (await w.beClient.listContractJobs()) as unknown as { contracts: { attempt: number }[] };
      await w.beClient.submitContractDraft(job.id, { attempt: j.contracts[0]!.attempt, openapiYaml: YAML, summary: `v${i}`, openQuestions: [] });
    }
    expect((await http('POST', `/contracts/${job.id}/revise`, w.be, { feedback: '한 번 더' })).json.error?.code).toBe('CONTRACT_REVISION_LIMIT');
    expect((await http('POST', `/contracts/${job.id}/approve`, w.be)).status).toBe(200);
  });

  it('옛 문자열 openQuestions는 기록만 하고 라우팅하지 않는다 / acceptAssumptions로 확정', async () => {
    const w = await world();
    const job = await contractOf(w);
    await w.beClient.submitContractDraft(job.id, { attempt: job.attempt, openapiYaml: YAML, summary: '목록', openQuestions: ['정원 제한?'] });
    expect(await questionRows('contract_id = $1', [job.id])).toEqual([]);

    expect((await http('POST', `/contracts/${job.id}/revise`, w.be, { feedback: '질문으로' })).status).toBe(200);
    await w.beClient.submitContractDraft(job.id, { attempt: 2, openapiYaml: YAML, summary: '목록', openQuestions: [{ question: '정원 제한? [PM]', options: [{ label: '없다' }, { label: '20명' }] }] });
    await settle();
    const res = await http('POST', `/contracts/${job.id}/approve`, w.be, { acceptAssumptions: true });
    expect(res.status).toBe(200);
    expect((await questionRows('contract_id = $1', [job.id]))[0]!.status).toBe('expired');
  });
});

describe('실험 모드', () => {
  it('켜려면 질문 중계가 켜져 있어야 한다(422), 시작 뒤에는 바꿀 수 없다', async () => {
    const w = await world();
    const res = await http('PATCH', `/projects/${w.projectId}/settings`, w.rep, { questionRelay: false, questionMode: 'experiment' });
    expect(res.status).toBe(422);
    expect(res.json.error?.code).toBe('QUESTION_MODE_INVALID');
    const ok = await http('PATCH', `/projects/${w.projectId}/settings`, w.rep, { questionMode: 'experiment' });
    expect(ok.json.data).toMatchObject({ questionRelay: true, questionMode: 'experiment' });
    expect((await http('PATCH', `/projects/${w.projectId}/settings`, w.rep, { questionRelay: false })).json.error?.code).toBe('QUESTION_MODE_INVALID');
  });

  it('상한 없음 · 라우팅 기록 뒤 첫 선택지로 자동 답(PM 대상도 즉시) · 상담·PM 초안 없음 · 알림·처리할 일에서 빠짐', async () => {
    const w = await world({ experiment: true });
    const many = Array.from({ length: env.PLANNING_QUESTIONS_MAX + 3 }, (_, i) => q(`질문 ${i + 1} ${i % 2 === 0 ? '[PM]' : '[BE]'}`));
    const pm = fakePm(featureDraft(many), featureDraft([]));
    const first = await requestFeature(w);

    const rows = await questionRows('plan_id = $1', [first.id]);
    expect(rows).toHaveLength(many.length);
    for (const row of rows) {
      expect(row).toMatchObject({ status: 'answered', answer_source: 'auto_first_option', answered_by: null });
      expect(row.answers).toEqual({ [row.questions[0]!.question]: `${row.questions[0]!.question} 추천안` });
      // 라우팅(primary)이 먼저 기록됐다.
      const runs = await pool.query(`SELECT created_at FROM question_routing_runs WHERE question_id = $1 AND mode = 'primary'`, [row.id]);
      expect(runs.rows).toHaveLength(1);
      const answered = await pool.query(`SELECT answered_at FROM agent_questions WHERE id = $1`, [row.id]);
      expect(new Date(runs.rows[0]!.created_at).getTime()).toBeLessThanOrEqual(new Date(answered.rows[0]!.answered_at).getTime());
    }
    const answeredEvents = (await pool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'QUESTION_ANSWERED'`)).rows;
    expect(answeredEvents.every((e) => e.on_behalf_of === 'system:experiment' && e.payload.source === 'auto_first_option')).toBe(true);
    // 상담·PM 답 초안을 만들지 않는다.
    expect((await pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'QUESTION_DRAFTED'`)).rows[0]!.n).toBe(0);
    expect(pm.calls.filter((c) => c.context?.purpose === 'question_draft')).toHaveLength(0);
    // 자동 답 뒤 다시 썼다(질문이 없는 초안).
    expect((await plans(w))[0]).toMatchObject({ revisionCause: 'answers', status: 'ready', questionCount: 0 });

    // 받은 편지함 — 자동 답한 질문은 알림(질문 옴·답 옴)도 처리할 일도 아니다.
    const notes = (await http('GET', '/me/notifications', w.rep)).json.data as unknown as { notifications: { type: string }[] };
    expect(notes.notifications.filter((n) => n.type.startsWith('question'))).toEqual([]);
    const inbox = (await http('GET', '/me/inbox', w.rep)).json.data as unknown as { items: { kind: string }[] };
    expect(inbox.items.filter((i) => i.kind === 'question')).toEqual([]);
    // 내보내기에 answerSource가 실린다 — 정답(accept)은 사람이 붙인다.
    const ds = (await http('GET', `/projects/${w.projectId}/routing-dataset?stage=feature_spec`, w.rep)).json.data as unknown as { items: { accept: string[]; answerSource: string }[] };
    expect(ds.items).toHaveLength(many.length);
    expect(ds.items.every((i) => i.answerSource === 'auto_first_option' && i.accept.length === 0)).toBe(true);
    expect((await http('POST', `/questions/${rows[0]!.id}/gold`, w.rep, { target: 'PM' })).status).toBe(200);
    // 보고서의 "답까지 걸린 시간"에서 뺀다.
    const report = (await http('GET', `/projects/${w.projectId}/routing-report`, w.rep)).json.data as unknown as { answer: { answered: number } };
    expect(report.answer.answered).toBe(0);
  });

  it('구현 단계 질문도 같은 실행에서 첫 선택지를 받는다 — 상담 대상이 아니다', async () => {
    const w = await world({ experiment: true });
    const task = await createTask(w.rep.userId, w.projectId, { title: 'T-1 화면', teamRole: 'FRONTEND', kind: 'INTEGRATION', repoId: w.webRepoId, specId: null, dependsOn: [] });
    expect((await http('POST', `/projects/${w.projectId}/start`, w.rep)).status).toBe(200);
    const refreshed = await refreshAgentToken((w.feClient as unknown as { tokens: { refreshToken: string } }).tokens.refreshToken);
    const client = new NomosClient({ baseUrl, tokens: { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken } });
    await client.claimTask(task.id);
    const asked = await client.askQuestions(task.id, [{ question: '응답 형식은? [BE]', options: [{ label: '배열' }, { label: '객체' }] }]);
    await settle();
    const state = await client.getQuestion(task.id, asked.id);
    expect(state).toMatchObject({ status: 'answered', answers: { '응답 형식은? [BE]': '배열' } });
    const beRefreshed = await refreshAgentToken((w.beClient as unknown as { tokens: { refreshToken: string } }).tokens.refreshToken);
    const be = new NomosClient({ baseUrl, tokens: { accessToken: beRefreshed.accessToken, refreshToken: beRefreshed.refreshToken } });
    expect((await be.listConsultJobs()).questions).toEqual([]);
  });
});

describe('태스크 없는 질문이 다른 화면에서 깨지지 않는다', () => {
  it('질문 목록·내 질문·결정·룸·알림·처리할 일·만료 정리', async () => {
    const w = await world();
    fakePm(featureDraft([q('목록 크기는? [BE]'), q('탈퇴 회원 기록은? [PM]')]));
    const plan = await requestFeature(w);
    const [beQ, pmQ] = await questionRows('plan_id = $1', [plan.id]);

    const list = await http('GET', `/projects/${w.projectId}/questions?status=all`, w.rep);
    expect(list.status).toBe(200);
    expect((list.json.data as unknown as { questions: { id: string; stage: string; taskId: string | null; planId: string }[] }).questions.map((x) => [x.stage, x.taskId, x.planId])).toEqual([
      ['feature_spec', null, plan.id],
      ['feature_spec', null, plan.id],
    ]);
    const mine = await http('GET', '/me/questions', w.be);
    expect((mine.json.data as unknown as { questions: { taskTitle: string | null }[] }).questions).toEqual([expect.objectContaining({ taskTitle: null })]);
    expect((await http('GET', `/projects/${w.projectId}/decisions?status=all`, w.rep)).status).toBe(200);
    const feed = await http('GET', `/projects/${w.projectId}/rooms/FRONTEND/feed?limit=50`, w.rep);
    expect((feed.json.data as unknown as { messages: { text: string }[] }).messages.map((m) => m.text)).toContain('PM 에이전트가 BACKEND에게 질문했습니다 (기능 명세 초안) (1개)');
    const notes = (await http('GET', '/me/notifications', w.rep)).json.data as unknown as { notifications: { type: string; text: string; taskId: string | null }[] };
    expect(notes.notifications.filter((n) => n.type === 'question_asked').map((n) => n.taskId)).toEqual([null, null]);
    const inbox = (await http('GET', '/me/inbox', w.be)).json.data as unknown as { items: { kind: string; text: string }[] };
    expect(inbox.items.find((i) => i.kind === 'question')!.text).toContain('기능 명세 초안');

    // 만료 정리 — 올릴 태스크가 없어도 깨지지 않는다.
    await pool.query(`UPDATE agent_questions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [pmQ!.id]);
    expect(await sweepExpiredQuestions()).toBe(1);
    expect((await questionRows('id = $1', [pmQ!.id]))[0]!.status).toBe('expired');

    // 결정 전달 — 기획 단계 질문의 답은 그 기능 명세가 생긴 뒤 같은 명세의 태스크에 간다(FE·BE 대상).
    await answer(w.be, beQ!, '20개');
    await settle();
    expect((await http('POST', `/projects/${w.projectId}/pm/plans/${plan.id}/apply`, w.rep, { acceptAssumptions: true })).status).toBe(200);
    const specs = (await http('GET', `/projects/${w.projectId}/specs`, w.rep)).json.data as unknown as { specs: { id: string; featureKey: string }[] };
    const f1 = specs.specs.find((s) => s.featureKey === 'F-1')!;
    // 계약이 확정되지 않은 기능이라 명세 없는 태스크로도 하나 만든다(다른 명세의 태스크에는 가지 않는다).
    const same = await withTransaction(async () =>
      createTask(w.rep.userId, w.projectId, { title: 'T-1 목록 API', teamRole: 'BACKEND', kind: 'IMPLEMENT', repoId: w.apiRepoId, specId: f1.id, dependsOn: [] }),
    );
    const other = await createTask(w.rep.userId, w.projectId, { title: 'T-2 공통', teamRole: 'BACKEND', kind: 'INTEGRATION', repoId: w.apiRepoId, specId: null, dependsOn: [] });
    expect((await selectDecisionsForTask(pool, w.projectId, same.id)).map((d) => [d.questionId, d.stage, d.answer])).toEqual([[beQ!.id, 'feature_spec', '20개']]);
    expect(await selectDecisionsForTask(pool, w.projectId, other.id)).toEqual([]);
  });
});
