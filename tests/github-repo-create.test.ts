import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { connectAgent } from '../src/domain/agent/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { createGithubRepApi, EMPTY_TREE_SHA, setGithubRepApi, type GithubRepApi } from '../src/domain/github/rep-api.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import type { GithubDeviceApi } from '../src/domain/oauth/github-device.js';
import { completeGithubDeviceFlow } from '../src/domain/oauth/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { createProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { AppError } from '../src/errors.js';
import { assignRootOwner } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// GitHub 조직에 레포 만들기(대표) + 역할 배정 시 협업자 자동 초대. GitHub는 가짜(GithubRepApi)로 바꿔 끼운다.

let server: Server;
let baseUrl: string;
let restore: GithubRepApi;

type Call = { method: string; args: unknown[] };
let calls: Call[];
let fake: GithubRepApi;

function fakeApi(overrides: Partial<GithubRepApi> = {}): GithubRepApi {
  let nextId = 5000;
  return {
    async listOrgs(...args) {
      calls.push({ method: 'listOrgs', args });
      return ['acme-gh'];
    },
    async createOrgRepo(...args) {
      calls.push({ method: 'createOrgRepo', args });
      const [, input] = args;
      nextId += 1;
      return { fullName: `${input.org}/${input.name}`, githubRepoId: nextId, defaultBranch: 'main' };
    },
    async inviteCollaborator(...args) {
      calls.push({ method: 'inviteCollaborator', args });
      return 'invited';
    },
    async listRepos(...args) {
      calls.push({ method: 'listRepos', args });
      return [{ fullName: 'acme-gh/existing', githubRepoId: 4242, defaultBranch: 'develop' }];
    },
    async getRepo(...args) {
      calls.push({ method: 'getRepo', args });
      const [, fullName] = args;
      return fullName.toLowerCase() === 'acme-gh/existing' ? { fullName: 'acme-gh/existing', githubRepoId: 4242, defaultBranch: 'develop' } : null;
    },
    async isCollaborator(...args) {
      calls.push({ method: 'isCollaborator', args });
      return args[2] === 'octo-be';
    },
    ...overrides,
  };
}

beforeAll(async () => {
  await resetSchema();
  restore = setGithubRepApi(fakeApi());
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await truncateAll();
  calls = [];
  fake = fakeApi();
  setGithubRepApi(fake);
});

afterAll(async () => {
  setGithubRepApi(restore);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

async function http(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string } } };
}

async function account(loginId: string) {
  const { userId, connectKey } = await signup({ loginId, password: 'correct-horse-battery', nickname: loginId });
  const { accessToken } = await login({ loginId, password: 'correct-horse-battery' });
  return { userId, token: accessToken, connectKey };
}

// GitHub 연결은 서비스 함수(device flow 완료)를 그대로 탄다 — 가짜는 GitHub 응답만 흉내 낸다.
async function linkGithub(userId: string, githubId: number, githubLogin: string): Promise<void> {
  const api: GithubDeviceApi = {
    async requestDeviceCode() {
      throw new Error('unused');
    },
    async exchangeDeviceCode() {
      return { status: 'ok', accessToken: `gho_${githubLogin}`, scope: 'repo read:org' };
    },
    async fetchViewer() {
      return { githubId, githubLogin };
    },
  };
  await completeGithubDeviceFlow(userId, 'device-code', api);
}

async function world() {
  const rep = await account('rep');
  const { orgId } = await createOrganization(rep.userId, 'Acme');
  const be = await account('be-dev');
  const { token } = await createInvite(orgId, rep.userId);
  await acceptInvite(token, be.userId);
  const beAgent = await connectAgent({ connectKey: be.connectKey, agentName: 'be-laptop', harness: 'claude-code', skills: [], maxConcurrent: 1 });
  return { rep, be, orgId, beAgentId: beAgent.agentId };
}

describe('GitHub 조직에 레포 만들기', () => {
  it('대표가 GitHub를 연결했으면 만들고 바로 연결한다 — 소유 역할·github_repo_id·clone_url까지 채워져 프로젝트에 넣을 수 있다', async () => {
    const w = await world();
    await linkGithub(w.rep.userId, 1, 'octo-rep');

    const orgs = await http('GET', `/orgs/${w.orgId}/github/orgs`, w.rep.token);
    expect(orgs.body.data).toEqual({ orgs: ['acme-gh'] });

    const res = await http('POST', `/orgs/${w.orgId}/github/repos`, w.rep.token, { githubOrg: 'acme-gh', name: 'shop-api', ownerRole: 'BACKEND' });
    expect(res.status).toBe(201);
    const repo = res.body.data!.repo as { id: string; fullName: string; rootOwnerRole: string; githubRepoId: number; cloneUrl: string; defaultBranch: string };
    expect(repo).toMatchObject({ fullName: 'acme-gh/shop-api', rootOwnerRole: 'BACKEND', defaultBranch: 'main', cloneUrl: 'https://github.com/acme-gh/shop-api' });

    // 대표 본인의 토큰으로 불렀다(복호화된 값).
    const create = calls.find((c) => c.method === 'createOrgRepo')!;
    expect(create.args).toEqual(['gho_octo-rep', { org: 'acme-gh', name: 'shop-api' }]);

    const { rows } = await testPool.query(`SELECT github_repo_id, clone_url FROM repos WHERE id = $1`, [repo.id]);
    expect(Number(rows[0].github_repo_id)).toBe(repo.githubRepoId);
    expect(rows[0].clone_url).toBe('https://github.com/acme-gh/shop-api');

    const events = await testPool.query(`SELECT type, payload FROM events WHERE type IN ('REPO_CONNECTED','REPO_PATH_UPDATED') ORDER BY ts`);
    expect(events.rows.map((r) => r.type)).toEqual(['REPO_CONNECTED', 'REPO_PATH_UPDATED']);
    expect(events.rows[0].payload).toMatchObject({ createdOnGithub: { githubOrg: 'acme-gh', githubRepoId: repo.githubRepoId } });

    // 소유 역할이 지정돼 있으므로 바로 프로젝트에 넣을 수 있다.
    await expect(
      createProject(w.orgId, w.rep.userId, { name: 'p', autonomyPreset: 'L2', pmBudgetUsd: 1, repoIds: [repo.id] }),
    ).resolves.toBeTruthy();
  });

  it('대표가 아니면 403 — GitHub를 부르지 않는다', async () => {
    const w = await world();
    const res = await http('POST', `/orgs/${w.orgId}/github/repos`, w.be.token, { githubOrg: 'acme-gh', name: 'x', ownerRole: 'BACKEND' });
    expect(res.status).toBe(403);
    expect((await http('GET', `/orgs/${w.orgId}/github/orgs`, w.be.token)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('대표가 GitHub를 연결하지 않았으면 409 GITHUB_NOT_LINKED', async () => {
    const w = await world();
    const res = await http('POST', `/orgs/${w.orgId}/github/repos`, w.rep.token, { githubOrg: 'acme-gh', name: 'x', ownerRole: 'BACKEND' });
    expect(res).toMatchObject({ status: 409, body: { error: { code: 'GITHUB_NOT_LINKED' } } });
    expect(calls).toEqual([]);
  });

  it('ownerRole은 필수이고, 이름 형식이 틀리면 GitHub를 부르기 전에 400', async () => {
    const w = await world();
    await linkGithub(w.rep.userId, 1, 'octo-rep');
    expect((await http('POST', `/orgs/${w.orgId}/github/repos`, w.rep.token, { githubOrg: 'acme-gh', name: 'x' })).status).toBe(400);
    expect((await http('POST', `/orgs/${w.orgId}/github/repos`, w.rep.token, { githubOrg: 'acme-gh', name: 'a/b', ownerRole: 'BACKEND' })).status).toBe(400);
    expect((await http('POST', `/orgs/${w.orgId}/github/repos`, w.rep.token, { githubOrg: '../x', name: 'a', ownerRole: 'BACKEND' })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('GitHub가 거부하면 그 오류가 그대로 가고 NOMOS에는 아무것도 남지 않는다', async () => {
    const w = await world();
    await linkGithub(w.rep.userId, 1, 'octo-rep');
    setGithubRepApi(
      fakeApi({
        async createOrgRepo() {
          throw new AppError('GITHUB_REPO_NAME_TAKEN', 'taken');
        },
      }),
    );
    const res = await http('POST', `/orgs/${w.orgId}/github/repos`, w.rep.token, { githubOrg: 'acme-gh', name: 'dup', ownerRole: 'BACKEND' });
    expect(res).toMatchObject({ status: 409, body: { error: { code: 'GITHUB_REPO_NAME_TAKEN' } } });
    expect((await testPool.query(`SELECT 1 FROM repos`)).rowCount).toBe(0);
  });
});

describe('역할 배정 시 GitHub 협업자 자동 초대', () => {
  async function projectWithGithubRepo(w: Awaited<ReturnType<typeof world>>) {
    await linkGithub(w.rep.userId, 1, 'octo-rep');
    const created = await http('POST', `/orgs/${w.orgId}/github/repos`, w.rep.token, { githubOrg: 'acme-gh', name: 'shop-api', ownerRole: 'BACKEND' });
    const repoId = (created.body.data!.repo as { id: string }).id;
    const project = await createProject(w.orgId, w.rep.userId, { name: 'p', autonomyPreset: 'L2', pmBudgetUsd: 1, repoIds: [repoId] });
    calls = [];
    return { repoId, projectId: project.project.id };
  }

  it('멤버가 GitHub를 연결했으면 대표 토큰으로 push 협업자 초대를 보내고 결과를 이벤트로 남긴다', async () => {
    const w = await world();
    await linkGithub(w.be.userId, 2, 'octo-be');
    const { repoId, projectId } = await projectWithGithubRepo(w);

    const res = await http('POST', `/projects/${projectId}/members`, w.rep.token, { agentId: w.beAgentId, teamRole: 'BACKEND' });
    expect(res.status).toBe(201);
    expect(res.body.data!.githubInvites).toEqual([{ repoId, fullName: 'acme-gh/shop-api', status: 'invited' }]);
    expect(calls).toEqual([{ method: 'inviteCollaborator', args: ['gho_octo-rep', 'acme-gh/shop-api', 'octo-be'] }]);

    const { rows } = await testPool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'GITHUB_COLLABORATORS_INVITED'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].on_behalf_of).toBe(w.rep.userId);
    expect(rows[0].payload).toMatchObject({ agentId: w.beAgentId, githubLogin: 'octo-be', trigger: 'assign' });
    expect(JSON.stringify(rows[0].payload)).not.toContain('gho_');
  });

  it('멤버가 GitHub를 연결하지 않았으면 skipped — 배정은 그대로이고, 연결한 뒤 재초대하면 간다', async () => {
    const w = await world();
    const { projectId } = await projectWithGithubRepo(w);

    const res = await http('POST', `/projects/${projectId}/members`, w.rep.token, { agentId: w.beAgentId, teamRole: 'BACKEND' });
    expect(res.status).toBe(201);
    expect(res.body.data!.githubInvites).toEqual([expect.objectContaining({ status: 'skipped' })]);
    expect(calls).toEqual([]);
    const before = await http('GET', `/projects/${projectId}`, w.rep.token);
    expect((before.body.data!.members as { githubInvites: { status: string; reason?: string }[] }[])[0]!.githubInvites).toEqual([
      expect.objectContaining({ status: 'skipped', reason: expect.stringContaining('GitHub를 연결하지') }),
    ]);

    await linkGithub(w.be.userId, 2, 'octo-be');
    const retry = await http('POST', `/projects/${projectId}/members/${w.beAgentId}/github-invite`, w.rep.token);
    expect(retry.status).toBe(200);
    expect(retry.body.data!.githubInvites).toEqual([expect.objectContaining({ status: 'invited' })]);
    const triggers = await testPool.query(`SELECT payload->>'trigger' AS t FROM events WHERE type = 'GITHUB_COLLABORATORS_INVITED' ORDER BY ts`);
    expect(triggers.rows.map((r) => r.t)).toEqual(['assign', 'retry']);

    // 새로고침해도 남는다 — 프로젝트 조회의 멤버 정보에 레포별 마지막 결과(재초대 뒤라 invited).
    const detail = await http('GET', `/projects/${projectId}`, w.rep.token);
    const member = (detail.body.data!.members as { agentId: string; githubInvites: { status: string; fullName: string; at: string }[] }[])[0]!;
    expect(member.agentId).toBe(w.beAgentId);
    expect(member.githubInvites).toEqual([{ repoId: expect.any(String), fullName: 'acme-gh/shop-api', status: 'invited', at: expect.any(String) }]);
  });

  it('GitHub가 실패해도 배정은 유효하고 실패 사유가 결과에 남는다', async () => {
    const w = await world();
    await linkGithub(w.be.userId, 2, 'octo-be');
    const { projectId } = await projectWithGithubRepo(w);
    setGithubRepApi(
      fakeApi({
        async inviteCollaborator() {
          throw new AppError('GITHUB_FORBIDDEN', '협업자 초대: GitHub가 거부했습니다(403)');
        },
      }),
    );

    const res = await http('POST', `/projects/${projectId}/members`, w.rep.token, { agentId: w.beAgentId, teamRole: 'BACKEND' });
    expect(res.status).toBe(201);
    expect(res.body.data!.members).toHaveLength(1);
    expect(res.body.data!.githubInvites).toEqual([expect.objectContaining({ status: 'failed', reason: expect.stringContaining('403') })]);
  });

  it('GitHub 레포가 없는 프로젝트(로컬 데모)는 초대하지 않고 이벤트도 남기지 않는다', async () => {
    const w = await world();
    await linkGithub(w.be.userId, 2, 'octo-be');
    const [local] = await connectRepos({ orgId: w.orgId, actorUserId: w.rep.userId, repos: [{ fullName: 'acme/local' }] });
    await assignRootOwner(w.orgId, w.rep.userId, local!.id, 'BACKEND');
    const project = await createProject(w.orgId, w.rep.userId, { name: 'p', autonomyPreset: 'L2', pmBudgetUsd: 1, repoIds: [local!.id] });

    const res = await http('POST', `/projects/${project.project.id}/members`, w.rep.token, { agentId: w.beAgentId, teamRole: 'BACKEND' });
    expect(res.body.data!.githubInvites).toEqual([]);
    expect(calls).toEqual([]);
    expect((await testPool.query(`SELECT 1 FROM events WHERE type = 'GITHUB_COLLABORATORS_INVITED'`)).rowCount).toBe(0);
  });

  it('재초대는 그 프로젝트 멤버에게만 — 아니면 404', async () => {
    const w = await world();
    const { projectId } = await projectWithGithubRepo(w);
    const res = await http('POST', `/projects/${projectId}/members/${w.beAgentId}/github-invite`, w.rep.token);
    expect(res).toMatchObject({ status: 404, body: { error: { code: 'MEMBER_NOT_FOUND' } } });
  });
});

describe('GitHub 호출 모양 (rep-api)', () => {
  type Req = { url: string; method: string; body: unknown; auth: string | null };

  function recorder(responses: Array<[number, unknown]>) {
    const reqs: Req[] = [];
    let i = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      reqs.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get('authorization') });
      const [status, body] = responses[Math.min(i++, responses.length - 1)]!;
      return new Response(status === 204 ? null : JSON.stringify(body), { status });
    };
    return { reqs, api: createGithubRepApi({ fetchImpl, apiBase: 'https://gh.test' }) };
  }

  it('비공개로 만들고(auto_init), 빈 트리 커밋으로 기본 브랜치를 덮어 README를 남기지 않는다', async () => {
    const { reqs, api } = recorder([
      [201, { id: 77, full_name: 'acme-gh/shop', default_branch: 'main' }],
      [201, { sha: 'c0ffee' }],
      [200, { ref: 'refs/heads/main' }],
    ]);
    await expect(api.createOrgRepo('tok', { org: 'acme-gh', name: 'shop' })).resolves.toEqual({ fullName: 'acme-gh/shop', githubRepoId: 77, defaultBranch: 'main' });
    expect(reqs.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST https://gh.test/orgs/acme-gh/repos',
      'POST https://gh.test/repos/acme-gh/shop/git/commits',
      'PATCH https://gh.test/repos/acme-gh/shop/git/refs/heads/main',
    ]);
    expect(reqs[0]!.body).toEqual({ name: 'shop', private: true, auto_init: true });
    expect(reqs[1]!.body).toEqual({ message: 'Chore: 레포 초기화', tree: EMPTY_TREE_SHA, parents: [] });
    expect(reqs[2]!.body).toEqual({ sha: 'c0ffee', force: true });
    expect(reqs.every((r) => r.auth === 'Bearer tok')).toBe(true);
  });

  it('이름이 이미 있으면(422) GITHUB_REPO_NAME_TAKEN, 권한이 없으면(403) GITHUB_FORBIDDEN — 메시지에 토큰이 없다', async () => {
    await expect(recorder([[422, { message: 'name already exists' }]]).api.createOrgRepo('secret-tok', { org: 'o', name: 'n' })).rejects.toMatchObject({ code: 'GITHUB_REPO_NAME_TAKEN' });
    const err = await recorder([[403, { message: 'Must have admin rights' }]]).api.createOrgRepo('secret-tok', { org: 'o', name: 'n' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'GITHUB_FORBIDDEN' });
    expect((err as Error).message).not.toContain('secret-tok');
  });

  it('협업자 초대: 201은 invited, 204는 already_collaborator, push 권한으로 보낸다', async () => {
    const invited = recorder([[201, {}]]);
    await expect(invited.api.inviteCollaborator('tok', 'acme-gh/shop', 'octo')).resolves.toBe('invited');
    expect(invited.reqs[0]).toMatchObject({ method: 'PUT', url: 'https://gh.test/repos/acme-gh/shop/collaborators/octo', body: { permission: 'push' } });
    await expect(recorder([[204, null]]).api.inviteCollaborator('tok', 'acme-gh/shop', 'octo')).resolves.toBe('already_collaborator');
  });
});

describe('GitHub 읽기는 그 조직 대표의 토큰으로 — 서버 공용 PAT를 쓰지 않는다', () => {
  it('연결 드롭다운: 대표가 GitHub를 연결했으면 대표 토큰으로 읽고, 안 했으면 빈 배열', async () => {
    const w = await world();
    expect((await http('GET', `/orgs/${w.orgId}/github/repos`, w.be.token)).body.data).toEqual({ repos: [] });
    expect(calls).toEqual([]);
    await linkGithub(w.rep.userId, 1, 'octo-rep');
    const listed = await http('GET', `/orgs/${w.orgId}/github/repos`, w.be.token);
    expect(listed.body.data).toEqual({ repos: [{ fullName: 'acme-gh/existing', githubRepoId: 4242, defaultBranch: 'develop' }] });
    expect(calls).toEqual([{ method: 'listRepos', args: ['gho_octo-rep'] }]);
  });

  it('직접 입력으로 연결해도 github_repo_id·기본 브랜치·clone_url이 채워지고 이름은 GitHub 정본으로 — 못 찾으면 예전처럼 빈 채로', async () => {
    const w = await world();
    await linkGithub(w.rep.userId, 1, 'octo-rep');
    const res = await http('POST', `/orgs/${w.orgId}/repos`, w.be.token, { repos: [{ fullName: 'ACME-GH/existing' }, { fullName: 'acme-gh/unknown' }] });
    expect(res.status).toBe(201);
    const { rows } = await testPool.query(`SELECT full_name, github_repo_id, default_branch, clone_url FROM repos ORDER BY full_name`);
    expect(rows.map((r) => ({ ...r, github_repo_id: r.github_repo_id === null ? null : Number(r.github_repo_id) }))).toEqual([
      { full_name: 'acme-gh/existing', github_repo_id: 4242, default_branch: 'develop', clone_url: 'https://github.com/acme-gh/existing' },
      { full_name: 'acme-gh/unknown', github_repo_id: null, default_branch: 'main', clone_url: null },
    ]);
  });

  it('멤버 목록의 협업자 표시도 대표 토큰으로 — 대표가 연결하지 않았으면 생략', async () => {
    const w = await world();
    await linkGithub(w.be.userId, 2, 'octo-be');
    await connectRepos({ orgId: w.orgId, actorUserId: w.rep.userId, repos: [{ fullName: 'acme-gh/existing', githubRepoId: 4242 }] });
    const before = (await http('GET', `/orgs/${w.orgId}/members`, w.rep.token)).body.data!.members as { githubLogin: string | null; isCollaborator?: boolean }[];
    expect(before.find((m) => m.githubLogin === 'octo-be')).not.toHaveProperty('isCollaborator');
    await linkGithub(w.rep.userId, 1, 'octo-rep');
    const after = (await http('GET', `/orgs/${w.orgId}/members`, w.rep.token)).body.data!.members as { githubLogin: string | null; isCollaborator?: boolean }[];
    expect(after.find((m) => m.githubLogin === 'octo-be')).toMatchObject({ isCollaborator: true });
    expect(after.find((m) => m.githubLogin === 'octo-rep')).toMatchObject({ isCollaborator: false });
  });
});
