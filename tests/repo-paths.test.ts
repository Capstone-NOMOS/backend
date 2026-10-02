import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { resolveRule } from '../src/domain/repo/glob.js';
import { addRepoPath, connectRepos, getRepoPaths, updatePathOwnership } from '../src/domain/repo/service.js';
import { createTestOrg } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

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
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
  await testPool.end();
});

async function setupOrgWithRepo(n: number) {
  const { orgId, userId } = await createTestOrg(`rep-${n}`);
  const [repo] = await connectRepos({ orgId, actorUserId: userId, repos: [{ fullName: `acme/repo-${n}` }] });
  return { orgId, userId, repoId: repo!.id };
}

describe('repo path seeding', () => {
  it('레포 연결 시 기본 경로 규칙 15개가 생성되고 priority가 겹치지 않는다', async () => {
    const { orgId, repoId } = await setupOrgWithRepo(2001);
    const paths = await getRepoPaths(orgId, repoId);
    expect(paths).toHaveLength(15);
    expect(new Set(paths.map((p) => p.priority)).size).toBe(15);
  });

  it('경로마다 정책표의 행동 키로 판정된다', async () => {
    const { orgId, repoId } = await setupOrgWithRepo(2007);
    const paths = await getRepoPaths(orgId, repoId);
    const judge = (file: string) => {
      const rule = resolveRule(paths, file);
      return { pattern: rule?.pathPattern, access: rule?.access, actionKey: rule?.actionKey };
    };

    expect(judge('apps/api/.env')).toEqual({ pattern: '**/.env*', access: 'denied', actionKey: 'secret:touch' });
    expect(judge('.env.example')).toEqual({ pattern: '**/.env.example', access: 'write', actionKey: null });
    expect(judge('config/secrets/a')).toMatchObject({ access: 'denied', actionKey: 'secret:touch' });
    expect(judge('certs/server.pem')).toMatchObject({ access: 'denied', actionKey: 'secret:touch' });
    expect(judge('src/secretary.ts')).toEqual({ pattern: '**', access: 'write', actionKey: null });
    expect(judge('package-lock.json')).toEqual({ pattern: '**', access: 'write', actionKey: null });
    expect(judge('db/schema.sql')).toMatchObject({ actionKey: 'db:migration' });
    expect(judge('tests/auth.test.ts')).toMatchObject({ actionKey: 'test:write' });
    expect(judge('requirements.txt')).toMatchObject({ actionKey: 'dep:add' });
    expect(judge('contracts/user.yaml')).toMatchObject({ access: 'read', actionKey: 'contract:change' });
  });

  it("시드 행의 source가 'seed'다", async () => {
    const { orgId, repoId } = await setupOrgWithRepo(2002);
    const paths = await getRepoPaths(orgId, repoId);
    expect(paths.every((p) => p.source === 'seed')).toBe(true);
  });

  it('조직 상한(900+) 행은 어떤 필드도 바꿀 수 없다', async () => {
    const { orgId, userId, repoId } = await setupOrgWithRepo(2003);
    const paths = await getRepoPaths(orgId, repoId);
    const env = paths.find((p) => p.pathPattern === '**/.env*')!;
    const example = paths.find((p) => p.pathPattern === '**/.env.example')!;

    const expected = { code: 'IMMUTABLE_ORG_CEILING', status: 409 };
    await expect(updatePathOwnership(orgId, userId, repoId, env.id, { access: 'write' })).rejects.toMatchObject(expected);
    await expect(
      updatePathOwnership(orgId, userId, repoId, example.id, { ownerRole: 'BACKEND' }),
    ).rejects.toMatchObject(expected);
  });

  it('actionKey 수정 시도가 무시된다', async () => {
    const { orgId, userId, repoId } = await setupOrgWithRepo(2004);
    const paths = await getRepoPaths(orgId, repoId);
    const reqPath = paths.find((p) => p.pathPattern === 'requirements.txt');
    expect(reqPath?.actionKey).toBe('dep:add');

    // updatePathOwnership의 입력 타입에는 actionKey가 아예 없다. 라우트/서비스 어느 쪽으로도
    // actionKey를 바꿀 방법이 없다는 것을 증명하기 위해 타입을 우회해 시도한다.
    const updated = await updatePathOwnership(orgId, userId, repoId, reqPath!.id, {
      ownerRole: 'BACKEND',
      actionKey: 'db:migration',
    } as unknown as { ownerRole: 'BACKEND' });

    expect(updated.actionKey).toBe('dep:add');
    expect(updated.ownerRole).toBe('BACKEND');
  });

  it('다른 조직의 repoId 접근이 403이다', async () => {
    const { repoId } = await setupOrgWithRepo(2005);
    const { orgId: otherOrgId } = await createTestOrg('other-rep', 'Other Org');

    await expect(getRepoPaths(otherOrgId, repoId)).rejects.toMatchObject({
      code: 'CROSS_ORG_ACCESS',
      status: 403,
    });
  });
});

describe('manual 경로 규칙의 priority', () => {
  it('지정하지 않으면 manual 대역(200~)에서 차례로 붙는다', async () => {
    const { orgId, userId, repoId } = await setupOrgWithRepo(3001);

    const first = await addRepoPath(orgId, userId, repoId, { pathPattern: 'api/**', access: 'write' });
    const second = await addRepoPath(orgId, userId, repoId, { pathPattern: 'web/**', access: 'write' });

    expect([first.priority, second.priority]).toEqual([200, 201]);
  });

  it('레포 안에서 priority가 겹치면 409다', async () => {
    const { orgId, userId, repoId } = await setupOrgWithRepo(3002);
    await addRepoPath(orgId, userId, repoId, { pathPattern: 'api/**', access: 'write', priority: 250 });

    await expect(
      addRepoPath(orgId, userId, repoId, { pathPattern: 'web/**', access: 'write', priority: 250 }),
    ).rejects.toMatchObject({ code: 'PATH_PRIORITY_TAKEN', status: 409 });
  });

  it('manual 대역 밖의 priority는 DB가 거부한다', async () => {
    const { orgId, userId, repoId } = await setupOrgWithRepo(3003);

    await expect(
      addRepoPath(orgId, userId, repoId, { pathPattern: 'api/**', access: 'write', priority: 950 }),
    ).rejects.toThrow(/repo_paths_priority_band_chk/);
  });
});

// 레포 연결은 조직 멤버 누구나 할 수 있고, 소유권 지정은 대표만 할 수 있다.
// 이 두 줄이 같이 있어야 "연결을 열었다"가 "권한을 열었다"로 번지지 않는다 —
// repos 행은 권한을 만들지 않고, 판정은 project_repos에 들어온 레포만 본다.
describe('레포 연결 권한 (HTTP)', () => {
  async function account(loginId: string): Promise<{ userId: string; token: string }> {
    const { userId } = await signup({ loginId, password: 'correct-horse-battery', nickname: loginId });
    const { accessToken } = await login({ loginId, password: 'correct-horse-battery' });
    return { userId, token: accessToken };
  }

  async function send(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, never> }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, never> };
  }

  it('초대로 들어온 팀원도 레포를 연결하고 목록을 볼 수 있다', async () => {
    const rep = await account('rep-4001');
    const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
    const member = await account('fe-4001');
    const invite = await createInvite(orgId, rep.userId, { teamRole: 'FRONTEND' });
    await acceptInvite(invite.token, member.userId);

    const connected = await send('POST', `/api/orgs/${orgId}/repos`, member.token, {
      repos: [{ fullName: 'acme/study-web' }],
    });
    expect(connected.status).toBe(201);

    // 드롭다운을 채우는 목록도 함께 열려 있어야 연결 화면이 성립한다.
    // GITHUB_TOKEN이 없는 테스트 환경에서는 빈 배열이 정상이다(500이 아니다).
    const listed = await send('GET', `/api/orgs/${orgId}/github/repos`, member.token);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ data: { repos: [] } });
  });

  it('팀원은 연결은 되지만 소유권 지정은 403이다 — 실제 관문은 대표에게 남는다', async () => {
    const rep = await account('rep-4002');
    const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
    const member = await account('fe-4002');
    const invite = await createInvite(orgId, rep.userId, { teamRole: 'FRONTEND' });
    await acceptInvite(invite.token, member.userId);

    const connected = await send('POST', `/api/orgs/${orgId}/repos`, member.token, {
      repos: [{ fullName: 'acme/study-web-2' }],
    });
    const repoId = (connected.body as unknown as { data: { repos: { id: string }[] } }).data.repos[0]!.id;

    const paths = await send('GET', `/api/repos/${repoId}/paths`, member.token);
    expect(paths.status).toBe(200);
    const pathId = (paths.body as unknown as { data: { paths: { id: string; pathPattern: string }[] } }).data.paths.find(
      (p) => p.pathPattern === '**',
    )!.id;

    const denied = await send('PATCH', `/api/repos/${repoId}/paths/${pathId}`, member.token, {
      ownerRole: 'FRONTEND',
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { code: 'NOT_REPRESENTATIVE' } });

    // 규칙 추가도 대표만.
    const deniedAdd = await send('POST', `/api/repos/${repoId}/paths`, member.token, {
      pathPattern: 'src/**',
      access: 'write',
    });
    expect(deniedAdd.status).toBe(403);
  });

  it('다른 조직의 :orgId로는 연결할 수 없다', async () => {
    const rep = await account('rep-4003');
    const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
    const outsider = await account('outsider-4003');
    await createOrganization(outsider.userId, 'Other Inc.');

    const res = await send('POST', `/api/orgs/${orgId}/repos`, outsider.token, {
      repos: [{ fullName: 'acme/sneaky' }],
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'CROSS_ORG_ACCESS' } });
  });

  it('대표는 연결과 함께 소유 역할을 지정할 수 있다 — PATCH와 같은 이벤트·결과', async () => {
    const rep = await account('rep-4004');
    const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');

    const res = await send('POST', `/api/orgs/${orgId}/repos`, rep.token, {
      repos: [{ fullName: 'acme/api', ownerRole: 'BACKEND' }, { fullName: 'acme/docs' }],
    });
    expect(res.status).toBe(201);
    const repos = (res.body as { data: { repos: { id: string; rootOwnerRole: string | null }[] } }).data.repos;
    expect(repos.map((r) => r.rootOwnerRole)).toEqual(['BACKEND', null]);

    const root = await pool.query(`SELECT owner_role FROM repo_paths WHERE repo_id = $1 AND path_pattern = '**'`, [repos[0]!.id]);
    expect(root.rows[0]!.owner_role).toBe('BACKEND');
    const events = await pool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'REPO_PATH_UPDATED'`);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.on_behalf_of).toBe(rep.userId);
    expect(events.rows[0]!.payload).toMatchObject({ before: { ownerRole: null }, after: { ownerRole: 'BACKEND' } });

    // 소유 역할이 있으니 바로 프로젝트에 넣을 수 있다(REPO_OWNERSHIP_NOT_SET이 아니다).
    const project = await send('POST', `/api/orgs/${orgId}/projects`, rep.token, {
      name: 'p', autonomyPreset: 'L2', pmBudgetUsd: 1, repoIds: [repos[0]!.id],
    });
    expect(project.status).toBe(201);
  });

  it('팀원이 ownerRole을 주면 403이고 아무것도 연결되지 않는다 — 소유권 지정은 대표 전용이다', async () => {
    const rep = await account('rep-4005');
    const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
    const member = await account('be-4005');
    const invite = await createInvite(orgId, rep.userId, { teamRole: 'BACKEND' });
    await acceptInvite(invite.token, member.userId);

    const res = await send('POST', `/api/orgs/${orgId}/repos`, member.token, {
      repos: [{ fullName: 'acme/web' }, { fullName: 'acme/api', ownerRole: 'BACKEND' }],
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'NOT_REPRESENTATIVE' } });
    expect((await pool.query(`SELECT count(*)::int AS n FROM repos WHERE org_id = $1`, [orgId])).rows[0].n).toBe(0);
  });
});
