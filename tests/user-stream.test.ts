import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { pool, withTransaction } from '../src/config/db.js';
import { clearPresence, markAgentSeen, ONLINE_WINDOW_MS, sweepPresence } from '../src/domain/agent/presence.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { createTask } from '../src/domain/authoring/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { appendEvent } from '../src/domain/events/append.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { assignMember, createProject, unassignMember } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { attachRealtime, type Realtime } from '../src/realtime/index.js';
import { TOPICS_BY_EVENT } from '../src/realtime/topics.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 사람용 실시간 신호 스트림(/api/stream) — 커밋된 이벤트(트리거 → NOTIFY)와 에이전트 접속 상태를 "다시 읽어라" 신호로 보낸다.

let server: Server;
let realtime: Realtime;
let wsBase: string;

beforeAll(async () => {
  await resetSchema();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  realtime = attachRealtime(server);
  await realtime.ready;
  wsBase = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await truncateAll();
  clearPresence();
});

afterAll(async () => {
  await realtime.close();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

type Message = { type: string; [key: string]: unknown };

// 받은 메시지를 모아 두고 조건이 맞을 때까지 기다린다.
type Client = { ws: WebSocket; messages: Message[]; waitFor(pred: (m: Message) => boolean, ms?: number): Promise<Message>; close(): void };

async function open(path = '/api/stream', headers: Record<string, string> = {}): Promise<Client> {
  const ws = new WebSocket(`${wsBase}${path}`, { headers });
  const messages: Message[] = [];
  const waiters: { pred: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as Message;
    messages.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    ws,
    messages,
    waitFor: (pred, ms = 3000) => {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(messages)}`)), ms);
        waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
    close: () => ws.close(),
  };
}

async function connectAs(token: string): Promise<Client> {
  const c = await open();
  c.ws.send(JSON.stringify({ type: 'auth', token }));
  await c.waitFor((m) => m.type === 'ready');
  return c;
}

async function subscribe(c: Client, projectId: string): Promise<Message> {
  c.ws.send(JSON.stringify({ type: 'subscribe', projectId }));
  return c.waitFor((m) => (m.type === 'subscribed' || m.type === 'error') && m.projectId === projectId);
}

const closedWith = (ws: WebSocket) => new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
const quiet = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const changed = (projectId: string | null) => (m: Message) => m.type === 'changed' && m.projectId === projectId;

async function account(loginId: string) {
  const { userId, connectKey } = await signup({ loginId, password: 'correct-horse-battery', nickname: loginId });
  const { accessToken } = await login({ loginId, password: 'correct-horse-battery' });
  return { userId, token: accessToken, connectKey };
}

// 대표, 배정된 백엔드 팀원, 배정 안 된 팀원, 프로젝트 하나.
async function world() {
  const rep = await account('rep');
  const { orgId } = await createOrganization(rep.userId, 'Acme');
  const be = await account('be');
  const outsider = await account('fe');
  for (const u of [be, outsider]) {
    const { token } = await createInvite(orgId, rep.userId);
    await acceptInvite(token, u.userId);
  }
  const [api] = await connectRepos({ orgId, actorUserId: rep.userId, actorOrgRole: 'REPRESENTATIVE', repos: [{ fullName: 'acme/api', ownerRole: 'BACKEND' }] });
  const { project } = await createProject(orgId, rep.userId, { name: 'P', autonomyPreset: 'L2', pmBudgetUsd: 5, repoIds: [api!.id] });
  const agent = await connectAgent({ connectKey: be.connectKey, agentName: 'be-mbp', harness: 'test', skills: [], maxConcurrent: 1 });
  const repActor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' as const };
  await assignMember(repActor, project.id, agent.agentId, 'BACKEND');
  return { rep, be, outsider, orgId, repActor, projectId: project.id, repoId: api!.id, agent };
}

const newTask = (w: Awaited<ReturnType<typeof world>>, title: string) =>
  createTask(w.rep.userId, w.projectId, { title, teamRole: 'BACKEND', kind: 'INTEGRATION', repoId: w.repoId, specId: null, dependsOn: [] });

describe('연결과 인증', () => {
  it('첫 메시지로 사람 토큰을 받는다 — 틀리면 4401, 조직이 없으면 4403', async () => {
    const w = await world();
    const ok = await connectAs(w.rep.token);
    expect(ok.messages[0]).toMatchObject({ type: 'ready', userId: w.rep.userId, orgId: w.orgId, orgRole: 'REPRESENTATIVE' });
    ok.close();

    const bad = await open();
    const badClosed = closedWith(bad.ws);
    bad.ws.send(JSON.stringify({ type: 'auth', token: 'nope' }));
    expect(await badClosed).toBe(4401);

    const lonely = await account('lonely');
    const noOrg = await open();
    const noOrgClosed = closedWith(noOrg.ws);
    noOrg.ws.send(JSON.stringify({ type: 'auth', token: lonely.token }));
    expect(await noOrgClosed).toBe(4403);
  });

  it('에이전트 토큰으로는 붙지 못한다(사람 전용)', async () => {
    const w = await world();
    const { accessToken } = await refreshAgentToken(w.agent.refreshToken);
    const c = await open();
    const closed = closedWith(c.ws);
    c.ws.send(JSON.stringify({ type: 'auth', token: accessToken }));
    expect(await closed).toBe(4401);
  });

  it('허용되지 않은 Origin의 브라우저는 업그레이드부터 막는다', async () => {
    const ws = new WebSocket(`${wsBase}/api/stream`, { headers: { Origin: 'https://evil.example' } });
    const status = await new Promise<number>((resolve) => ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(403);
  });

  it('에이전트 스트림과 같은 서버에서 함께 돈다 — 모르는 경로는 끊는다', async () => {
    const w = await world();
    const { accessToken } = await refreshAgentToken(w.agent.refreshToken);
    const agent = await open('/api/agents/stream');
    agent.ws.send(JSON.stringify({ type: 'auth', token: accessToken }));
    await agent.waitFor((m) => m.type === 'ready');
    agent.close();

    const unknown = new WebSocket(`${wsBase}/api/nope`);
    await new Promise<void>((resolve) => unknown.once('error', () => resolve()));
  });
});

describe('프로젝트 구독과 신호', () => {
  it('구독한 프로젝트에서 커밋된 변화가 토픽으로 온다 — 데이터는 싣지 않는다', async () => {
    const w = await world();
    const rep = await connectAs(w.rep.token);
    expect(await subscribe(rep, w.projectId)).toMatchObject({ type: 'subscribed' });

    await newTask(w, 'T-1 로그인');
    const m = await rep.waitFor(changed(w.projectId));
    expect(m.topics).toEqual(['events', 'tasks']);
    expect(m.lastEventId).toEqual(expect.any(String));
    expect(Object.keys(m).sort()).toEqual(['lastEventId', 'projectId', 'topics', 'type']);
    rep.close();
  });

  it('볼 수 없는 프로젝트는 구독이 거절된다 — 배정된 팀원은 되고, 안 된 팀원은 NOT_PROJECT_MEMBER', async () => {
    const w = await world();
    const be = await connectAs(w.be.token);
    const outsider = await connectAs(w.outsider.token);
    expect(await subscribe(be, w.projectId)).toMatchObject({ type: 'subscribed' });
    expect(await subscribe(outsider, w.projectId)).toMatchObject({ type: 'error', code: 'NOT_PROJECT_MEMBER' });

    await newTask(w, 'T-1 로그인');
    await be.waitFor(changed(w.projectId));
    await quiet();
    expect(outsider.messages.some(changed(w.projectId))).toBe(false);
    be.close();
    outsider.close();
  });

  it('롤백된 변화는 신호를 내지 않는다 — NOTIFY는 커밋할 때만 전달된다', async () => {
    const w = await world();
    const rep = await connectAs(w.rep.token);
    await subscribe(rep, w.projectId);

    await expect(
      withTransaction(async (tx) => {
        // 신호원 검증용으로 이벤트만 직접 남긴다(롤백할 것이라 서비스 경로가 필요 없다).
        await appendEvent(tx, { orgId: w.orgId, projectId: w.projectId, type: 'TASK_CREATED', onBehalfOf: w.rep.userId, payload: {} as never });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await quiet();
    expect(rep.messages.some(changed(w.projectId))).toBe(false);

    await newTask(w, 'T-2 커밋됨');
    await rep.waitFor(changed(w.projectId));
    rep.close();
  });

  it('한 트랜잭션의 여러 이벤트는 한 메시지로 모인다', async () => {
    const w = await world();
    const rep = await connectAs(w.rep.token);
    await subscribe(rep, w.projectId);

    await withTransaction(async (tx) => {
      for (const type of ['SPEC_CREATED', 'TASK_CREATED', 'TASK_CREATED'] as const) {
        await appendEvent(tx, { orgId: w.orgId, projectId: w.projectId, type, onBehalfOf: w.rep.userId, payload: {} as never });
      }
    });
    await rep.waitFor(changed(w.projectId));
    await quiet();
    const signals = rep.messages.filter(changed(w.projectId));
    expect(signals).toHaveLength(1);
    expect(signals[0]!.topics).toEqual(['events', 'specs', 'tasks']);
    rep.close();
  });

  it('배정이 해제되면 그 팀원의 구독이 끊긴다', async () => {
    const w = await world();
    const be = await connectAs(w.be.token);
    await subscribe(be, w.projectId);

    await unassignMember(w.repActor, w.projectId, w.agent.agentId);
    expect(await be.waitFor((m) => m.type === 'unsubscribed')).toMatchObject({ projectId: w.projectId, reason: 'NOT_PROJECT_MEMBER' });

    await newTask(w, 'T-3');
    await quiet();
    expect(be.messages.filter(changed(w.projectId)).every((m) => !(m.topics as string[]).includes('tasks'))).toBe(true);
    be.close();
  });
});

describe('조직 신호', () => {
  it('승인 요청은 대표에게 조직 신호로 간다 — 팀원에게는 approvals 조직 신호가 가지 않는다', async () => {
    const w = await world();
    const rep = await connectAs(w.rep.token);
    const be = await connectAs(w.be.token);

    await withTransaction((tx) =>
      appendEvent(tx, { orgId: w.orgId, projectId: w.projectId, type: 'APPROVAL_REQUESTED', onBehalfOf: w.rep.userId, payload: {} as never }),
    );
    expect((await rep.waitFor(changed(null))).topics).toEqual(['approvals']);
    await quiet();
    expect(be.messages.some(changed(null))).toBe(false);
    rep.close();
    be.close();
  });

  it('다른 조직의 신호는 받지 않는다', async () => {
    const w = await world();
    const rival = await account('rival');
    await createOrganization(rival.userId, 'Rival');
    const other = await connectAs(rival.token);

    await withTransaction((tx) =>
      appendEvent(tx, { orgId: w.orgId, projectId: w.projectId, type: 'APPROVAL_REQUESTED', onBehalfOf: w.rep.userId, payload: {} as never }),
    );
    await quiet();
    expect(other.messages.filter((m) => m.type === 'changed')).toEqual([]);
    other.close();
  });

  it('에이전트 접속 상태가 바뀔 때만 agents 신호가 간다 — 60초가 지나 offline이 되는 것도', async () => {
    const w = await world();
    const rep = await connectAs(w.rep.token);

    const t0 = new Date();
    markAgentSeen(w.agent.agentId, t0);
    expect((await rep.waitFor(changed(null))).topics).toEqual(['agents']);
    markAgentSeen(w.agent.agentId, new Date(t0.getTime() + 1000)); // 계속 online — 신호 없음
    await quiet();
    expect(rep.messages.filter(changed(null))).toHaveLength(1);

    sweepPresence(t0.getTime() + ONLINE_WINDOW_MS + 5000);
    await rep.waitFor((m) => changed(null)(m) && rep.messages.filter(changed(null)).length === 2);
    rep.close();
  });
});

describe('토픽 매핑', () => {
  it('승인·태스크·계획처럼 화면이 다시 읽어야 할 이벤트는 매핑이 비어 있지 않다', () => {
    for (const type of ['TASK_CLAIMED', 'VERIFICATION_COMPLETED', 'APPROVAL_RESULT', 'PM_PLAN_DRAFTED', 'PLAN_APPLIED', 'NOTE_PUBLISHED'] as const) {
      expect(TOPICS_BY_EVENT[type].project?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
