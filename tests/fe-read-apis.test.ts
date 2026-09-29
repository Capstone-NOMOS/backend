import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { connectAgent } from '../src/domain/agent/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { assignMember, createProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { assignRootOwner } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 프론트가 로그인 직후·배정 화면·대시보드 진입에서 읽는 목록 API.
// 이것들이 없으면 프론트는 orgId·agentId·projectId를 알 방법이 없다.

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

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

type Account = { userId: string; token: string; connectKey: string };

async function account(loginId: string): Promise<Account> {
  const { userId, connectKey } = await signup({ loginId, password: 'correct-horse-battery', nickname: loginId });
  const { accessToken } = await login({ loginId, password: 'correct-horse-battery' });
  return { userId, token: accessToken, connectKey };
}

async function get(path: string, token: string): Promise<{ status: number; body: { data?: never; error?: { code: string } } }> {
  const res = await fetch(`${baseUrl}/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as never };
}

// 대표·팀원 둘, 각자 CLI 연결, 레포 하나(소유권 지정), 프로젝트 하나에 BE만 배정.
async function world() {
  const rep = await account('rep');
  const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
  const fe = await account('fe-dev');
  const be = await account('be-dev');
  for (const m of [fe, be]) {
    const { token } = await createInvite(orgId, rep.userId);
    await acceptInvite(token, m.userId);
  }
  const conn = (a: Account, agentName: string) =>
    connectAgent({ connectKey: a.connectKey, agentName, harness: 'claude-code@test', skills: [], maxConcurrent: 1 });
  const feAgent = await conn(fe, 'fe-laptop');
  const beAgent = await conn(be, 'be-laptop');

  const [repo] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/study-api' }] });
  const [bare] = await connectRepos({ orgId, actorUserId: be.userId, repos: [{ fullName: 'acme/study-web' }] });
  await assignRootOwner(orgId, rep.userId, repo!.id, 'BACKEND');

  const actor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' };
  const { project } = await createProject(orgId, rep.userId, {
    name: '스터디 v1',
    autonomyPreset: 'L2',
    pmBudgetUsd: 10,
    repoIds: [repo!.id],
  });
  await assignMember(actor, project.id, beAgent.agentId, 'BACKEND');

  return { rep, fe, be, orgId, actor, projectId: project.id, feAgentId: feAgent.agentId, beAgentId: beAgent.agentId, repoId: repo!.id, bareRepoId: bare!.id };
}

describe('GET /api/me', () => {
  it('조직이 없으면 orgId·orgName·orgRole이 null이다 (users.org_role 기본값 MEMBER를 그대로 내지 않는다)', async () => {
    const solo = await account('solo');
    const res = await get('/me', solo.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      userId: solo.userId,
      loginId: 'solo',
      nickname: 'solo',
      githubLogin: null,
      orgId: null,
      orgName: null,
      orgRole: null,
    });
  });

  // 로그인 때 받은 토큰 그대로. 조직·역할은 토큰이 아니라 DB에서 읽으므로 조직을 만든 직후에도 맞는 값이 나온다.
  it('같은 토큰으로 조직을 만든 뒤 다시 부르면 대표로 나온다', async () => {
    const rep = await account('rep');
    const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
    const res = await get('/me', rep.token);
    expect(res.body.data).toMatchObject({ orgId, orgName: 'Acme Inc.', orgRole: 'REPRESENTATIVE' });
  });
});

describe('GET /api/orgs/:orgId/agents', () => {
  it('조직의 에이전트와 진행 중 배정을 준다. 접속 상태(status)는 내지 않는다', async () => {
    const w = await world();
    const res = await get(`/orgs/${w.orgId}/agents`, w.fe.token);
    expect(res.status).toBe(200);
    const agents = (res.body.data as unknown as { agents: Record<string, unknown>[] }).agents;
    expect(agents).toHaveLength(2);
    const byName = Object.fromEntries(agents.map((a) => [a.agentName, a]));
    expect(byName['be-laptop']).toMatchObject({
      agentId: w.beAgentId,
      userId: w.be.userId,
      nickname: 'be-dev',
      assignment: { projectId: w.projectId, teamRole: 'BACKEND' },
    });
    expect(byName['fe-laptop']).toMatchObject({ agentId: w.feAgentId, assignment: null });
    expect(byName['fe-laptop']).not.toHaveProperty('status');
  });

  it('다른 조직은 볼 수 없다', async () => {
    const w = await world();
    const outsider = await account('outsider');
    await createOrganization(outsider.userId, 'Other');
    const res = await get(`/orgs/${w.orgId}/agents`, outsider.token);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/orgs/:orgId/projects', () => {
  it('대표는 조직의 모든 프로젝트를, 팀원은 자기 에이전트가 배정된 것만 본다', async () => {
    const w = await world();
    const ids = async (token: string) =>
      ((await get(`/orgs/${w.orgId}/projects`, token)).body.data as unknown as { projects: { id: string }[] }).projects.map(
        (p) => p.id,
      );
    expect(await ids(w.rep.token)).toEqual([w.projectId]);
    expect(await ids(w.be.token)).toEqual([w.projectId]);
    expect(await ids(w.fe.token)).toEqual([]);
  });
});

describe('GET /api/orgs/:orgId/repos', () => {
  it('연결된 레포와 소유 역할 지정 여부를 준다 — false인 레포는 프로젝트 생성에서 422가 난다', async () => {
    const w = await world();
    const res = await get(`/orgs/${w.orgId}/repos`, w.fe.token);
    expect(res.status).toBe(200);
    const repos = (res.body.data as unknown as { repos: { id: string; ownershipAssigned: boolean }[] }).repos;
    expect(repos.map((r) => [r.id, r.ownershipAssigned])).toEqual([
      [w.repoId, true],
      [w.bareRepoId, false],
    ]);

    await expect(
      createProject(w.orgId, w.rep.userId, { name: 'x', autonomyPreset: 'L2', pmBudgetUsd: 1, repoIds: [w.bareRepoId] }),
    ).rejects.toMatchObject({ code: 'REPO_OWNERSHIP_NOT_SET' });
  });
});

describe('GET /api/orgs/:orgId/members', () => {
  it('사용자 키는 다른 응답과 같은 userId이고 loginId를 함께 준다', async () => {
    const w = await world();
    const res = await get(`/orgs/${w.orgId}/members`, w.rep.token);
    const members = (res.body.data as unknown as { members: Record<string, unknown>[] }).members;
    expect(members[0]).toMatchObject({ userId: w.rep.userId, loginId: 'rep', orgRole: 'REPRESENTATIVE' });
    expect(members[0]).not.toHaveProperty('id');
  });
});

// 에이전트 토큰의 project_id는 하나다. 두 진행 중 프로젝트에 배정되면 먼저 배정된 쪽은 조용히 못 쓰게 된다.
describe('에이전트는 진행 중 프로젝트 하나만 맡는다', () => {
  it('다른 진행 중 프로젝트에 배정된 에이전트는 409 AGENT_IN_ANOTHER_PROJECT', async () => {
    const w = await world();
    const [repo2] = await connectRepos({ orgId: w.orgId, actorUserId: w.rep.userId, repos: [{ fullName: 'acme/other' }] });
    await assignRootOwner(w.orgId, w.rep.userId, repo2!.id, 'BACKEND');
    const { project: second } = await createProject(w.orgId, w.rep.userId, {
      name: '두 번째',
      autonomyPreset: 'L2',
      pmBudgetUsd: 10,
      repoIds: [repo2!.id],
    });

    await expect(assignMember(w.actor, second.id, w.beAgentId, 'BACKEND')).rejects.toMatchObject({
      code: 'AGENT_IN_ANOTHER_PROJECT',
    });
    // 끝난 프로젝트의 배정은 막지 않는다.
    await pool.query(`UPDATE projects SET status = 'completed' WHERE id = $1`, [w.projectId]);
    await expect(assignMember(w.actor, second.id, w.beAgentId, 'BACKEND')).resolves.toHaveLength(1);
  });
});

describe('초대 미리보기', () => {
  it('유효한 초대는 만료 시각을, 없는 토큰은 null을 준다', async () => {
    const rep = await account('rep');
    const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
    const { token, expiresAt } = await createInvite(orgId, rep.userId, { teamRole: 'FRONTEND' });

    const ok = await fetch(`${baseUrl}/api/invites/${token}`).then((r) => r.json());
    expect(ok.data).toEqual({ orgName: 'Acme Inc.', valid: true, teamRole: 'FRONTEND', expiresAt });

    const missing = await fetch(`${baseUrl}/api/invites/nope-${token}`).then((r) => r.json());
    expect(missing.data).toEqual({ orgName: '', valid: false, teamRole: null, expiresAt: null, reason: 'not_found' });
  });
});

describe('사람 토큰 수명', () => {
  it('24시간이다', async () => {
    await signup({ loginId: 'rep', password: 'correct-horse-battery', nickname: 'rep' });
    expect((await login({ loginId: 'rep', password: 'correct-horse-battery' })).expiresIn).toBe(24 * 60 * 60);
  });
});
