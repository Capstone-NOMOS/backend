import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { clearPresence, ONLINE_WINDOW_MS, presenceOf } from '../src/domain/agent/presence.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { assignMember, createProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { attachAgentStream, type AgentStream } from '../src/realtime/agent-stream.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 에이전트 온라인 상태(F-14)와 프로젝트 이벤트 로그 조회(F-17 중 로그).

let server: Server;
let stream: AgentStream;
let baseUrl: string;

beforeAll(async () => {
  await resetSchema();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  stream = attachAgentStream(server);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await truncateAll();
  clearPresence();
});

afterAll(async () => {
  await stream.close();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

type Body = { data?: Record<string, never>; error?: { code: string } };
async function call(method: string, url: string, token: string): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${baseUrl}/api${url}`, { method, headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as Body };
}

async function account(loginId: string) {
  const { userId, connectKey } = await signup({ loginId, password: 'correct-horse-battery', nickname: loginId });
  const { accessToken } = await login({ loginId, password: 'correct-horse-battery' });
  return { userId, token: accessToken, connectKey };
}

// 대표·백엔드 팀원·팀원 하나 더(배정 안 됨), 레포 연결 + 역할 지정(한 번에), 프로젝트, 백엔드 에이전트 배정.
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
  await assignMember({ userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' }, project.id, agent.agentId, 'BACKEND');
  const { accessToken } = await refreshAgentToken(agent.refreshToken);
  return { rep, be, outsider, orgId, projectId: project.id, agentId: agent.agentId, agentToken: accessToken };
}

type OrgAgent = { agentId: string; online: boolean; lastSeenAt: string | null };
const agentRow = async (w: Awaited<ReturnType<typeof world>>) =>
  ((await call('GET', `/orgs/${w.orgId}/agents`, w.rep.token)).body.data as unknown as { agents: OrgAgent[] }).agents.find(
    (a) => a.agentId === w.agentId,
  )!;

describe('에이전트 온라인 상태', () => {
  it('요청이 없으면 offline, 인증된 요청이 오면 online과 lastSeenAt', async () => {
    const w = await world();
    expect(await agentRow(w)).toMatchObject({ online: false, lastSeenAt: null });
    await call('GET', '/agents/me', w.agentToken);
    const row = await agentRow(w);
    expect(row.online).toBe(true);
    expect(row.lastSeenAt).not.toBeNull();
  });

  it('태스크 스트림(웹소켓)이 열려 있는 동안은 시간이 지나도 online, 닫히고 시간이 지나면 offline', async () => {
    const w = await world();
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/agents/stream`);
    await new Promise<void>((r) => ws.on('open', () => r()));
    const ready = new Promise<void>((r) => ws.on('message', (m) => JSON.parse(m.toString()).type === 'ready' && r()));
    ws.send(JSON.stringify({ type: 'auth', token: w.agentToken }));
    await ready;

    const later = Date.now() + ONLINE_WINDOW_MS * 10;
    expect(presenceOf(w.agentId, later).online).toBe(true); // 연결이 열려 있다

    const closed = new Promise<void>((r) => ws.on('close', () => r()));
    ws.close();
    await closed;
    await new Promise((r) => setTimeout(r, 50)); // 서버 쪽 close 처리
    expect(presenceOf(w.agentId).online).toBe(true); // 방금까지 있었다
    expect(presenceOf(w.agentId, later).online).toBe(false); // 창이 지나면 offline
  });
});

describe('이벤트 로그 조회', () => {
  type Page = { events: { id: string; type: string; onBehalfOf: string }[]; nextBefore: string | null };
  const page = async (w: Awaited<ReturnType<typeof world>>, qs = '') =>
    (await call('GET', `/projects/${w.projectId}/events${qs}`, w.rep.token)).body.data as unknown as Page;

  it('최신순으로 주고, nextBefore로 이어서 읽으면 빠짐·겹침 없이 전부다', async () => {
    const w = await world();
    const all = await pool.query(`SELECT id::text AS id FROM events WHERE project_id = $1 ORDER BY id DESC`, [w.projectId]);
    expect(all.rows.length).toBeGreaterThan(1);

    const seen: string[] = [];
    let before = '';
    for (;;) {
      const p = await page(w, `?limit=1${before}`);
      seen.push(...p.events.map((e) => e.id));
      if (!p.nextBefore) break;
      before = `&before=${p.nextBefore}`;
    }
    expect(seen).toEqual(all.rows.map((r) => r.id));
  });

  it('types로 거른다', async () => {
    const w = await world();
    const p = await page(w, '?types=MEMBER_ASSIGNED');
    expect(p.events.map((e) => e.type)).toEqual(['MEMBER_ASSIGNED']);
    expect(p.events[0]!.onBehalfOf).toBe(w.rep.userId);
  });

  it('배정된 팀원은 보고, 배정 안 된 팀원은 403, 에이전트 토큰은 401', async () => {
    const w = await world();
    expect((await call('GET', `/projects/${w.projectId}/events`, w.be.token)).status).toBe(200);
    expect((await call('GET', `/projects/${w.projectId}/events`, w.outsider.token)).status).toBe(403);
    expect((await call('GET', `/projects/${w.projectId}/events`, w.agentToken)).status).toBe(401);
  });
});
