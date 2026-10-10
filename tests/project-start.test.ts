import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { createSpec, createTask } from '../src/domain/authoring/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { assignMember, createProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { questionsChanged } from '../src/domain/dispatch/questions-changed.js';
import { streamTaskSource } from '../src/executor/stream-source.js';
import { attachAgentStream, type AgentStream } from '../src/realtime/agent-stream.js';
import { assignRootOwner } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 프로젝트 시작(G1)과 시작 이후의 태스크 배정(웹소켓 푸시).

let server: Server;
let stream: AgentStream;
let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  await resetSchema();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  stream = attachAgentStream(server);
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/api/agents/stream`;
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await stream.close();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

type Body = { data?: Record<string, never>; error?: { code: string; message: string; details?: { where: string; message: string }[] } };

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

// 대표·백엔드 팀원, 레포 2개(api=BACKEND, web=FRONTEND), 프로젝트 하나.
async function world() {
  const rep = await account('rep');
  const { orgId } = await createOrganization(rep.userId, 'Acme');
  const be = await account('be');
  const { token } = await createInvite(orgId, rep.userId);
  await acceptInvite(token, be.userId);
  const [api, web] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/api' }, { fullName: 'acme/web' }] });
  await assignRootOwner(orgId, rep.userId, api!.id, 'BACKEND');
  await assignRootOwner(orgId, rep.userId, web!.id, 'FRONTEND');
  const { project } = await createProject(orgId, rep.userId, { name: 'P', autonomyPreset: 'L2', pmBudgetUsd: 10, repoIds: [api!.id, web!.id] });
  const actor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' };
  return { rep, be, orgId, actor, projectId: project.id, apiRepoId: api!.id, webRepoId: web!.id };
}

type World = Awaited<ReturnType<typeof world>>;

async function backendAgent(w: World) {
  const agent = await connectAgent({ connectKey: w.be.connectKey, agentName: 'be-mbp', harness: 'test', skills: [], maxConcurrent: 1 });
  await assignMember(w.actor, w.projectId, agent.agentId, 'BACKEND');
  // 배정 뒤 재발급해야 토큰에 project_id가 실린다.
  const { accessToken } = await refreshAgentToken(agent.refreshToken);
  return { ...agent, accessToken };
}

async function backendTask(w: World, title = 'T-1 API', dependsOn: string[] = []) {
  const spec = await createSpec(w.rep.userId, w.projectId, { featureKey: `F-${title}`, title, content: 'WHEN … THEN …', tests: [] });
  return createTask(w.rep.userId, w.projectId, { title, teamRole: 'BACKEND', kind: 'IMPLEMENT', repoId: w.apiRepoId, specId: spec.id, dependsOn });
}

describe('프로젝트 시작(G1)', () => {
  it('태스크가 없으면 422 — 무엇이 비었는지 details로', async () => {
    const w = await world();
    const res = await call('POST', `/projects/${w.projectId}/start`, w.rep.token);
    expect(res.status).toBe(422);
    expect(res.body.error!.code).toBe('PROJECT_START_INVALID');
    expect(res.body.error!.details!.map((d) => d.where)).toEqual(['tasks']);
  });

  it('태스크가 요구하는 역할에 배정된 에이전트가 없으면 422 — 시작 뒤에는 멤버를 바꿀 수 없다', async () => {
    const w = await world();
    await backendAgent(w);
    await backendTask(w);
    await createTask(w.rep.userId, w.projectId, { title: 'T-2 화면', teamRole: 'FRONTEND', kind: 'INTEGRATION', repoId: w.webRepoId, specId: null, dependsOn: [] });
    const res = await call('POST', `/projects/${w.projectId}/start`, w.rep.token);
    expect(res.status).toBe(422);
    expect(res.body.error!.details).toEqual([expect.objectContaining({ where: 'members.FRONTEND' })]);
    expect((await pool.query(`SELECT status, started_at FROM projects WHERE id = $1`, [w.projectId])).rows[0]).toEqual({ status: 'planning', started_at: null });
  });

  it('시작하면 active·startedAt, 명세 승인 시각, PROJECT_STARTED가 남고 멤버가 고정된다', async () => {
    const w = await world();
    const agent = await backendAgent(w);
    await backendTask(w);

    const res = await call('POST', `/projects/${w.projectId}/start`, w.rep.token);
    expect(res.status).toBe(200);
    const detail = res.body.data as unknown as { project: { status: string; startedAt: string | null } };
    expect(detail.project.status).toBe('active');
    expect(detail.project.startedAt).not.toBeNull();
    expect((await pool.query(`SELECT count(*)::int AS n FROM specs WHERE approved_at IS NULL`)).rows[0].n).toBe(0);

    const events = await pool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'PROJECT_STARTED'`);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.on_behalf_of).toBe(w.rep.userId);
    expect(events.rows[0]!.payload).toEqual({
      members: [{ agentId: agent.agentId, teamRole: 'BACKEND' }],
      taskCount: 1,
      approvedSpecCount: 1,
      approvedPlanIds: [],
    });

    // 다시 시작 409, 멤버 변경 403, 팀원은 시작할 수 없다.
    expect((await call('POST', `/projects/${w.projectId}/start`, w.rep.token)).body.error!.code).toBe('PROJECT_ALREADY_STARTED');
    expect((await call('DELETE', `/projects/${w.projectId}/members/${agent.agentId}`, w.rep.token)).status).toBe(403);
    expect((await call('POST', `/projects/${w.projectId}/start`, w.be.token)).status).toBe(403);
  });
});

describe('가져갈 수 있는 태스크 (GET /agents/me/tasks)', () => {
  it('시작 전에는 비어 있고, 시작 뒤에는 선행이 끝난 자기 역할 태스크만 보인다', async () => {
    const w = await world();
    const agent = await backendAgent(w);
    const first = await backendTask(w, 'T-1 API');
    const second = await backendTask(w, 'T-2 API', [first.id]);
    const list = async () =>
      ((await call('GET', '/agents/me/tasks', agent.accessToken)).body.data as unknown as { tasks: { id: string }[] }).tasks.map((t) => t.id);

    expect(await list()).toEqual([]);
    await call('POST', `/projects/${w.projectId}/start`, w.rep.token);
    expect(await list()).toEqual([first.id]); // 두 번째는 선행이 안 끝났다

    // 첫 번째를 잡으면 빠지고, 끝나면 두 번째가 풀린다. (검증 흐름은 tests/verifications.test.ts — 여기서는 결과 상태만 만든다)
    expect((await call('POST', `/tasks/${first.id}/claim`, agent.accessToken)).status).toBe(200);
    expect(await list()).toEqual([]);
    await pool.query(`UPDATE tasks SET state = 'DONE' WHERE id = $1`, [first.id]);
    expect(await list()).toEqual([second.id]);
  });
});

// 메시지를 차례로 받는 웹소켓 클라이언트.
function openStream(url = wsUrl) {
  const ws = new WebSocket(url);
  const inbox: { type: string; tasks?: { id: string }[]; code?: string }[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (raw) => {
    inbox.push(JSON.parse(raw.toString()));
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  const opened = new Promise<void>((resolve) => ws.on('open', () => resolve()));
  async function next(type: string, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return inbox.splice(i, 1)[0]!;
      if (Date.now() > deadline) throw new Error(`no ${type} message (got ${JSON.stringify(inbox)})`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }
  return { ws, opened, closed, next };
}

describe('웹소켓 푸시 (/api/agents/stream)', () => {
  it('연결하면 스냅샷을 받고, 프로젝트를 시작하면 담당 에이전트에게 태스크가 간다 — 잡으면 다시 빈 스냅샷', async () => {
    const w = await world();
    const agent = await backendAgent(w);
    const task = await backendTask(w);

    const s = openStream();
    await s.opened;
    s.ws.send(JSON.stringify({ type: 'auth', token: agent.accessToken }));
    expect(await s.next('ready')).toMatchObject({ type: 'ready' });
    expect((await s.next('tasks')).tasks).toEqual([]); // 시작 전

    await call('POST', `/projects/${w.projectId}/start`, w.rep.token);
    expect((await s.next('tasks')).tasks!.map((t) => t.id)).toEqual([task.id]);

    await call('POST', `/tasks/${task.id}/claim`, agent.accessToken);
    expect((await s.next('tasks')).tasks).toEqual([]);
    s.ws.close();
  });

  it('연결 직후 곧바로 상태가 바뀌어도 마지막에 받은 스냅샷은 최신이다', async () => {
    const w = await world();
    const agent = await backendAgent(w);
    const task = await backendTask(w);
    for (let round = 0; round < 3; round += 1) {
      const s = openStream();
      await s.opened;
      s.ws.send(JSON.stringify({ type: 'auth', token: agent.accessToken }));
      if (round === 0) await call('POST', `/projects/${w.projectId}/start`, w.rep.token); // 첫 스냅샷 계산과 겹친다
      await s.next('ready');
      // 받은 스냅샷 중 마지막 것이 지금 상태(태스크 1개)여야 한다.
      let last: { id: string }[] | undefined;
      for (let i = 0; i < 10; i += 1) {
        try {
          last = (await s.next('tasks', 300)).tasks;
        } catch {
          break;
        }
      }
      expect(last?.map((t) => t.id)).toEqual([task.id]);
      s.ws.close();
    }
  });

  it('토큰이 틀리면 4401, 프로젝트에 배정되지 않은 에이전트는 4403, 첫 메시지가 auth가 아니면 4400', async () => {
    const w = await world();
    const bad = openStream();
    await bad.opened;
    bad.ws.send(JSON.stringify({ type: 'auth', token: 'nope' }));
    expect(await bad.closed).toBe(4401);

    const loose = await connectAgent({ connectKey: w.be.connectKey, agentName: 'be-mbp', harness: 'test', skills: [], maxConcurrent: 1 });
    const notMember = openStream();
    await notMember.opened;
    notMember.ws.send(JSON.stringify({ type: 'auth', token: loose.accessToken }));
    expect(await notMember.closed).toBe(4403);

    const garbage = openStream();
    await garbage.opened;
    garbage.ws.send('hello');
    expect(await garbage.closed).toBe(4400);
  });

  it('다른 경로로는 업그레이드하지 않는다', async () => {
    const other = openStream(wsUrl.replace('/api/agents/stream', '/api/other'));
    const result = await Promise.race([other.closed.then(() => 'closed'), new Promise((r) => other.ws.on('error', () => r('error')))]);
    expect(['closed', 'error']).toContain(result);
  });
});

describe('Executor 쪽 수신(streamTaskSource)', () => {
  it('푸시로 받은 태스크를 내주고, 시작 전에는 비어 있다', async () => {
    const w = await world();
    const agent = await backendAgent(w);
    const task = await backendTask(w);

    const lines: string[] = [];
    const source = streamTaskSource({
      baseUrl,
      accessToken: () => agent.accessToken,
      refresh: async () => {},
      fallback: async () => {
        throw new Error('연결돼 있으면 폴링하지 않는다');
      },
      log: (l) => lines.push(l),
    });
    try {
      // 연결·첫 스냅샷까지
      for (let i = 0; i < 50 && !source.connected; i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(source.connected).toBe(true);
      expect(await source.nextTasks(5)).toEqual([]);

      // 시작 직후의 푸시가 연결 직후의 첫 스냅샷과 겹쳐도 마지막에 들고 있는 목록은 최신이어야 한다(서버가 연결별로 차례로 보낸다).
      await call('POST', `/projects/${w.projectId}/start`, w.rep.token);
      let ids: string[] = [];
      for (let i = 0; i < 30 && ids.length === 0; i += 1) {
        await source.waitForChange(100);
        ids = (await source.nextTasks(5)).map((t) => t.id);
      }
      expect(ids).toEqual([task.id]);
      expect(lines.join('\n')).toContain('서버 푸시 연결됨');
    } finally {
      source.close();
    }
  });

  it('상담할 질문은 신호가 왔을 때만 확인한다 — 연결 직후 한 번, 자기 역할 신호, 안전망 간격', async () => {
    const w = await world();
    const agent = await backendAgent(w);
    let clock = 0;
    const source = streamTaskSource({
      baseUrl,
      accessToken: () => agent.accessToken,
      refresh: async () => {},
      fallback: async () => [],
      log: () => {},
      consultFallbackMs: 60_000,
      now: () => clock,
    });
    try {
      for (let i = 0; i < 50 && !source.connected; i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(source.connected).toBe(true);
      expect(source.consultDue('BACKEND')).toBe(true); // 연결 직후 — 끊긴 동안 놓친 질문
      expect(source.consultDue('BACKEND')).toBe(false);

      // 서버 푸시는 프로젝트 연결 전부에 가고, 받는 쪽이 자기 역할만 본다.
      questionsChanged(w.projectId, 'FRONTEND');
      await source.waitForChange(500);
      expect(source.consultDue('BACKEND')).toBe(false);

      const woke = source.waitForChange(2000).then(() => 'woke');
      questionsChanged(w.projectId, 'BACKEND');
      expect(await woke).toBe('woke');
      expect(source.consultDue('BACKEND')).toBe(true);
      expect(source.consultDue('BACKEND')).toBe(false);

      clock += 60_000; // 신호를 놓쳐도 안전망 간격마다 한 번
      expect(source.consultDue('BACKEND')).toBe(true);
    } finally {
      source.close();
    }
  });

  it('연결되지 않으면 HTTP 목록(fallback)을 쓴다', async () => {
    const source = streamTaskSource({
      baseUrl: 'http://127.0.0.1:9', // 아무도 듣지 않는 포트
      accessToken: () => 'x',
      refresh: async () => {},
      fallback: async () => [{ id: 't1', title: 'T', state: 'READY', teamRole: 'BACKEND', repoId: 'r', specId: null, branchName: null }],
      log: () => {},
      backoff: { initialMs: 10_000, maxMs: 10_000 },
    });
    try {
      expect((await source.nextTasks(5)).map((t) => t.id)).toEqual(['t1']);
      // 끊겨 있으면 질문 신호를 받을 수 없으니 매번 확인한다.
      expect(source.consultDue('BACKEND')).toBe(true);
      expect(source.consultDue('BACKEND')).toBe(true);
    } finally {
      source.close();
    }
  });
});
