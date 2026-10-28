import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { NomosClient } from '../src/bridge/nomos-client.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { createSpec, createTask } from '../src/domain/authoring/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { clearPolicyCache } from '../src/domain/policy/policy-cache.js';
import { assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { attachRealtime, type Realtime } from '../src/realtime/index.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 프로젝트 삭제와 조직 해산(029). 행은 지우지 않고 표시만 남긴 뒤 어디서도 보이지 않게 한다.
// 픽스처는 전부 서비스·HTTP를 거친다.

let server: Server;
let baseUrl: string;
let realtime: Realtime;

beforeAll(async () => {
  await resetSchema();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  // 화면 스트림(/api/stream)을 붙인다 — 삭제·해산 뒤 연결이 끊기는지 본다.
  realtime = attachRealtime(server);
  await realtime.ready;
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await truncateAll();
  clearPolicyCache();
});

afterAll(async () => {
  await realtime.close();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

const PASSWORD = 'correct-horse-battery';

async function account(loginId: string) {
  const { userId, connectKey } = await signup({ loginId, password: PASSWORD, nickname: loginId });
  return { userId, connectKey, token: async () => (await login({ loginId, password: PASSWORD })).accessToken };
}

// 대표, FE 담당, BE 담당, 시작한 프로젝트 하나(FE·BE 태스크 하나씩). claim: FE 에이전트가 태스크를 잡은 상태까지.
async function world(options: { claim?: boolean } = {}) {
  const rep = await account('rep');
  const fe = await account('fe');
  const be = await account('be');
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
  const { project } = await createProject(orgId, rep.userId, { name: 'Study', autonomyPreset: 'L2', pmBudgetUsd: 5, repoIds: [web!.id, api!.id] });
  const repActor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' as const };
  const feAgent = await connectAgent({ connectKey: fe.connectKey, agentName: 'fe-mbp', harness: 'test', skills: [], maxConcurrent: 1 });
  const beAgent = await connectAgent({ connectKey: be.connectKey, agentName: 'be-mbp', harness: 'test', skills: [], maxConcurrent: 1 });
  await assignMember(repActor, project.id, feAgent.agentId, 'FRONTEND');
  await assignMember(repActor, project.id, beAgent.agentId, 'BACKEND');
  const spec = await createSpec(rep.userId, project.id, { featureKey: 'F-1', title: '스터디 목록', content: '스터디 목록을 보여 준다.', tests: [] });
  const task = await createTask(rep.userId, project.id, { title: 'T-1 목록 화면', teamRole: 'FRONTEND', kind: 'IMPLEMENT', repoId: web!.id, specId: spec.id, dependsOn: [] });
  await createTask(rep.userId, project.id, { title: 'T-2 목록 API', teamRole: 'BACKEND', kind: 'IMPLEMENT', repoId: api!.id, specId: spec.id, dependsOn: [] });
  await startProject(repActor, project.id);
  const feClient = new NomosClient({ baseUrl, tokens: { accessToken: (await refreshAgentToken(feAgent.refreshToken)).accessToken, refreshToken: feAgent.refreshToken } });
  if (options.claim) await feClient.claimTask(task.id);
  return { orgId, projectId: project.id, taskId: task.id, repoIds: [web!.id, api!.id], rep, fe, be, feClient, feAgentId: feAgent.agentId };
}

type Json = { data?: Record<string, unknown>; error?: { code: string; details?: unknown } };
async function http(method: string, urlPath: string, token: string | null, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}/api${urlPath}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

const eventsOf = async (type: string) => (await pool.query(`SELECT org_id, project_id, on_behalf_of, payload FROM events WHERE type = $1 ORDER BY id`, [type])).rows;
const count = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0].n as number;

// src/routes/*.ts의 라우트 중 :projectId가 들어간 것 — 목록을 손으로 적지 않는다(새 라우트가 빠지지 않게).
type RouteLayer = { route?: { path: string; methods: Record<string, boolean> } };
async function projectRoutes(param = ':projectId'): Promise<{ method: string; path: string }[]> {
  const modules = import.meta.glob<Record<string, unknown>>(['../src/routes/*.ts', '!../src/routes/docs.ts'], { eager: true });
  const routes: { method: string; path: string }[] = [];
  for (const mod of Object.values(modules)) {
    for (const value of Object.values(mod)) {
      const stack = (value as { stack?: RouteLayer[] } | null)?.stack;
      if (typeof value !== 'function' || !Array.isArray(stack)) continue;
      for (const layer of stack) {
        if (!layer.route || !layer.route.path.includes(param)) continue;
        for (const [method, on] of Object.entries(layer.route.methods)) if (on && method !== '_all') routes.push({ method: method.toUpperCase(), path: layer.route.path });
      }
    }
  }
  return routes;
}

describe('프로젝트 삭제 — DELETE /projects/:projectId', () => {
  it('진행 중이면 같은 트랜잭션에서 먼저 중단하고 지운다 — 행은 남고, PROJECT_ABORTED → PROJECT_DELETED, 에이전트·레포가 풀린다', async () => {
    const w = await world({ claim: true });
    const res = await http('DELETE', `/projects/${w.projectId}`, await w.rep.token());
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ projectId: w.projectId, abortedNow: true });

    const row = (await pool.query(`SELECT status, deleted_at FROM projects WHERE id = $1`, [w.projectId])).rows[0];
    expect(row.status).toBe('aborted');
    expect(row.deleted_at).not.toBeNull();
    // 태스크·명세는 지우지 않는다(P5).
    expect(await count(`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1`, [w.projectId])).toBe(2);

    const aborted = await eventsOf('PROJECT_ABORTED');
    const deleted = await eventsOf('PROJECT_DELETED');
    expect(aborted).toHaveLength(1);
    expect(deleted).toEqual([
      { org_id: w.orgId, project_id: w.projectId, on_behalf_of: w.rep.userId, payload: { name: 'Study', previousStatus: 'active', abortedNow: true } },
    ]);
    // 중단과 같은 규칙: 태스크를 잡은 에이전트가 있어도 막지 않는다 — 그 CLI는 다음 요청에서 배정이 풀린 것을 본다.
    await expect(w.feClient.getBriefing(w.taskId)).rejects.toMatchObject({ code: 'NOT_PROJECT_MEMBER' });
    // 레포가 풀려 레포 목록의 activeProjectId가 비고, 새 프로젝트에 다시 쓸 수 있다.
    const repos = (await http('GET', `/orgs/${w.orgId}/repos`, await w.rep.token())).json.data!.repos as { id: string; activeProjectId: string | null }[];
    expect(repos.filter((r) => w.repoIds.includes(r.id)).map((r) => r.activeProjectId)).toEqual([null, null]);
  });

  it('끝난 프로젝트는 중단 없이 지운다(abortedNow false), 다시 지우면 404 PROJECT_NOT_FOUND', async () => {
    const w = await world();
    const rep = await w.rep.token();
    await http('POST', `/projects/${w.projectId}/abort`, rep, {});
    const res = await http('DELETE', `/projects/${w.projectId}`, rep);
    expect(res.json.data).toEqual({ projectId: w.projectId, abortedNow: false });
    expect((await eventsOf('PROJECT_DELETED'))[0]!.payload).toMatchObject({ previousStatus: 'aborted', abortedNow: false });

    const again = await http('DELETE', `/projects/${w.projectId}`, rep);
    expect(again.status).toBe(404);
    expect(again.json.error!.code).toBe('PROJECT_NOT_FOUND');
    expect(await eventsOf('PROJECT_DELETED')).toHaveLength(1);
  });

  it('대표가 아니면 403, 없는 프로젝트는 404 — 아무것도 바뀌지 않는다', async () => {
    const w = await world();
    expect((await http('DELETE', `/projects/${w.projectId}`, await w.fe.token())).status).toBe(403);
    expect((await http('DELETE', `/projects/${randomUUID()}`, await w.rep.token())).status).toBe(404);
    expect((await pool.query(`SELECT status, deleted_at FROM projects WHERE id = $1`, [w.projectId])).rows[0]).toEqual({ status: 'active', deleted_at: null });
    expect(await eventsOf('PROJECT_DELETED')).toEqual([]);
  });

  it('지운 프로젝트는 목록에서 빠지고, :projectId가 들어간 GET은 대표 토큰으로도 전부 404다 — 쓰기도 2xx가 아니다', async () => {
    const w = await world();
    // 지우기 전에 질문 하나를 만들어 둔다 — GET /me/questions에서 빠지는지 본다.
    const feClient = w.feClient;
    await feClient.claimTask(w.taskId);
    await feClient.askQuestions(w.taskId, [{ question: '페이지 크기는?', options: [{ label: '10' }, { label: '20' }] }]);
    const rep = await w.rep.token();
    expect(((await http('GET', '/me/questions', rep)).json.data!.questions as unknown[]).length).toBe(1);

    await http('DELETE', `/projects/${w.projectId}`, rep);

    const list = (await http('GET', `/orgs/${w.orgId}/projects`, rep)).json.data!.projects as { id: string }[];
    expect(list.map((p) => p.id)).not.toContain(w.projectId);
    expect((await http('GET', '/me/questions?status=all', rep)).json.data!.questions).toEqual([]);
    expect((await http('GET', `/orgs/${w.orgId}/approvals?status=all`, rep)).json.data!.approvals).toEqual([]);

    const routes = await projectRoutes();
    expect(routes.length).toBeGreaterThan(10);
    const leaks: string[] = [];
    for (const r of routes) {
      const url = r.path.replace(':projectId', w.projectId).replace(':role', 'BACKEND').replace(/:[A-Za-z]+/g, randomUUID());
      const res = await http(r.method, url, rep, r.method === 'GET' ? undefined : {});
      // 에이전트 전용 라우트는 사람 토큰을 401로 거부한다 — 그것도 "보이지 않음"이다.
      // PM_UNAVAILABLE(503)은 프로젝트를 읽기 전에 서버 설정(ANTHROPIC_API_KEY 없음)으로 막힌 것이라 새는 것이 아니다.
      const blocked = r.method === 'GET' ? res.status === 404 || res.status === 401 : (res.status >= 400 && res.status < 500) || res.json.error?.code === 'PM_UNAVAILABLE';
      if (!blocked) leaks.push(`${r.method} ${r.path} → ${res.status}`);
    }
    // 태스크 id로 들어오는 사람용 조회도 그 프로젝트 안이다 — 지운 프로젝트의 태스크는 404(에이전트 전용은 401).
    for (const r of (await projectRoutes(':taskId')).filter((x) => x.method === 'GET')) {
      const res = await http('GET', r.path.replace(':taskId', w.taskId).replace(/:[A-Za-z]+/g, randomUUID()), rep);
      if (res.status !== 404 && res.status !== 401) leaks.push(`GET ${r.path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('지운 프로젝트를 구독 중인 화면 스트림은 구독이 끊긴다 — 대표도', async () => {
    const w = await world();
    const rep = await w.rep.token();
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/stream`);
    const messages: Record<string, unknown>[] = [];
    ws.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data)) as Record<string, unknown>));
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));
    const waitFor = async (pred: (m: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 100; i++) {
        if (messages.some(pred)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`메시지를 받지 못했다: ${JSON.stringify(messages)}`);
    };
    try {
      ws.send(JSON.stringify({ type: 'auth', token: rep }));
      await waitFor((m) => m.type === 'ready');
      ws.send(JSON.stringify({ type: 'subscribe', projectId: w.projectId }));
      await waitFor((m) => m.type === 'subscribed');
      await http('DELETE', `/projects/${w.projectId}`, rep);
      await waitFor((m) => m.type === 'unsubscribed');
      expect(messages.find((m) => m.type === 'unsubscribed')).toMatchObject({ projectId: w.projectId, reason: 'PROJECT_NOT_FOUND' });
    } finally {
      ws.close();
    }
  });
});

describe('조직 해산 — DELETE /orgs/:orgId', () => {
  it('진행 중 프로젝트 중단·초대 취소·레포 해제·멤버 전원(대표 포함) 빼기를 한 번에 하고 ORG_DISSOLVED를 남긴다', async () => {
    const w = await world();
    await createInvite(w.orgId, w.rep.userId); // 대기 초대 하나
    const res = await http('DELETE', `/orgs/${w.orgId}`, await w.rep.token());
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ orgId: w.orgId, memberCount: 3, abortedProjectIds: [w.projectId] });

    expect((await pool.query(`SELECT dissolved_at FROM organizations WHERE id = $1`, [w.orgId])).rows[0].dissolved_at).not.toBeNull();
    // 행은 남는다 — 프로젝트는 중단만(지우지 않는다), 레포·초대는 표시만.
    expect((await pool.query(`SELECT status, deleted_at FROM projects WHERE id = $1`, [w.projectId])).rows[0]).toEqual({ status: 'aborted', deleted_at: null });
    expect(await count(`SELECT count(*)::int AS n FROM repos WHERE org_id = $1 AND disconnected_at IS NULL`, [w.orgId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM invites WHERE org_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [w.orgId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM users WHERE org_id = $1`, [w.orgId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM agents WHERE org_id = $1 OR (user_id = ANY($2) AND disconnected_at IS NULL)`, [w.orgId, [w.rep.userId, w.fe.userId, w.be.userId]])).toBe(0);

    expect(await eventsOf('ORG_DISSOLVED')).toEqual([
      { org_id: w.orgId, project_id: null, on_behalf_of: w.rep.userId, payload: { name: 'Acme', memberCount: 3, abortedProjectIds: [w.projectId] } },
    ]);
    const removed = await eventsOf('ORG_MEMBER_REMOVED');
    expect(removed.map((e) => e.payload.userId)).toEqual([w.fe.userId, w.be.userId, w.rep.userId]); // 대표가 마지막
    expect(removed.every((e) => e.payload.cause === 'org_dissolved')).toBe(true);
    // GitHub 접근은 회수하지 않는다.
    expect(await eventsOf('GITHUB_COLLABORATORS_REMOVED')).toEqual([]);
  });

  it('해산 뒤: 그 조직 API는 404, 초대 링크는 수락 불가, 전 대표는 새 조직을 만들고 전 멤버는 다른 조직 초대를 수락한다', async () => {
    const w = await world();
    const { token: oldInvite } = await createInvite(w.orgId, w.rep.userId);
    await http('DELETE', `/orgs/${w.orgId}`, await w.rep.token());

    const rep = await w.rep.token();
    for (const path of [`/orgs/${w.orgId}/members`, `/orgs/${w.orgId}/projects`, `/orgs/${w.orgId}/repos`, `/orgs/${w.orgId}/invites`]) {
      const r = await http('GET', path, rep);
      expect([path, r.status, r.json.error?.code]).toEqual([path, 404, 'ORG_NOT_FOUND']);
    }
    expect((await http('DELETE', `/orgs/${w.orgId}`, rep)).status).toBe(404);
    expect((await http('GET', `/projects/${w.projectId}`, rep)).status).toBe(403); // 조직 없음 — 남의 조직 프로젝트와 같다
    const accept = await http('POST', `/invites/${oldInvite}/accept`, await w.fe.token());
    expect(accept.status).toBe(404);
    expect(accept.json.error!.code).toBe('INVITE_NOT_FOUND');
    expect((await http('GET', '/me', rep)).json.data).toMatchObject({ orgId: null, orgRole: null });

    // 전 대표가 새 조직을 만들고, 전 멤버가 그 초대를 수락한다.
    const created = await http('POST', '/orgs', rep, { name: 'Acme 2' });
    expect(created.status).toBe(201);
    const newOrgId = created.json.data!.orgId as string;
    const { token } = await createInvite(newOrgId, w.rep.userId);
    expect((await http('POST', `/invites/${token}/accept`, await w.fe.token())).status).toBe(200);
    expect((await http('GET', '/me', await w.fe.token())).json.data).toMatchObject({ orgId: newOrgId, orgRole: 'MEMBER' });
  });

  it('진행 중 태스크를 잡은 에이전트가 있으면 409 ACTIVE_TASKS_HELD — 아무것도 바뀌지 않는다', async () => {
    const w = await world({ claim: true });
    const before = await count(`SELECT count(*)::int AS n FROM events`);
    const res = await http('DELETE', `/orgs/${w.orgId}`, await w.rep.token());
    expect(res.status).toBe(409);
    expect(res.json.error!.code).toBe('ACTIVE_TASKS_HELD');
    expect(res.json.error!.details).toEqual([expect.objectContaining({ taskId: w.taskId, state: 'CLAIMED', agentId: w.feAgentId })]);
    expect(await count(`SELECT count(*)::int AS n FROM events`)).toBe(before);
    expect((await pool.query(`SELECT dissolved_at FROM organizations WHERE id = $1`, [w.orgId])).rows[0].dissolved_at).toBeNull();
    expect((await pool.query(`SELECT status FROM projects WHERE id = $1`, [w.projectId])).rows[0].status).toBe('active');
    expect(await count(`SELECT count(*)::int AS n FROM users WHERE org_id = $1`, [w.orgId])).toBe(3);
  });

  it('대표가 아니면 403, 남의 조직이면 403, 없는 조직이면 404', async () => {
    const w = await world();
    expect((await http('DELETE', `/orgs/${w.orgId}`, await w.fe.token())).json.error!.code).toBe('NOT_REPRESENTATIVE');
    const other = await account('other');
    const { orgId: otherOrg } = await createOrganization(other.userId, 'Other');
    expect((await http('DELETE', `/orgs/${otherOrg}`, await w.rep.token())).json.error!.code).toBe('CROSS_ORG_ACCESS');
    const missing = await http('DELETE', `/orgs/${randomUUID()}`, await w.rep.token());
    expect([missing.status, missing.json.error!.code]).toEqual([404, 'ORG_NOT_FOUND']);
    expect(await eventsOf('ORG_DISSOLVED')).toEqual([]);
  });

  it('대표 단독 탈퇴는 여전히 409 REPRESENTATIVE_CANNOT_LEAVE — 떠나는 길은 해산뿐이다', async () => {
    const w = await world();
    const res = await http('DELETE', `/orgs/${w.orgId}/members/${w.rep.userId}`, await w.rep.token());
    expect([res.status, res.json.error!.code]).toEqual([409, 'REPRESENTATIVE_CANNOT_LEAVE']);
  });

  it('해산하면 화면 스트림이 대표까지 4403 NOT_IN_ORG로 끊긴다', async () => {
    const w = await world();
    const rep = await w.rep.token();
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/stream`);
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
    const ready = new Promise<void>((resolve) => ws.addEventListener('message', (e) => {
      if ((JSON.parse(String(e.data)) as { type: string }).type === 'ready') resolve();
    }));
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));
    ws.send(JSON.stringify({ type: 'auth', token: rep }));
    await ready;
    await http('DELETE', `/orgs/${w.orgId}`, rep);
    expect(await closed).toBe(4403);
  });
});
