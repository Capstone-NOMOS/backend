import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { NomosClient } from '../src/bridge/nomos-client.js';
import { pool } from '../src/config/db.js';
import { markAgentDisconnected } from '../src/domain/agent/repository.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { createSpec, createTask } from '../src/domain/authoring/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { clearPolicyCache } from '../src/domain/policy/policy-cache.js';
import { assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { findOpenRun } from '../src/domain/room/repository.js';
import { closeOrphanedRuns } from '../src/domain/room/runs.js';
import { DISCONNECTED_EXIT_CODE } from '../src/executor/stop.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 에이전트 연결이 끊기면(연결 해제·조직 탈퇴·해산) 그 에이전트의 열린 실행을 서버가 닫는다(outcome disconnected).
// 닫지 않으면 Executor의 종료 보고가 막힌 토큰 때문에 401이라 룸에 "생각 중"이 영원히 남았다.

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
  clearPolicyCache();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

const PASSWORD = 'correct-horse-battery';

async function account(loginId: string) {
  const { userId, connectKey } = await signup({ loginId, password: PASSWORD, nickname: loginId });
  return { userId, connectKey, token: async () => (await login({ loginId, password: PASSWORD })).accessToken };
}

// 대표·FE·BE, 시작한 프로젝트, FE·BE 태스크 하나씩(READY — 아무도 잡지 않았다).
async function world() {
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
  const { project } = await createProject(orgId, rep.userId, { name: 'P', autonomyPreset: 'L2', pmBudgetUsd: 5, repoIds: [web!.id, api!.id] });
  const repActor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' as const };
  const feAgent = await connectAgent({ connectKey: fe.connectKey, agentName: 'fe-mbp', harness: 'test', skills: [], maxConcurrent: 1 });
  const beAgent = await connectAgent({ connectKey: be.connectKey, agentName: 'be-mbp', harness: 'test', skills: [], maxConcurrent: 1 });
  await assignMember(repActor, project.id, feAgent.agentId, 'FRONTEND');
  await assignMember(repActor, project.id, beAgent.agentId, 'BACKEND');
  const spec = await createSpec(rep.userId, project.id, { featureKey: 'F-1', title: '목록', content: '목록을 보여 준다.', tests: [] });
  const feTask = await createTask(rep.userId, project.id, { title: 'T-1 목록 화면', teamRole: 'FRONTEND', kind: 'IMPLEMENT', repoId: web!.id, specId: spec.id, dependsOn: [] });
  const beTask = await createTask(rep.userId, project.id, { title: 'T-2 목록 API', teamRole: 'BACKEND', kind: 'IMPLEMENT', repoId: api!.id, specId: spec.id, dependsOn: [] });
  await startProject(repActor, project.id);
  const client = async (refreshToken: string) =>
    new NomosClient({ baseUrl, tokens: { accessToken: (await refreshAgentToken(refreshToken)).accessToken, refreshToken } });
  return {
    orgId,
    projectId: project.id,
    feTaskId: feTask.id,
    beTaskId: beTask.id,
    rep,
    fe,
    be,
    fe_: { agentId: feAgent.agentId, client: await client(feAgent.refreshToken) },
    be_: { agentId: beAgent.agentId, client: await client(beAgent.refreshToken) },
  };
}

async function http(method: string, urlPath: string, token: string): Promise<{ status: number; json: { data?: Record<string, unknown>; error?: { code: string } } }> {
  const res = await fetch(`${baseUrl}/api${urlPath}`, { method, headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, json: (await res.json()) as { data?: Record<string, unknown> } };
}

type Ev = { id: string; type: string; actor_agent_id: string | null; on_behalf_of: string; payload: Record<string, unknown> };
const runEnded = async (): Promise<Ev[]> =>
  (await pool.query(`SELECT id::text AS id, type, actor_agent_id, on_behalf_of, payload FROM events WHERE type = 'AGENT_RUN_ENDED' ORDER BY id`)).rows;
const feedTexts = async (token: string, projectId: string, role: string): Promise<string[]> =>
  ((await http('GET', `/projects/${projectId}/rooms/${role}/feed?limit=200`, token)).json.data!.messages as { text: string }[]).map((m) => m.text);

describe('연결 해제가 열린 실행을 닫는다', () => {
  it('실행을 시작하고(태스크를 잡기 전) 연결을 해제하면 같은 트랜잭션에서 AGENT_RUN_ENDED(disconnected)가 남고 룸에 두 줄이 나온다', async () => {
    const w = await world();
    await w.fe_.client.startRun(w.feTaskId);

    expect((await http('DELETE', `/agents/${w.fe_.agentId}`, await w.fe.token())).status).toBe(200);

    const ended = await runEnded();
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      actor_agent_id: w.fe_.agentId,
      on_behalf_of: w.fe.userId,
      payload: { taskId: w.feTaskId, attempt: 0, outcome: 'disconnected', committed: false, submitted: false, exitCode: null, taskState: 'READY' },
    });
    expect(typeof ended[0]!.payload.durationMs).toBe('number');
    // 같은 트랜잭션: 에이전트를 뗀 줄(MEMBER_AGENT_DETACHED)과 해제(AGENT_DISCONNECTED) 사이에 남는다.
    const order = (await pool.query(`SELECT type FROM events WHERE type IN ('MEMBER_AGENT_DETACHED', 'AGENT_RUN_ENDED', 'AGENT_DISCONNECTED') ORDER BY id`)).rows.map((r) => r.type);
    expect(order).toEqual(['MEMBER_AGENT_DETACHED', 'AGENT_RUN_ENDED', 'AGENT_DISCONNECTED']);
    expect(await findOpenRun(pool, w.feTaskId, w.fe_.agentId)).toBeNull();
    // 태스크는 잡혀 있지 않았으니 멈춤(BLOCKED)으로 바꾸지 않는다.
    expect((await pool.query(`SELECT state FROM tasks WHERE id = $1`, [w.feTaskId])).rows[0].state).toBe('READY');
    expect((await pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'TASK_BLOCKED'`)).rows[0].n).toBe(0);

    const texts = await feedTexts(await w.rep.token(), w.projectId, 'FRONTEND');
    expect(texts.some((t) => /^에이전트 연결이 해제되어 실행을 멈췄습니다 \(\d+초\)$/.test(t))).toBe(true);
    expect(texts).toContain('에이전트 fe-mbp의 연결이 해제됐습니다 — 다시 연결하면 이 역할을 이어 받습니다');
    // 다른 역할 룸에는 나오지 않는다.
    expect(await feedTexts(await w.rep.token(), w.projectId, 'BACKEND')).not.toContain('에이전트 fe-mbp의 연결이 해제됐습니다 — 다시 연결하면 이 역할을 이어 받습니다');
  });

  it('다시 연결하면(reattach) 그 역할 룸에 재연결 줄이 나온다', async () => {
    const w = await world();
    await http('DELETE', `/agents/${w.fe_.agentId}`, await w.fe.token());
    await connectAgent({ connectKey: w.fe.connectKey, agentName: 'fe-mbp', harness: 'test', skills: [], maxConcurrent: 1 });
    expect(await feedTexts(await w.rep.token(), w.projectId, 'FRONTEND')).toContain('에이전트 fe-mbp이(가) 다시 연결됐습니다');
    const attached = (await pool.query(`SELECT payload FROM events WHERE type = 'MEMBER_AGENT_ATTACHED'`)).rows[0].payload;
    expect(attached).toMatchObject({ agentName: 'fe-mbp', cause: 'reconnected' });
  });

  it('이미 닫힌 실행과 다른 에이전트의 실행은 건드리지 않는다', async () => {
    const w = await world();
    await w.fe_.client.startRun(w.feTaskId);
    await w.fe_.client.endRun(w.feTaskId, { outcome: 'failed', committed: false, durationMs: 1000, exitCode: 1 });
    await w.be_.client.startRun(w.beTaskId);

    await http('DELETE', `/agents/${w.fe_.agentId}`, await w.fe.token());

    const ended = await runEnded();
    expect(ended.map((e) => e.payload.outcome)).toEqual(['failed']); // FE가 직접 끝낸 것 하나뿐
    expect(await findOpenRun(pool, w.beTaskId, w.be_.agentId)).not.toBeNull();
  });

  it('조직에서 내보내거나 조직을 해산해도 열린 실행이 닫힌다', async () => {
    const w = await world();
    await w.fe_.client.startRun(w.feTaskId);
    await w.be_.client.startRun(w.beTaskId);

    // 내보내기 — 명의는 내보낸 대표
    expect((await http('DELETE', `/orgs/${w.orgId}/members/${w.fe.userId}`, await w.rep.token())).status).toBe(200);
    let ended = await runEnded();
    expect(ended.map((e) => [e.actor_agent_id, e.on_behalf_of, e.payload.outcome])).toEqual([[w.fe_.agentId, w.rep.userId, 'disconnected']]);

    // 해산 — BE 에이전트의 열린 실행도 닫힌다
    expect((await http('DELETE', `/orgs/${w.orgId}`, await w.rep.token())).status).toBe(200);
    ended = await runEnded();
    expect(ended.map((e) => [e.actor_agent_id, e.payload.outcome])).toEqual([
      [w.fe_.agentId, 'disconnected'],
      [w.be_.agentId, 'disconnected'],
    ]);
  });
});

describe('서버 시작 때 고아 실행 정리 — closeOrphanedRuns', () => {
  it('연결 해제된 에이전트의 열린 실행을 주인 명의로 닫고, 두 번 불러도 한 건이다', async () => {
    const w = await world();
    await w.fe_.client.startRun(w.feTaskId);
    await w.be_.client.startRun(w.beTaskId);
    // 이 수정 전에 해제된 상태를 만든다 — 서비스(disconnectAgent)는 이제 실행을 함께 닫으므로, 옛 동작을 재현하려고 표시만 직접 찍는다.
    await markAgentDisconnected(pool, w.fe_.agentId);

    expect(await closeOrphanedRuns()).toBe(1);
    expect(await closeOrphanedRuns()).toBe(0);

    const ended = await runEnded();
    expect(ended.map((e) => [e.actor_agent_id, e.on_behalf_of, e.payload.outcome])).toEqual([[w.fe_.agentId, w.fe.userId, 'disconnected']]);
    // 연결된 에이전트(BE)의 실행은 그대로 열려 있다.
    expect(await findOpenRun(pool, w.beTaskId, w.be_.agentId)).not.toBeNull();
  });
});

describe('CLI — 연결이 해제되면 connect 루프가 0이 아닌 코드로 끝난다', () => {
  it('nomos start가 돌던 중 웹에서 연결을 해제하면 사유를 남기고 종료 코드 3으로 끝난다', async () => {
    const w = await world();
    const home = mkdtempSync(path.join(tmpdir(), 'nomos-cli-home-'));
    try {
      // 이 에이전트(FE)의 자격 증명을 NOMOS_HOME에 둔다 — connect가 로그인 뒤 저장하는 것과 같은 파일이다.
      const tokens = (w.fe_.client as unknown as { current: { accessToken: string; refreshToken: string } }).current;
      writeFileSync(path.join(home, 'credentials'), JSON.stringify({ baseUrl, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, agentId: w.fe_.agentId }));
      const child = spawn(path.resolve('node_modules/.bin/tsx'), ['src/executor/cli.ts', 'start'], {
        env: { ...process.env, NOMOS_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (out += String(d)));
      const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
      // 시작했다는 줄을 본 뒤 해제한다.
      for (let i = 0; i < 200 && !out.includes('시작 —'); i++) await new Promise((r) => setTimeout(r, 100));
      expect(out).toContain('시작 —');
      expect((await http('DELETE', `/agents/${w.fe_.agentId}`, await w.fe.token())).status).toBe(200);

      const code = await exited;
      expect(code).toBe(DISCONNECTED_EXIT_CODE);
      expect(out).toContain('이 에이전트의 연결이 해제돼 실행 중인 작업을 멈췄다 — 다시 쓰려면 connect를 실행하라');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
