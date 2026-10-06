import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { NomosClient } from '../src/bridge/nomos-client.js';
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { connectAgent } from '../src/domain/agent/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import type { PlanDraft } from '../src/domain/pm/draft.js';
import { setPmModel } from '../src/domain/pm/model.js';
import { PM_SYSTEM_PROMPT } from '../src/domain/pm/prompt.js';
import { clearRelayJobs } from '../src/domain/pm/relay.js';
import { drainPmJobs } from '../src/domain/pm/service.js';
import { createProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { handleNextPmJob, toJobResult, type RunClaudeJson } from '../src/executor/pm-worker.js';
import { assignRootOwner } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 중계 모드(PM_PROVIDER=relay): 서버가 모델 호출을 대기열에 넣고, 대표 노트북의 pm-worker가 가져가 실행한 뒤 결과를 돌려준다.
// claude 실행만 가짜로 바꾸고 나머지(서버 API·클라이언트·PM 흐름)는 실제로 돈다.

let server: Server;
let baseUrl: string;
const originalProvider = env.PM_PROVIDER;
const originalTimeout = env.PM_TIMEOUT_MS;
const mutableEnv = env as { PM_PROVIDER: 'api' | 'relay'; PM_TIMEOUT_MS: number };

beforeAll(async () => {
  await resetSchema();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await truncateAll();
  mutableEnv.PM_PROVIDER = 'relay';
  setPmModel(null);
});

afterEach(async () => {
  // 테스트가 남긴 백그라운드 PM 작업은 대기열에 **늦게** 올라올 수 있다(계획 행·예산 확인을 먼저 한다).
  // 한 번만 비우면 그 뒤에 올라온 작업이 가져갈 워커 없이 PM_TIMEOUT_MS(기본 10분)까지 기다려 이 정리 단계가 시간 제한에 걸렸다
  // (부하가 있을 때 전체 실행의 절반가량). 백그라운드 작업이 다 끝날 때까지 계속 비운다.
  let drained = false;
  const draining = drainPmJobs().then(() => {
    drained = true;
  });
  while (!drained) {
    clearRelayJobs();
    await new Promise((r) => setTimeout(r, 20));
  }
  await draining;
  mutableEnv.PM_PROVIDER = originalProvider;
  mutableEnv.PM_TIMEOUT_MS = originalTimeout;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

type Body = { data?: Record<string, never>; error?: { code: string; message: string } };

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

async function agentClient(connectKey: string, name: string) {
  const creds = await connectAgent({ connectKey, agentName: name, harness: 'claude-code', skills: [], maxConcurrent: 1 });
  return new NomosClient({ baseUrl, tokens: { accessToken: creds.accessToken, refreshToken: creds.refreshToken } });
}

async function world() {
  const rep = await account('rep');
  const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
  const be = await account('be-dev');
  const { token } = await createInvite(orgId, rep.userId);
  await acceptInvite(token, be.userId);
  const [api] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/study-api' }] });
  await assignRootOwner(orgId, rep.userId, api!.id, 'BACKEND');
  const { project } = await createProject(orgId, rep.userId, {
    name: '스터디', autonomyPreset: 'L2', pmBudgetUsd: 40, repoIds: [api!.id],
  });
  return { rep, be, projectId: project.id };
}

const DRAFT: PlanDraft = {
  mode: 'SEQUENTIAL',
  rationale: '작고 명확하다',
  estimate: { workingDays: 3, notes: '' },
  specs: [
    {
      featureKey: 'F-10',
      title: '스터디 참여 신청',
      content: 'WHEN 정원이 차면 THEN 시스템은 POST /api/studies/{id}/join에 409를 반환한다',
    },
  ],
  tasks: [{ ref: 'api', title: 'T-10 참여 신청 API', repo: 'acme/study-api', teamRole: 'BACKEND', kind: 'IMPLEMENT', spec: 'F-10', dependsOn: [] }],
};

// headless Claude Code의 --output-format json 출력 모양.
function claudeOutput(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    structured_output: DRAFT,
    stop_reason: 'end_turn',
    usage: { input_tokens: 3000, output_tokens: 5000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0 },
    modelUsage: { 'claude-haiku-4-5-20251001': { outputTokens: 10 }, 'claude-sonnet-5-5': { outputTokens: 5000 } },
    ...extra,
  });
}

// 작업이 대기열에 들어올 때까지 워커를 돌린다(계획 요청은 202 뒤 비동기로 진행된다).
async function workUntilHandled(client: NomosClient, run: RunClaudeJson) {
  for (let i = 0; i < 100; i += 1) {
    if (await handleNextPmJob(client, () => {}, run)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no relay job appeared');
}

async function getPlan(w: { projectId: string; rep: { token: string } }, planId: string) {
  return (await call('GET', `/projects/${w.projectId}/pm/plans/${planId}`, w.rep.token)).body.data as unknown as {
    status: string;
    draft: PlanDraft | null;
    error: { reason: string; detail: { message?: string } | null } | null;
  };
}

describe('중계 모드 — 서버 → 대표 노트북 → 서버', () => {
  it('대표의 pm-worker가 작업을 가져가 실행하고, 결과는 API 모드와 같은 흐름으로 ready 초안이 된다', async () => {
    const w = await world();
    const worker = await agentClient(w.rep.connectKey, 'rep-laptop');
    expect(await worker.nextPmJob()).toBeNull(); // 아무 요청도 없으면 null

    const req = await call('POST', `/projects/${w.projectId}/pm/plans`, w.rep.token, { instruction: '참여 신청 기능' });
    expect(req.status).toBe(202);
    const planId = (req.body.data as unknown as { id: string }).id;

    const seen: { args: string[]; stdin: string; system: string }[] = [];
    await workUntilHandled(worker, async (args, stdin) => {
      // 지침은 파일로, 프롬프트는 stdin으로 넘긴다(명령줄 길이 제한). 파일은 실행이 끝나면 지워지므로 여기서 읽는다.
      const system = readFileSync(args[args.indexOf('--system-prompt-file') + 1]!, 'utf8');
      seen.push({ args, stdin, system });
      return { exitCode: 0, stdout: claudeOutput(), stderr: '' };
    });
    await drainPmJobs();

    expect(seen[0]!.system).toBe(PM_SYSTEM_PROMPT);
    expect(seen[0]!.stdin).toContain('참여 신청 기능');
    expect(seen[0]!.args).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--no-session-persistence', '--model', env.PM_MODEL]));
    expect(seen[0]!.args[seen[0]!.args.indexOf('--tools') + 1]).toBe('');

    const plan = await getPlan(w, planId);
    expect(plan).toMatchObject({ status: 'ready', error: null });
    expect(plan.draft).toEqual(DRAFT); // PM이 낸 JSON 그대로

    const calls = await pool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'PM_CALL'`);
    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0]!.on_behalf_of).toBe('system:pm');
    expect(calls.rows[0]!.payload).toMatchObject({ provider: 'relay', servedModel: 'claude-sonnet-5-5' });
  });

  it('노트북에서 실행이 실패하면 시간 제한을 기다리지 않고 failed(api_error)로 닫는다', async () => {
    const w = await world();
    const worker = await agentClient(w.rep.connectKey, 'rep-laptop');
    const req = await call('POST', `/projects/${w.projectId}/pm/plans`, w.rep.token, { instruction: 'x' });
    const planId = (req.body.data as unknown as { id: string }).id;

    await workUntilHandled(worker, async () => ({
      exitCode: 1,
      stdout: claudeOutput({ is_error: true, subtype: 'error_during_execution', result: 'Not logged in' }),
      stderr: '',
    }));
    await drainPmJobs();

    const plan = await getPlan(w, planId);
    expect(plan.status).toBe('failed');
    expect(plan.error!.reason).toBe('api_error');
    expect(plan.error!.detail!.message).toContain('Not logged in');
    // 노트북이 실패를 보고했다 — NOMOS 키로 나간 돈이 없으니 최대치로 정산하지 않는다.
    const failedCall = await pool.query(`SELECT token_cost::float8 AS cost, payload FROM events WHERE type = 'PM_CALL'`);
    expect(failedCall.rows.map((r) => [r.cost, r.payload.interrupted])).toEqual([[0, false]]);
  });

  it('아무도 가져가지 않으면 시간 제한으로 failed(timeout)이고, 대기열에서도 빠진다', async () => {
    mutableEnv.PM_TIMEOUT_MS = 50;
    const w = await world();
    const worker = await agentClient(w.rep.connectKey, 'rep-laptop');
    const req = await call('POST', `/projects/${w.projectId}/pm/plans`, w.rep.token, { instruction: 'x' });
    await drainPmJobs();

    const plan = await getPlan(w, (req.body.data as unknown as { id: string }).id);
    expect(plan).toMatchObject({ status: 'failed', error: { reason: 'timeout' } });
    // 아무도 가져가지 않았다 — 모델이 돌지 않았으니 비용 0(노트북이 꺼져 있던 요청마다 예산이 깎이지 않게).
    const untaken = await pool.query(`SELECT token_cost::float8 AS cost FROM events WHERE type = 'PM_CALL'`);
    expect(untaken.rows.map((r) => r.cost)).toEqual([0]);
    expect(await worker.nextPmJob()).toBeNull();
  });

  it('대표 본인의 에이전트만 작업을 가져가고 결과를 낼 수 있다', async () => {
    const w = await world();
    const member = await agentClient(w.be.connectKey, 'be-laptop');
    const worker = await agentClient(w.rep.connectKey, 'rep-laptop');
    await call('POST', `/projects/${w.projectId}/pm/plans`, w.rep.token, { instruction: 'x' });

    await expect(member.nextPmJob()).rejects.toMatchObject({ status: 403, code: 'NOT_REPRESENTATIVE' });

    let jobId = '';
    for (let i = 0; i < 100 && !jobId; i += 1) {
      const job = await worker.nextPmJob();
      if (job) jobId = String(job.id);
      else await new Promise((r) => setTimeout(r, 20));
    }
    // 한 번 가져간 작업은 다시 나오지 않는다.
    expect(await worker.nextPmJob()).toBeNull();
    // 가져가지 않은 쪽(다른 에이전트)의 제출은 받지 않는다 — 같은 대표의 다른 노트북이라도.
    const other = await agentClient(w.rep.connectKey, 'rep-desktop');
    await expect(other.failPmJob(jobId, 'nope')).rejects.toMatchObject({ status: 404, code: 'PM_JOB_NOT_FOUND' });
    await worker.failPmJob(jobId, 'cancelled by test');
  });

  it('API 모드에서는 작업 API가 409 PM_RELAY_DISABLED다', async () => {
    mutableEnv.PM_PROVIDER = 'api';
    const w = await world();
    const worker = await agentClient(w.rep.connectKey, 'rep-laptop');
    await expect(worker.nextPmJob()).rejects.toMatchObject({ status: 409, code: 'PM_RELAY_DISABLED' });
  });
});

describe('claude 출력 → 결과', () => {
  it('structured_output이 있으면 그것을, 없으면 result 텍스트를 쓴다', () => {
    const withStructured = toJobResult(JSON.parse(claudeOutput()) as never, 'm');
    expect(withStructured).toMatchObject({ text: JSON.stringify(DRAFT), servedModel: 'claude-sonnet-5-5', stopReason: 'end_turn' });
    const plain = toJobResult({ result: '{"a":1}' }, 'claude-sonnet-5-5');
    expect(plain).toMatchObject({ text: '{"a":1}', servedModel: 'claude-sonnet-5-5', stopReason: null });
    expect(toJobResult({ result: '' }, 'm')).toEqual({ error: 'claude returned no output' });
  });
});

describe('PM 준비 상태 (GET /projects/:id/pm/status)', () => {
  type Status = { provider: string; ready: boolean; reason: string | null; workerLastSeenAt: string | null; budgetUsd: number; spentUsd: number; pendingPlanId: string | null };
  const status = async (w: { projectId: string; rep: { token: string } }) =>
    (await call('GET', `/projects/${w.projectId}/pm/status`, w.rep.token)).body.data as unknown as Status;

  it('중계 모드: 워커가 확인하기 전에는 WORKER_OFFLINE, 확인하면 ready — 작성 중인 계획도 알려준다', async () => {
    const w = await world();
    expect(await status(w)).toMatchObject({ provider: 'relay', ready: false, reason: 'WORKER_OFFLINE', workerLastSeenAt: null, budgetUsd: 40, spentUsd: 0, pendingPlanId: null });

    const worker = await agentClient(w.rep.connectKey, 'rep-laptop');
    await worker.nextPmJob(); // 워커가 한 번 확인했다
    const online = await status(w);
    expect(online).toMatchObject({ ready: true, reason: null });
    expect(online.workerLastSeenAt).not.toBeNull();

    const req = await call('POST', `/projects/${w.projectId}/pm/plans`, w.rep.token, { instruction: 'x' });
    expect((await status(w)).pendingPlanId).toBe((req.body.data as unknown as { id: string }).id);
  });

  it('API 모드인데 키가 없으면 NO_API_KEY', async () => {
    mutableEnv.PM_PROVIDER = 'api';
    const w = await world();
    expect(await status(w)).toMatchObject({ provider: 'api', ready: false, reason: 'NO_API_KEY' });
  });

  it('대표만 본다', async () => {
    const w = await world();
    expect((await call('GET', `/projects/${w.projectId}/pm/status`, w.be.token)).status).toBe(403);
  });
});
