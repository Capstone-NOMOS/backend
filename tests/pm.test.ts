import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import type { PlanDraft } from '../src/domain/pm/draft.js';
import { setPmModel, type PmModel, type PmModelRequest, type PmModelResponse } from '../src/domain/pm/model.js';
import { costOfAttempts } from '../src/domain/pm/pricing.js';
import { drainPmJobs, recoverInterruptedPlans } from '../src/domain/pm/service.js';
import { assignMember, createProject } from '../src/domain/project/service.js';
import { connectAgent } from '../src/domain/agent/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { assignRootOwner } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 내장 PM(계획 수립). CI는 실제 API를 부르지 않는다 — 가짜 모델을 끼운다(비용 0).

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await resetSchema();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await truncateAll();
});

afterEach(async () => {
  await drainPmJobs();
  setPmModel(null);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

type Body = { data?: Record<string, never>; error?: { code: string; message: string; details?: unknown } };

async function call(method: string, url: string, token: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${baseUrl}/api${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

async function account(loginId: string) {
  const { userId, connectKey } = await signup({ loginId, password: 'correct-horse-battery', nickname: loginId });
  const { accessToken } = await login({ loginId, password: 'correct-horse-battery' });
  return { userId, token: accessToken, connectKey };
}

async function world(pmBudgetUsd = 40) {
  const rep = await account('rep');
  const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
  const be = await account('be-dev');
  const { token } = await createInvite(orgId, rep.userId);
  await acceptInvite(token, be.userId);
  const [api, web] = await connectRepos({
    orgId,
    actorUserId: rep.userId,
    repos: [{ fullName: 'acme/study-api' }, { fullName: 'acme/study-web' }],
  });
  await assignRootOwner(orgId, rep.userId, api!.id, 'BACKEND');
  await assignRootOwner(orgId, rep.userId, web!.id, 'FRONTEND');
  const { project } = await createProject(orgId, rep.userId, {
    name: '스터디', autonomyPreset: 'L2', pmBudgetUsd, repoIds: [api!.id, web!.id],
  });
  return { rep, be, orgId, projectId: project.id };
}

const DRAFT: PlanDraft = {
  mode: 'SEQUENTIAL',
  rationale: '작고 명확하다',
  estimate: { workingDays: 5, notes: '' },
  specs: [
    {
      featureKey: 'F-10',
      title: '스터디 참여 신청',
      content: 'WHEN 정원이 차면 THEN 시스템은 409를 반환한다',
    },
  ],
  tasks: [
    { ref: 'api', title: 'T-10 참여 신청 API', repo: 'acme/study-api', teamRole: 'BACKEND', kind: 'IMPLEMENT', spec: 'F-10', dependsOn: [] },
    { ref: 'web', title: 'T-11 참여 신청 버튼', repo: 'acme/study-web', teamRole: 'FRONTEND', kind: 'IMPLEMENT', spec: 'F-10', dependsOn: ['api'] },
  ],
};

const USAGE = [{ model: 'claude-sonnet-5-5', inputTokens: 3000, outputTokens: 5000, cacheWriteTokens: 2000, cacheReadTokens: 0 }];

function respond(draft: unknown, extra: Partial<PmModelResponse> = {}): PmModelResponse {
  return { stopReason: 'end_turn', servedModel: 'claude-sonnet-5-5', text: JSON.stringify(draft), attempts: USAGE, ...extra };
}

// 부를 때마다 다음 응답을 낸다. 받은 요청은 calls에 쌓는다.
function fakeModel(...replies: ((req: PmModelRequest) => PmModelResponse | Promise<PmModelResponse>)[]) {
  const calls: PmModelRequest[] = [];
  const model: PmModel = {
    kind: 'fake',
    async generate(req) {
      calls.push(req);
      const reply = replies[calls.length - 1];
      if (!reply) throw new Error(`unexpected PM call #${calls.length}`);
      return reply(req);
    },
  };
  setPmModel(model);
  return calls;
}

async function requestAndWait(w: { projectId: string; rep: { token: string } }, instruction = '참여 신청 기능') {
  const res = await call('POST', `/projects/${w.projectId}/pm/plans`, w.rep.token, { instruction });
  expect(res.status).toBe(202);
  await drainPmJobs();
  const id = (res.body.data as unknown as { id: string }).id;
  return (await call('GET', `/projects/${w.projectId}/pm/plans/${id}`, w.rep.token)).body.data as unknown as {
    id: string;
    status: string;
    draft: PlanDraft | null;
    error: { reason: string; detail: unknown } | null;
    costUsd: number;
    parentPlanId: string | null;
  };
}

async function events(type: string) {
  return (await pool.query(`SELECT on_behalf_of, token_cost::float8 AS cost, payload FROM events WHERE type = $1 ORDER BY id`, [type])).rows;
}

describe('계획 요청 → 초안 → 적용', () => {
  it('초안이 ready가 되고, 적용하면 명세·태스크가 plan_id와 함께 생긴다 — PM은 시험지를 만들지 않는다', async () => {
    const w = await world();
    const calls = fakeModel(() => respond(DRAFT));
    const plan = await requestAndWait(w);

    expect(plan).toMatchObject({ status: 'ready', error: null });
    expect(plan.draft).toEqual(DRAFT);
    expect(plan.costUsd).toBeCloseTo(costOfAttempts(USAGE), 6);
    // 지시와 연결된 레포가 PM에게 간다. 지침(system)은 바뀌지 않는 부분이다.
    expect(calls[0]!.user).toContain('참여 신청 기능');
    expect(calls[0]!.user).toContain('acme/study-api — 소유 역할: BACKEND');
    expect(calls[0]!.model).toBe(env.PM_MODEL);

    // 요청은 대표 명의, 호출·초안은 system:pm 명의(P3). 비용은 events.token_cost에.
    expect((await events('PM_PLAN_REQUESTED')).map((e) => e.on_behalf_of)).toEqual([w.rep.userId]);
    const pmCalls = await events('PM_CALL');
    expect(pmCalls.map((e) => [e.on_behalf_of, e.payload.interrupted])).toEqual([['system:pm', false]]);
    expect(pmCalls[0]!.cost).toBeCloseTo(costOfAttempts(USAGE), 6);
    expect((await events('PM_PLAN_DRAFTED'))[0]!.payload).toMatchObject({ repaired: false, taskCount: 2 });

    const applied = await call('POST', `/projects/${w.projectId}/pm/plans/${plan.id}/apply`, w.rep.token);
    expect(applied.status).toBe(200);
    expect(applied.body.data).toMatchObject({ status: 'applied' });

    const tasks = await pool.query(`SELECT title, plan_id, state FROM tasks ORDER BY title`);
    expect(tasks.rows.map((t) => [t.title, t.plan_id, t.state])).toEqual([
      ['T-10 참여 신청 API', plan.id, 'READY'],
      ['T-11 참여 신청 버튼', plan.id, 'READY'],
    ]);
    // 시험지는 없다(V2는 SKIPPED). 명세 본문(계약 + 수용 기준)만 들어간다.
    expect((await pool.query(`SELECT count(*)::int AS n FROM spec_tests`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM specs`)).rows[0].n).toBe(1);
    expect((await events('TASK_CREATED')).map((e) => [e.on_behalf_of, e.payload.source])).toEqual([
      [w.rep.userId, 'pm'],
      [w.rep.userId, 'pm'],
    ]);
    // 적용은 G1이 아니다 — approved_at은 비워 두고, 프로젝트도 planning 그대로.
    const row = (await pool.query(`SELECT approved_at, applied_at, dag_hash, structure FROM plans WHERE id = $1`, [plan.id])).rows[0];
    expect(row.approved_at).toBeNull();
    expect(row.applied_at).not.toBeNull();
    expect(row.structure).toMatchObject({ specKeys: ['F-10'] });
    expect((await pool.query(`SELECT status FROM projects WHERE id = $1`, [w.projectId])).rows[0].status).toBe('planning');
  });

  it('dag_hash는 구조만 본다 — 근거·제목·ref 이름이 달라도 같은 구조면 같다', async () => {
    const w = await world();
    const reworded: PlanDraft = {
      ...DRAFT,
      rationale: '완전히 다른 설명',
      tasks: DRAFT.tasks.map((t) => ({ ...t, ref: `x-${t.ref}`, title: `${t.title} (다른 표현)`, dependsOn: t.dependsOn.map((d) => `x-${d}`) })),
    };
    fakeModel(() => respond(DRAFT), () => respond(reworded));
    const a = await requestAndWait(w);
    await pool.query(`UPDATE plans SET status = 'failed', error_reason = 'invalid' WHERE id = $1`, [a.id]); // 다음 요청을 받기 위해 치운다
    const b = await requestAndWait(w);
    const hashes = await pool.query(`SELECT dag_hash FROM plans WHERE id = ANY($1::uuid[])`, [[a.id, b.id]]);
    expect(new Set(hashes.rows.map((r) => r.dag_hash)).size).toBe(1);
  });
});

describe('검증과 교정 — 판정은 코드가, 교정은 한 번만', () => {
  it('검증에 걸리면 위반 목록을 붙여 한 번 다시 쓰게 한다', async () => {
    const w = await world();
    const broken = { ...DRAFT, tasks: [{ ...DRAFT.tasks[0]!, repo: 'acme/unknown' }] };
    const calls = fakeModel(() => respond(broken), () => respond(DRAFT));
    const plan = await requestAndWait(w);

    expect(plan.status).toBe('ready');
    expect(calls[1]!.user).toContain('acme/unknown는 이 프로젝트에 연결돼 있지 않다');
    expect((await events('PM_CALL')).map((e) => e.payload.purpose)).toEqual(['draft', 'repair']);
    expect((await events('PM_PLAN_DRAFTED'))[0]!.payload.repaired).toBe(true);
  });

  it('교정 뒤에도 틀리면 failed(invalid)이고 세 번째 호출은 없다', async () => {
    const w = await world();
    const broken = { ...DRAFT, tasks: [{ ...DRAFT.tasks[0]!, spec: null }] }; // IMPLEMENT에 명세 없음
    const calls = fakeModel(() => respond(broken), () => respond(broken));
    const plan = await requestAndWait(w);

    expect(plan.status).toBe('failed');
    expect(plan.error!.reason).toBe('invalid');
    expect(JSON.stringify(plan.error!.detail)).toContain('명세가 필요하다');
    expect(calls).toHaveLength(2);
  });

  it('안전 거절은 failed(refused), 출력 한도 초과는 failed(truncated) — 둘 다 교정하지 않지만 비용은 기록한다', async () => {
    const w = await world();
    const refused = fakeModel(() => respond({}, { stopReason: 'refusal', text: '' }));
    expect((await requestAndWait(w)).error!.reason).toBe('refused');
    expect(refused).toHaveLength(1);

    const truncated = fakeModel(() => respond({}, { stopReason: 'max_tokens', text: '{"mode":' }));
    const plan = await requestAndWait(w);
    expect(plan.error).toEqual({ reason: 'truncated', detail: { maxTokens: env.PM_MAX_TOKENS } });
    expect(truncated).toHaveLength(1);
    expect((await events('PM_CALL')).every((e) => e.cost > 0)).toBe(true);
  });

  // 지금은 대체 모델을 쓰지 않지만, 응답에 시도가 여럿이면(다시 켜면) 시도마다 그 모델 가격으로 더해야 한다.
  it('시도가 여럿이면 시도마다 그 모델 가격으로 더한다', async () => {
    const w = await world();
    const attempts = [
      { model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 },
      { model: 'claude-opus-4-8', inputTokens: 1000, outputTokens: 4000, cacheWriteTokens: 0, cacheReadTokens: 0 },
    ];
    fakeModel(() => respond(DRAFT, { attempts, servedModel: 'claude-opus-4-8' }));
    const plan = await requestAndWait(w);
    // sonnet: 1000*2 + 100*10 = 3000 / opus: 1000*5 + 4000*25 = 105000 → 108000 / 1e6
    expect(plan.costUsd).toBeCloseTo(0.108, 6);
  });
});

describe('끊긴 호출과 재시작', () => {
  it('시간 제한에 걸리면 잡아 둔 최대치로 정산하고 failed(timeout)', async () => {
    const w = await world();
    const original = env.PM_TIMEOUT_MS;
    (env as { PM_TIMEOUT_MS: number }).PM_TIMEOUT_MS = 50;
    try {
      fakeModel(
        (req) =>
          new Promise((_, reject) => {
            req.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const plan = await requestAndWait(w);
      expect(plan.error!.reason).toBe('timeout');
      const [pmCall] = await events('PM_CALL');
      expect(pmCall!.payload.interrupted).toBe(true);
      expect(pmCall!.cost).toBeGreaterThan(0.3); // 최대치(출력 한도 전부를 쓴 경우)
    } finally {
      (env as { PM_TIMEOUT_MS: number }).PM_TIMEOUT_MS = original;
    }
  });

  it('재시작 정리: 진행 중이던 계획은 최대치로 정산하고 failed(restart) — 뒤늦게 온 결과는 덮어쓰지 못한다', async () => {
    const w = await world();
    let release!: () => void;
    fakeModel(() => new Promise((resolve) => (release = () => resolve(respond(DRAFT)))));
    const res = await call('POST', `/projects/${w.projectId}/pm/plans`, w.rep.token, { instruction: '참여 신청' });
    const id = (res.body.data as unknown as { id: string }).id;
    await new Promise((r) => setTimeout(r, 50)); // 호출이 시작돼 최대치가 기록될 때까지

    expect(await recoverInterruptedPlans()).toBe(1);
    release();
    await drainPmJobs();

    const plan = (await call('GET', `/projects/${w.projectId}/pm/plans/${id}`, w.rep.token)).body.data as unknown as {
      status: string;
      error: { reason: string };
      draft: unknown;
    };
    expect(plan).toMatchObject({ status: 'failed', error: { reason: 'restart' }, draft: null });
    expect(await events('PM_PLAN_DRAFTED')).toHaveLength(0);
    // 끊긴 호출(최대치) + 뒤늦게 끝난 호출의 실제 사용량 — 둘 다 과금됐을 수 있으므로 둘 다 남는다.
    expect((await events('PM_CALL')).map((e) => e.payload.interrupted)).toEqual([true, false]);
  });

  it('재시작 정리는 서버로 뜰 때만 돈다 — migrate 단계에서는 옛 서버가 아직 작업 중일 수 있다', () => {
    const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    const migrate = readFileSync(new URL('../src/migrate.ts', import.meta.url), 'utf8');
    const boot = readFileSync(new URL('../src/boot.ts', import.meta.url), 'utf8');
    expect(server).toContain('recoverInterruptedPlans()');
    expect(migrate).not.toContain('recoverInterruptedPlans');
    expect(boot).not.toContain('recoverInterruptedPlans');
  });
});

describe('예산', () => {
  it('누적 + 이번 최대치가 예산을 넘으면 호출하지 않는다(409, 승인 경로 미구현 안내)', async () => {
    const w = await world(0.1); // 호출 한 번의 최대치(약 $0.4)보다 작다
    const calls = fakeModel(() => respond(DRAFT));
    const res = await call('POST', `/projects/${w.projectId}/pm/plans`, w.rep.token, { instruction: '참여 신청' });
    expect(res.status).toBe(409);
    expect(res.body.error!.code).toBe('PM_BUDGET_EXCEEDED');
    expect(res.body.error!.message).toContain('승인 경로 미구현');
    expect(calls).toHaveLength(0);
  });

  it('교정 호출도 예산 검사를 거친다 — 넘으면 failed(budget)', async () => {
    const w = await world(5.2);
    // 첫 호출이 비싸게 끝나($5) 교정 호출의 최대치(약 $0.4)를 더하면 예산 $5.2를 넘는다.
    const expensive = [{ model: 'claude-sonnet-5-5', inputTokens: 0, outputTokens: 500_000, cacheWriteTokens: 0, cacheReadTokens: 0 }];
    const broken = { ...DRAFT, tasks: [{ ...DRAFT.tasks[0]!, repo: 'acme/unknown' }] };
    const calls = fakeModel(() => respond(broken, { attempts: expensive }));
    const plan = await requestAndWait(w);
    expect(plan.error!.reason).toBe('budget');
    expect(calls).toHaveLength(1);
  });
});

describe('요청 규칙', () => {
  it('프로젝트당 진행 중인 요청은 하나다', async () => {
    const w = await world();
    let release!: () => void;
    fakeModel(() => new Promise((resolve) => (release = () => resolve(respond(DRAFT)))));
    await call('POST', `/projects/${w.projectId}/pm/plans`, w.rep.token, { instruction: '하나' });
    const second = await call('POST', `/projects/${w.projectId}/pm/plans`, w.rep.token, { instruction: '둘' });
    expect(second.status).toBe(409);
    expect(second.body.error!.code).toBe('PM_PLAN_IN_PROGRESS');
    await new Promise((r) => setTimeout(r, 20));
    release();
  });

  it('대표만 쓸 수 있다', async () => {
    const w = await world();
    fakeModel();
    expect((await call('POST', `/projects/${w.projectId}/pm/plans`, w.be.token, { instruction: 'x' })).status).toBe(403);
    expect((await call('GET', `/projects/${w.projectId}/pm/plans`, w.be.token)).status).toBe(403);
  });

  it('서버에 PM 키가 없으면 PM API만 503이고 나머지는 그대로 돈다', async () => {
    const w = await world();
    setPmModel(null); // 테스트 환경에는 ANTHROPIC_API_KEY가 없다
    const res = await call('POST', `/projects/${w.projectId}/pm/plans`, w.rep.token, { instruction: 'x' });
    expect(res.status).toBe(503);
    expect(res.body.error!.code).toBe('PM_UNAVAILABLE');
    expect((await call('GET', `/projects/${w.projectId}`, w.rep.token)).status).toBe(200);
  });
});

describe('적용 규칙', () => {
  it('두 번 적용할 수 없고, 수정 체인에서 이미 적용됐으면 옛 초안도 적용할 수 없다', async () => {
    const w = await world();
    const revised: PlanDraft = { ...DRAFT, tasks: DRAFT.tasks.map((t) => ({ ...t, title: `${t.title} v2` })), specs: [{ ...DRAFT.specs[0]!, featureKey: 'F-11' }] };
    fakeModel(() => respond(DRAFT), (req) => {
      expect(req.user).toContain('정원도 보여줘'); // 피드백이 간다
      return respond({ ...revised, tasks: revised.tasks.map((t) => ({ ...t, spec: 'F-11' })) });
    });
    const first = await requestAndWait(w);
    const rev = await call('POST', `/projects/${w.projectId}/pm/plans/${first.id}/revise`, w.rep.token, { feedback: '정원도 보여줘' });
    expect(rev.status).toBe(202);
    await drainPmJobs();
    const second = (rev.body.data as unknown as { id: string }).id;

    expect((await call('POST', `/projects/${w.projectId}/pm/plans/${second}/apply`, w.rep.token)).status).toBe(200);
    const again = await call('POST', `/projects/${w.projectId}/pm/plans/${second}/apply`, w.rep.token);
    expect(again.status).toBe(409);
    const old = await call('POST', `/projects/${w.projectId}/pm/plans/${first.id}/apply`, w.rep.token);
    expect(old.status).toBe(409);
    expect(old.body.error!.code).toBe('PLAN_NOT_APPLICABLE');
    expect((await pool.query(`SELECT count(*)::int AS n FROM tasks`)).rows[0].n).toBe(2);
  });

  it('초안 뒤에 상황이 바뀌면 적용이 422이고 계획은 ready로 남는다', async () => {
    const w = await world();
    fakeModel(() => respond(DRAFT));
    const plan = await requestAndWait(w);
    // 그사이 대표가 같은 명세 키를 손으로 만들었다.
    await call('POST', `/projects/${w.projectId}/specs`, w.rep.token, { featureKey: 'F-10', title: 'x', content: 'y', tests: [] });

    const res = await call('POST', `/projects/${w.projectId}/pm/plans/${plan.id}/apply`, w.rep.token);
    expect(res.status).toBe(422);
    expect(res.body.error!.code).toBe('PLAN_INVALID');
    const after = (await call('GET', `/projects/${w.projectId}/pm/plans/${plan.id}`, w.rep.token)).body.data as unknown as { status: string };
    expect(after.status).toBe('ready');
    expect((await pool.query(`SELECT count(*)::int AS n FROM tasks`)).rows[0].n).toBe(0);
  });
});

describe('반려', () => {
  type View = { status: string; rejectedAt: string | null; rejectReason: string | null };

  it('ready 초안을 반려하면 rejected가 되고, 이후 적용·수정 요청·재반려는 409다', async () => {
    const w = await world();
    fakeModel(() => respond(DRAFT));
    const plan = await requestAndWait(w);

    const res = await call('POST', `/projects/${w.projectId}/pm/plans/${plan.id}/reject`, w.rep.token, { reason: '이번 범위가 아니다' });
    expect(res.status).toBe(200);
    const view = res.body.data as unknown as View;
    expect(view).toMatchObject({ status: 'rejected', rejectReason: '이번 범위가 아니다' });
    expect(view.rejectedAt).not.toBeNull();

    for (const action of ['apply', 'revise', 'reject']) {
      const again = await call('POST', `/projects/${w.projectId}/pm/plans/${plan.id}/${action}`, w.rep.token, action === 'revise' ? { feedback: 'x' } : undefined);
      expect(again.status, action).toBe(409);
      expect(again.body.error!.code, action).toBe('PLAN_NOT_APPLICABLE');
    }
    // 반려는 아무것도 만들지 않는다.
    expect((await pool.query(`SELECT count(*)::int AS n FROM tasks`)).rows[0].n).toBe(0);

    const rejected = await events('PLAN_REJECTED');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.on_behalf_of).toBe(w.rep.userId);
    expect(rejected[0]!.payload).toEqual({ planId: plan.id, rootPlanId: plan.id, reason: '이번 범위가 아니다' });
  });

  it('사유 없이(본문 없이) 반려할 수 있다', async () => {
    const w = await world();
    fakeModel(() => respond(DRAFT));
    const plan = await requestAndWait(w);
    const res = await call('POST', `/projects/${w.projectId}/pm/plans/${plan.id}/reject`, w.rep.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'rejected', rejectReason: null });
  });

  it('적용된·실패한 계획은 반려할 수 없고, 대표만 반려한다', async () => {
    const w = await world();
    fakeModel(() => respond(DRAFT), () => respond(DRAFT, { stopReason: 'refusal' }));
    const ready = await requestAndWait(w);
    expect((await call('POST', `/projects/${w.projectId}/pm/plans/${ready.id}/reject`, w.be.token)).status).toBe(403);
    await call('POST', `/projects/${w.projectId}/pm/plans/${ready.id}/apply`, w.rep.token);
    expect((await call('POST', `/projects/${w.projectId}/pm/plans/${ready.id}/reject`, w.rep.token)).status).toBe(409);

    const failed = await requestAndWait(w, '다른 기능');
    expect(failed.status).toBe('failed');
    expect((await call('POST', `/projects/${w.projectId}/pm/plans/${failed.id}/reject`, w.rep.token)).status).toBe(409);
  });

  it('사유가 1000자를 넘으면 400', async () => {
    const w = await world();
    fakeModel(() => respond(DRAFT));
    const plan = await requestAndWait(w);
    const res = await call('POST', `/projects/${w.projectId}/pm/plans/${plan.id}/reject`, w.rep.token, { reason: 'x'.repeat(1001) });
    expect(res.status).toBe(400);
  });
});

describe('태스크별 담당 에이전트', () => {
  type Assignment = { ref: string; teamRole: string | null; agent: { id: string; name: string; userId: string; nickname: string | null } | null };

  it('역할에 배정된 에이전트를 조회 시점에 계산한다 — 없으면 null, 배정하면 바로 보인다', async () => {
    const w = await world();
    fakeModel(() => respond(DRAFT));
    const plan = await requestAndWait(w);
    const assignments = (p: unknown) => (p as { assignments: Assignment[] }).assignments;

    // 아직 아무도 배정되지 않았다 — 적용하면 아무도 가져가지 않는다.
    expect(assignments(plan)).toEqual([
      { ref: 'api', teamRole: 'BACKEND', agent: null },
      { ref: 'web', teamRole: 'FRONTEND', agent: null },
    ]);

    const agent = await connectAgent({ connectKey: w.be.connectKey, agentName: 'be-mbp', harness: 'claude-code', skills: [], maxConcurrent: 1 });
    await assignMember({ userId: w.rep.userId, orgId: w.orgId, orgRole: 'REPRESENTATIVE' }, w.projectId, agent.agentId, 'BACKEND');

    const again = (await call('GET', `/projects/${w.projectId}/pm/plans/${plan.id}`, w.rep.token)).body.data;
    expect(assignments(again)).toEqual([
      { ref: 'api', teamRole: 'BACKEND', agent: { id: agent.agentId, name: 'be-mbp', userId: w.be.userId, nickname: 'be-dev' } },
      { ref: 'web', teamRole: 'FRONTEND', agent: null },
    ]);
    // 목록도 같은 계산을 한다.
    const list = (await call('GET', `/projects/${w.projectId}/pm/plans`, w.rep.token)).body.data as unknown as { plans: unknown[] };
    expect(assignments(list.plans[0])[0]!.agent?.name).toBe('be-mbp');
  });

  it('초안이 없으면(작성 중·실패) 빈 배열', async () => {
    const w = await world();
    fakeModel(() => respond(DRAFT, { stopReason: 'refusal' }));
    const plan = await requestAndWait(w);
    expect((plan as unknown as { assignments: Assignment[] }).assignments).toEqual([]);
  });
});
