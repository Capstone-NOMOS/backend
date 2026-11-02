import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { NomosClient } from '../src/bridge/nomos-client.js';
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { drainPlanningQuestions } from '../src/domain/dispatch/planning-questions.js';
import { drainExperimentAutopilot } from '../src/domain/experiment/autopilot.js';
import { sweepExperiment, VERIFYING_TIMEOUT_MESSAGE } from '../src/domain/experiment/sweep.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { clearPolicyCache } from '../src/domain/policy/policy-cache.js';
import { recomputeProjectPolicyHash } from '../src/domain/policy/policy-hash.js';
import { setPmModel, type PmModel, type PmModelRequest, type PmModelResponse } from '../src/domain/pm/model.js';
import { drainPmJobs } from '../src/domain/pm/service.js';
import { assignMember, createProject } from '../src/domain/project/service.js';
import { drainAutoAnswers } from '../src/domain/question/auto-answer.js';
import { drainPmDrafts } from '../src/domain/question/pm-draft.js';
import { setQuestionRouter } from '../src/domain/question/router-registry.js';
import type { RoutingInput, RoutingTarget } from '../src/domain/question/router.js';
import { drainRoutingRecords } from '../src/domain/question/routing-eval.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { gitMirrorInspector, setCommitInspector } from '../src/domain/verification/commit-inspector.js';
import { assignRootOwner, createTestProject } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 무인 실험(034) — 실험 모드 프로젝트는 사람 결정 지점(초안 확정·계약 확정·승인·실패 뒤 다시 시키기)을 서버가 system:experiment로 통과시킨다.
// 같은 시나리오를 기본 모드로 돌려 아무것도 자동으로 일어나지 않는지(사람 대기로 남는지)도 함께 본다.
// 실제 모델은 부르지 않는다(가짜 PM 모델·가짜 라우터).

let server: Server;
let baseUrl: string;
const realInspector = gitMirrorInspector();

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
  setQuestionRouter({
    name: 'test:tagged',
    route: async (input: RoutingInput) => ({ target: tagOf(input), confidence: 0.9, reason: '태그', routedBy: 'test:tagged' }),
  });
});

afterEach(async () => {
  await settle();
  setQuestionRouter(null);
  setPmModel(null);
  setCommitInspector(realInspector);
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
  return 'PM';
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await drainPmJobs();
    await drainRoutingRecords();
    await drainAutoAnswers();
    await drainPlanningQuestions();
    await drainPmDrafts();
    await drainExperimentAutopilot();
  }
}

async function withEnv<K extends keyof typeof env>(key: K, value: (typeof env)[K], fn: () => Promise<void>): Promise<void> {
  const previous = env[key];
  (env as Record<string, unknown>)[key] = value;
  try {
    await fn();
  } finally {
    (env as Record<string, unknown>)[key] = previous;
  }
}

const PASSWORD = 'correct-horse-battery';

async function account(loginId: string, nickname: string) {
  const { userId, connectKey } = await signup({ loginId, password: PASSWORD, nickname });
  return { userId, connectKey, token: async () => (await login({ loginId, password: PASSWORD })).accessToken };
}
type Account = Awaited<ReturnType<typeof account>>;

type Json = { data?: Record<string, unknown>; error?: { code: string; details?: unknown }; warnings?: string[] };
async function http(method: string, urlPath: string, who: Account, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}/api${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${await who.token()}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

// 대표·FE·BE와 레포 둘(acme/web FE, acme/api BE), 시작 전 프로젝트.
async function world(options: { experiment: boolean; budget?: number }) {
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
  const { project } = await createProject(orgId, rep.userId, { name: '스터디', autonomyPreset: 'L2', pmBudgetUsd: options.budget ?? 40, repoIds: [web!.id, api!.id] });
  const actor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' as const };
  const feAgent = await connectAgent({ connectKey: fe.connectKey, agentName: 'fe-mbp', harness: 'test', skills: [], maxConcurrent: 1 });
  const beAgent = await connectAgent({ connectKey: be.connectKey, agentName: 'be-mbp', harness: 'test', skills: [], maxConcurrent: 1 });
  await assignMember(actor, project.id, feAgent.agentId, 'FRONTEND');
  await assignMember(actor, project.id, beAgent.agentId, 'BACKEND');
  let warnings: string[] = [];
  if (options.experiment) {
    const res = await http('PATCH', `/projects/${project.id}/settings`, rep, { questionMode: 'experiment' });
    expect(res.status).toBe(200);
    warnings = res.json.warnings ?? [];
  }
  const beClient = new NomosClient({ baseUrl, tokens: { accessToken: (await refreshAgentToken(beAgent.refreshToken)).accessToken, refreshToken: beAgent.refreshToken } });
  return { orgId, projectId: project.id, rep, fe, be, beClient, warnings };
}
type World = Awaited<ReturnType<typeof world>>;

// ── 가짜 PM ──

type Q = { featureKey?: string; question: string; options: { label: string }[] };
function q(question: string): Q {
  return { featureKey: 'F-1', question, options: [{ label: `${question} 추천안` }, { label: '다른 안' }] };
}
function featureDraft(questions: Q[], needsApi = true) {
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
        needsApi,
        apiNeeds: needsApi ? '스터디 목록' : null,
      },
    ],
  };
}
const TASKS_DRAFT = {
  mode: 'CONTRACT_PARALLEL',
  rationale: '계약 위에서 병행',
  estimate: { workingDays: 2, notes: '' },
  specs: [],
  tasks: [
    { ref: 'api', title: '스터디 목록 API', repo: 'acme/api', teamRole: 'BACKEND', kind: 'IMPLEMENT', spec: 'F-1', dependsOn: [] },
    { ref: 'ui', title: '스터디 목록 화면 API 연동', repo: 'acme/web', teamRole: 'FRONTEND', kind: 'IMPLEMENT', spec: 'F-1', dependsOn: [] },
  ],
  integrationChecks: ['목록 화면이 API 응답을 그린다'],
};

type Reply = unknown | 'refusal';
// 기능 명세 호출에는 feature 큐에서, 태스크 나누기 호출에는 tasks 큐에서 차례로 답한다.
function fakePm(queues: { feature?: Reply[]; tasks?: Reply[] }) {
  const calls: { kind: 'feature' | 'tasks'; req: PmModelRequest }[] = [];
  const model: PmModel = {
    kind: 'fake',
    async generate(req): Promise<PmModelResponse> {
      const kind = 'features' in ((req.jsonSchema.properties as Record<string, unknown> | undefined) ?? {}) ? 'feature' : 'tasks';
      calls.push({ kind, req });
      const queue = queues[kind] ?? [];
      const reply = queue[calls.filter((c) => c.kind === kind).length - 1];
      if (reply === undefined) throw new Error(`unexpected PM ${kind} call #${calls.filter((c) => c.kind === kind).length}`);
      if (reply === 'refusal') return { stopReason: 'refusal', servedModel: 'm', text: '', attempts: [] };
      return { stopReason: 'end_turn', servedModel: 'm', text: JSON.stringify(reply), attempts: [] };
    },
  };
  setPmModel(model);
  return calls;
}

async function requestFeature(w: World): Promise<string> {
  const res = await http('POST', `/projects/${w.projectId}/pm/features`, w.rep, { instruction: '스터디 목록' });
  expect(res.status).toBe(202);
  await settle();
  return (res.json.data as { id: string }).id;
}

type PlanRow = { id: string; status: string; revision_cause: string | null; error_reason: string | null; kind: string; instruction: string | null };
async function plans(w: World): Promise<PlanRow[]> {
  return (await pool.query(`SELECT id, status, revision_cause, error_reason, kind, instruction FROM plans WHERE project_id = $1 ORDER BY created_at`, [w.projectId])).rows as PlanRow[];
}
async function events(type: string): Promise<{ on_behalf_of: string; payload: Record<string, unknown> }[]> {
  return (await pool.query(`SELECT on_behalf_of, payload FROM events WHERE type = $1 ORDER BY ts, id`, [type])).rows as { on_behalf_of: string; payload: Record<string, unknown> }[];
}
async function contractOf(w: World): Promise<{ id: string; attempt: number; status: string; experiment_retries: number }> {
  return (await pool.query(`SELECT id, attempt, status, experiment_retries FROM contracts WHERE project_id = $1`, [w.projectId])).rows[0] as {
    id: string;
    attempt: number;
    status: string;
    experiment_retries: number;
  };
}
const YAML = `paths:\n  /api/studies:\n    get:\n      responses:\n        '200':\n          description: 목록\n`;

describe('기획 흐름 자동 통과(실험 모드)', () => {
  it('기능 명세(질문 → 자동 답 → 재작성) 자동 적용 → 계약(질문 → 자동 답 → 다음 회차) 자동 확정 → 태스크 나누기 자동 요청·적용', async () => {
    const w = await world({ experiment: true });
    fakePm({ feature: [featureDraft([q('목록 크기는? [BE]')]), featureDraft([])], tasks: [TASKS_DRAFT] });
    await requestFeature(w);
    // 질문 → 자동 답 → 다시 씀 → 질문 없는 판을 적용했다.
    expect((await plans(w)).map((p) => [p.kind, p.status, p.revision_cause])).toEqual([
      ['feature', 'ready', null],
      ['feature', 'applied', 'answers'],
    ]);
    const applied = (await events('PLAN_APPLIED'))[0]!;
    expect(applied).toMatchObject({ on_behalf_of: 'system:experiment', payload: { auto: true } });
    expect((await events('SPEC_CREATED'))[0]).toMatchObject({ on_behalf_of: 'system:experiment', payload: { auto: true, source: 'pm' } });

    // 계약 — BE 노트북이 질문 하나를 붙여 초안을 낸다 → 자동 답 → 다음 회차가 열린다 → 질문 없이 다시 내면 자동 확정.
    let c = await contractOf(w);
    await w.beClient.submitContractDraft(c.id, {
      attempt: c.attempt,
      openapiYaml: YAML,
      summary: '목록 API',
      openQuestions: [{ question: '빈 목록 문구가 필요한가? [FE]', options: [{ label: '필요 없다' }, { label: '서버가 준다' }] }],
    });
    await settle();
    c = await contractOf(w);
    expect(c).toMatchObject({ status: 'pending', attempt: 2 });
    await w.beClient.submitContractDraft(c.id, { attempt: 2, openapiYaml: YAML, summary: '목록 API', openQuestions: [] });
    await settle();
    expect((await contractOf(w)).status).toBe('approved');
    expect((await events('CONTRACT_APPROVED'))[0]).toMatchObject({ on_behalf_of: 'system:experiment', payload: { auto: true } });

    // 계약이 전부 확정되자 태스크 나누기를 요청했고(지시 없음), ready가 되자 적용했다.
    const all = await plans(w);
    expect(all.at(-1)).toMatchObject({ kind: 'tasks', status: 'applied', instruction: '' });
    const requested = (await events('PM_PLAN_REQUESTED')).find((e) => e.payload.cause === 'experiment_split')!;
    expect(requested).toMatchObject({ on_behalf_of: 'system:experiment', payload: { auto: true, planKind: 'tasks' } });
    const tasks = (await pool.query(`SELECT title FROM tasks WHERE project_id = $1 ORDER BY title`, [w.projectId])).rows.map((r) => r.title);
    expect(tasks).toEqual(['스터디 목록 API', '스터디 목록 화면 API 연동']);
    // 다시 돌아도 같은 요청을 또 내지 않는다(명세에 태스크가 생겼다).
    await sweepExperiment();
    await settle();
    expect((await plans(w)).filter((p) => p.kind === 'tasks')).toHaveLength(1);
  });

  it('회차 상한(EXPERIMENT_QUESTION_ROUNDS)에 닿으면 새 질문을 가정으로 옮기고 그 판을 자동 확정한다', async () => {
    await withEnv('EXPERIMENT_QUESTION_ROUNDS', 1, async () => {
      const w = await world({ experiment: true });
      const calls = fakePm({ feature: [featureDraft([q('첫째 질문 [PM]')]), featureDraft([q('둘째 질문 [PM]')])] });
      await requestFeature(w);
      expect(calls).toHaveLength(2); // 원래 초안 + 답에 따른 재작성 1회 — 더 쓰지 않는다
      const last = (await plans(w)).at(-1)!;
      expect(last).toMatchObject({ status: 'applied', revision_cause: 'answers' });
      const draft = (await pool.query(`SELECT dag_snapshot FROM plans WHERE id = $1`, [last.id])).rows[0]!.dag_snapshot as { assumptions: string[]; questions: unknown[] };
      expect(draft.questions).toEqual([]);
      expect(draft.assumptions).toContain('가정: 둘째 질문 [PM] → 둘째 질문 [PM] 추천안');
      expect((await pool.query(`SELECT count(*)::int AS n FROM agent_questions`)).rows[0]!.n).toBe(1);
    });
  });

  it('같은 체인에서 이미 답이 정해진 질문이 다시 나오면 라우팅하지 않고 이전 답을 쓴다', async () => {
    const w = await world({ experiment: true });
    const calls = fakePm({ feature: [featureDraft([q('목록 크기는? [BE]')]), featureDraft([q('목록  크기는?   [BE]')])] });
    await requestFeature(w);
    // 두 번째 판은 같은 문장(공백만 다름)을 다시 물었다 — 새 질문 행이 없고, 이미 받은 답을 가정으로 남기고 그 판을 적용했다.
    expect((await pool.query(`SELECT count(*)::int AS n FROM agent_questions`)).rows[0]!.n).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM question_routing_runs WHERE mode = 'primary'`)).rows[0]!.n).toBe(1);
    const last = (await plans(w)).at(-1)!;
    expect(last.status).toBe('applied');
    const draft = (await pool.query(`SELECT dag_snapshot FROM plans WHERE id = $1`, [last.id])).rows[0]!.dag_snapshot as { assumptions: string[] };
    expect(draft.assumptions).toContain('가정(이미 답함): 목록  크기는?   [BE] → 목록 크기는? [BE] 추천안');
    // 재작성 입력에 그 답이 들어갔다.
    expect(calls[1]!.req.user).toContain('목록 크기는? [BE] → 목록 크기는? [BE] 추천안');
    expect((await events('PM_PLAN_DRAFTED')).at(-1)!.payload).toMatchObject({ questionCount: 0, repeatedQuestionCount: 1 });
  });

  it('PM 초안이 실패하면 같은 요청을 EXPERIMENT_PLAN_RETRIES회 다시 내고, 넘으면 포기한다(EXPERIMENT_SKIPPED)', async () => {
    const w = await world({ experiment: true });
    const calls = fakePm({ feature: ['refusal', 'refusal', 'refusal'] });
    await requestFeature(w);
    expect(calls).toHaveLength(1 + env.EXPERIMENT_PLAN_RETRIES);
    const all = await plans(w);
    expect(all.map((p) => [p.status, p.revision_cause, p.instruction])).toEqual([
      ['failed', null, '스터디 목록'],
      ['failed', 'retry', '스터디 목록'],
      ['failed', 'retry', '스터디 목록'],
    ]);
    const skipped = await events('EXPERIMENT_SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ on_behalf_of: 'system:experiment', payload: { auto: true, reason: 'refused', retries: 2, subject: { kind: 'plan', planId: all[0]!.id } } });
    // 다시 돌아도 더 요청하지 않는다.
    await sweepExperiment();
    await settle();
    expect(await plans(w)).toHaveLength(3);
    expect(await events('EXPERIMENT_SKIPPED')).toHaveLength(1);
  });

  it('계약 초안이 실패하면 EXPERIMENT_CONTRACT_RETRIES회 다시 시키고(수정 요청 한도와 따로), 넘으면 그 기능을 포기한다', async () => {
    const w = await world({ experiment: true });
    fakePm({ feature: [featureDraft([])] });
    await requestFeature(w);
    for (let i = 0; i <= env.EXPERIMENT_CONTRACT_RETRIES; i += 1) {
      const c = await contractOf(w);
      expect(c).toMatchObject({ status: 'pending', attempt: i + 1, experiment_retries: i });
      await w.beClient.failContractDraft(c.id, { attempt: c.attempt, reason: '레포를 못 읽음' });
      await settle();
    }
    expect(await contractOf(w)).toMatchObject({ status: 'failed', experiment_retries: env.EXPERIMENT_CONTRACT_RETRIES });
    const revisions = await events('CONTRACT_REVISION_REQUESTED');
    expect(revisions.map((e) => [e.on_behalf_of, e.payload.cause, e.payload.auto])).toEqual(
      Array.from({ length: env.EXPERIMENT_CONTRACT_RETRIES }, () => ['system:experiment', 'experiment_retry', true]),
    );
    expect((await events('EXPERIMENT_SKIPPED'))[0]!.payload).toMatchObject({ subject: { kind: 'contract', featureKey: 'F-1' }, reason: '레포를 못 읽음' });
    // BE 담당의 수정 요청 한도는 그대로 남아 있다(자동 재시도는 따로 센다).
    const res = await http('POST', `/contracts/${(await contractOf(w)).id}/revise`, w.be, { feedback: '다시' });
    expect(res.status).toBe(200);
  });

  it('PM 예산이 무인 실험에 모자라 보이면 켤 때 경고만 싣는다(막지 않는다)', async () => {
    const small = await world({ experiment: true, budget: 0.5 });
    expect(small.warnings).toHaveLength(1);
    expect(small.warnings[0]).toContain('PM 예산 $0.5');
  });
});

describe('기본 모드는 그대로(같은 시나리오에서 사람을 기다린다)', () => {
  it('질문 있는 초안은 ready로 대기, 질문 없는 초안도 적용하지 않는다, 실패한 초안을 다시 내지 않는다, 계약 초안·실패도 그대로', async () => {
    const w = await world({ experiment: false });
    expect(w.warnings).toEqual([]);
    const second = { ...featureDraft([], false), features: [{ ...featureDraft([], false).features[0]!, featureKey: 'F-2', title: '스터디 상세' }] };
    fakePm({ feature: [featureDraft([q('목록 크기는? [BE]')]), second, 'refusal'] });
    await requestFeature(w);
    await sweepExperiment();
    await settle();
    expect((await plans(w)).map((p) => p.status)).toEqual(['ready']);
    expect((await pool.query(`SELECT status FROM agent_questions`)).rows.map((r) => r.status)).toEqual(['pending']);

    // 질문 없는 초안 — 사람이 적용해야 한다. 실패한 초안 — 다시 내지 않는다.
    const plan = (await plans(w))[0]!;
    expect((await http('POST', `/projects/${w.projectId}/pm/plans/${plan.id}/apply`, w.rep, { acceptAssumptions: true })).status).toBe(200);
    await settle();
    const c = await contractOf(w);
    await w.beClient.submitContractDraft(c.id, { attempt: c.attempt, openapiYaml: YAML, summary: '목록 API', openQuestions: [] });
    await sweepExperiment();
    await settle();
    expect((await contractOf(w)).status).toBe('draft');
    expect((await plans(w)).filter((p) => p.kind === 'tasks')).toEqual([]);
    // 질문 없는 초안도 사람이 적용할 때까지 ready로 남는다.
    expect((await http('POST', `/projects/${w.projectId}/pm/features`, w.rep, { instruction: '두 번째' })).status).toBe(202);
    await settle();
    await sweepExperiment();
    await settle();
    expect((await plans(w)).map((p) => p.status)).toEqual(['applied', 'ready']);
    expect((await http('POST', `/projects/${w.projectId}/pm/features`, w.rep, { instruction: '세 번째' })).status).toBe(202);
    await settle();
    await sweepExperiment();
    await settle();
    expect((await plans(w)).map((p) => [p.status, p.revision_cause])).toEqual([
      ['applied', null],
      ['ready', null],
      ['failed', null],
    ]);
    expect(await events('EXPERIMENT_SKIPPED')).toEqual([]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM events WHERE on_behalf_of = 'system:experiment'`)).rows[0]!.n).toBe(0);
  });
});

describe('주기 정리(실험 모드만)', () => {
  it('자동 답이 빠진 대기 질문에 다시 자동 답한다 — 기본 모드 질문은 건드리지 않는다', async () => {
    const normal = await world({ experiment: false });
    fakePm({ feature: [featureDraft([q('정원은? [PM]')])] });
    await requestFeature(normal);
    // 기본 모드에서 생긴 대기 질문 — 시간이 지나도 그대로다.
    await pool.query(`UPDATE agent_questions SET created_at = now() - interval '10 minutes'`); // 시간 경과 흉내
    await sweepExperiment();
    await settle();
    expect((await pool.query(`SELECT status FROM agent_questions`)).rows[0]!.status).toBe('pending');
    // 시작 전에 실험 모드로 바꾸면(설정 API) 그 대기 질문은 "자동 답이 빠진 질문"이다 → 다시 자동 답, 재작성까지 이어진다.
    fakePm({ feature: [featureDraft([])] });
    expect((await http('PATCH', `/projects/${normal.projectId}/settings`, normal.rep, { questionMode: 'experiment' })).status).toBe(200);
    const result = await sweepExperiment();
    await settle();
    expect(result.reanswered).toBe(1);
    expect((await pool.query(`SELECT status, answer_source FROM agent_questions`)).rows[0]).toEqual({ status: 'answered', answer_source: 'auto_first_option' });
    expect((await plans(normal)).at(-1)).toMatchObject({ status: 'applied', revision_cause: 'answers' });
  });
});

// ── 승인·검증 — approvals.test.ts와 같은 구성(테스트용 프로젝트를 직접 만든다) ──

type ActionCtx = { projectId: string; taskId: string; agent: NomosClient };

// question_mode는 시작 뒤 설정 API로 바꿀 수 없다 — 시작한 테스트용 프로젝트(createTestProject, 직접 INSERT)라 같은 방식으로 켠다.
async function actionSetup(experiment: boolean): Promise<ActionCtx> {
  const rep = await signup({ loginId: 'boss', password: PASSWORD, nickname: '대표' });
  const member = await signup({ loginId: 'minsu', password: PASSWORD, nickname: '민수' });
  const memberAgent = await connectAgent({ connectKey: member.connectKey, agentName: 'laptop', harness: 'claude-code', skills: [], maxConcurrent: 1 });
  const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
  const { token } = await createInvite(orgId, rep.userId, { teamRole: 'BACKEND' });
  await acceptInvite(token, member.userId);
  const [repo] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/web' }] });
  await assignRootOwner(orgId, rep.userId, repo!.id, 'BACKEND');
  await pool.query(`UPDATE repos SET clone_url = 'file:///demo/acme-web.git' WHERE id = $1`, [repo!.id]);
  const projectId = await createTestProject({ orgId, userId: rep.userId, started: true });
  await pool.query(`INSERT INTO project_repos (project_id, repo_id) VALUES ($1, $2)`, [projectId, repo!.id]);
  await pool.query(`INSERT INTO project_members (project_id, agent_id, team_role) VALUES ($1, $2, 'BACKEND')`, [projectId, memberAgent.agentId]);
  await pool.query(`INSERT INTO project_policies (project_id, action_key, mode, lock_key) SELECT $1, action_key, mode_l2, lock_key FROM action_catalog`, [projectId]);
  if (experiment) await pool.query(`UPDATE projects SET question_mode = 'experiment' WHERE id = $1`, [projectId]);
  const task = await pool.query(
    `INSERT INTO tasks (project_id, repo_id, title, state, kind, team_role) VALUES ($1, $2, 'T-050 스키마 추가', 'READY', 'INTEGRATION', 'BACKEND') RETURNING id`,
    [projectId, repo!.id],
  );
  await recomputeProjectPolicyHash(pool, projectId);
  const refreshed = await refreshAgentToken(memberAgent.refreshToken);
  return {
    projectId,
    taskId: task.rows[0]!.id as string,
    agent: new NomosClient({ baseUrl, tokens: { accessToken: refreshed.accessToken, refreshToken: memberAgent.refreshToken } }),
  };
}

async function submit(ctx: ActionCtx, report: boolean): Promise<string> {
  setCommitInspector({ kind: 'fake', changedPaths: async () => ['migrations/020_x.sql'] });
  await ctx.agent.claimTask(ctx.taskId);
  const { id } = (await ctx.agent.submitArtifact(ctx.taskId, { commitSha: 'abc1234', changedPaths: ['migrations/020_x.sql'] })) as unknown as { id: string };
  if (report) {
    await ctx.agent.reportVerification(id, { stage: 'V2', result: 'SKIPPED', detail: { reason: '시험지 없음' } });
    await ctx.agent.reportVerification(id, { stage: 'V4', result: 'SKIPPED', detail: { reason: 'lint 없음' } });
  }
  await settle();
  return id;
}

async function taskState(taskId: string): Promise<{ state: string; blocked_reason: string | null }> {
  return (await pool.query(`SELECT state, blocked_reason FROM tasks WHERE id = $1`, [taskId])).rows[0] as { state: string; blocked_reason: string | null };
}
async function approvalRows(projectId: string): Promise<{ gate: string; stage: string; decision: string | null }[]> {
  return (await pool.query(`SELECT gate, stage, decision FROM approvals WHERE project_id = $1 ORDER BY requested_at, id`, [projectId])).rows as {
    gate: string;
    stage: string;
    decision: string | null;
  }[];
}

describe('승인·검증 정리', () => {
  it('실험 모드: 1차 검토 → 최종을 자동 승인해 DONE, G3(완료 승인)는 대기로 남긴다', async () => {
    const ctx = await actionSetup(true);
    await submit(ctx, true);
    expect((await taskState(ctx.taskId)).state).toBe('DONE');
    expect(await approvalRows(ctx.projectId)).toEqual([
      { gate: 'ACTION', stage: 'role_review', decision: 'APPROVE' },
      { gate: 'ACTION', stage: 'final', decision: 'APPROVE' },
      { gate: 'G3', stage: 'final', decision: null },
    ]);
    const results = await events('APPROVAL_RESULT');
    expect(results.map((e) => [e.on_behalf_of, e.payload.auto, e.payload.stage])).toEqual([
      ['system:experiment', true, 'role_review'],
      ['system:experiment', true, 'final'],
    ]);
    // 다시 돌아도 G3는 그대로다.
    await sweepExperiment();
    await settle();
    expect((await approvalRows(ctx.projectId)).at(-1)).toEqual({ gate: 'G3', stage: 'final', decision: null });
  });

  it('기본 모드: 1차 검토 카드가 사람을 기다린다', async () => {
    const ctx = await actionSetup(false);
    await submit(ctx, true);
    await sweepExperiment();
    await settle();
    expect((await taskState(ctx.taskId)).state).toBe('AWAITING_APPROVAL');
    expect(await approvalRows(ctx.projectId)).toEqual([{ gate: 'ACTION', stage: 'role_review', decision: null }]);
  });

  it('검증 보고가 EXPERIMENT_VERIFYING_TIMEOUT_MS 넘게 없으면 실험 모드만 VERIFYING에서 내린다(BLOCKED·AGENT_STOPPED)', async () => {
    for (const experiment of [false, true]) {
      await truncateAll();
      const ctx = await actionSetup(experiment);
      await submit(ctx, false);
      expect((await taskState(ctx.taskId)).state).toBe('VERIFYING');
      // 시간 경과 흉내 — 제출·서버 검증 기록을 기준 시간보다 앞으로 돌린다.
      await pool.query(`UPDATE artifacts SET created_at = now() - interval '30 minutes' WHERE task_id = $1`, [ctx.taskId]);
      await pool.query(`UPDATE verifications SET created_at = now() - interval '30 minutes' WHERE artifact_id IN (SELECT id FROM artifacts WHERE task_id = $1)`, [ctx.taskId]);
      const result = await sweepExperiment();
      await settle();
      if (!experiment) {
        expect(result.unstuck).toBe(0);
        expect((await taskState(ctx.taskId)).state).toBe('VERIFYING');
        continue;
      }
      expect(result.unstuck).toBe(1);
      expect(await taskState(ctx.taskId)).toEqual({ state: 'BLOCKED', blocked_reason: 'AGENT_STOPPED' });
      expect((await events('TASK_BLOCKED'))[0]).toMatchObject({
        on_behalf_of: 'system:experiment',
        payload: { auto: true, cause: 'verification_timeout', lastMessage: VERIFYING_TIMEOUT_MESSAGE },
      });
    }
  });
});
