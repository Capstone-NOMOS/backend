import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { login, signup } from '../src/domain/auth/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { computePolicyHash } from '../src/domain/policy/policy-hash.js';
import {
  assignMember,
  createProject,
  getProject,
  unassignMember,
  type Actor,
} from '../src/domain/project/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { connectRepos, getRepoPaths, listRepos, updatePathOwnership } from '../src/domain/repo/service.js';
import { AppError } from '../src/errors.js';
import { createTestAgent, createTestOrg, createTestUser } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

beforeAll(async () => {
  await resetSchema();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await pool.end();
  await testPool.end();
});

type Ctx = { userId: string; orgId: string; repoApi: string; repoWeb: string; actor: Actor };

// 온보딩의 실제 순서대로 '**' 행의 소유 역할을 지정한다. 지정하지 않은 레포는 프로젝트에 넣을 수 없다
// (REPO_OWNERSHIP_NOT_SET). 직접 UPDATE하지 않고 서비스 함수를 거친다 — policy_hash 재계산이 함께 돈다.
async function ownRepo(orgId: string, userId: string, repoId: string, role: 'BACKEND' | 'FRONTEND'): Promise<void> {
  const root = (await getRepoPaths(orgId, repoId)).find((p) => p.pathPattern === '**')!;
  await updatePathOwnership(orgId, userId, repoId, root.id, { ownerRole: role });
}

async function setup(loginId = 'rep'): Promise<Ctx> {
  const { userId, orgId } = await createTestOrg(loginId);
  const repos = await connectRepos({
    orgId,
    actorUserId: userId,
    repos: [{ fullName: 'acme/api' }, { fullName: 'acme/web' }],
  });
  await ownRepo(orgId, userId, repos[0]!.id, 'BACKEND');
  await ownRepo(orgId, userId, repos[1]!.id, 'FRONTEND');
  return {
    userId,
    orgId,
    repoApi: repos[0]!.id,
    repoWeb: repos[1]!.id,
    actor: { userId, orgId, orgRole: 'REPRESENTATIVE' },
  };
}

function input(ctx: Ctx, over: Record<string, unknown> = {}) {
  return {
    name: '스터디 관리 웹앱 v1',
    autonomyPreset: 'L2',
    pmBudgetUsd: 40,
    repoIds: [ctx.repoApi],
    ...over,
  };
}

describe('프로젝트 생성', () => {
  it('정책 17행·헌법 스냅샷·policy_hash가 한 트랜잭션에서 만들어진다', async () => {
    const ctx = await setup();
    await pool.query(`UPDATE organizations SET constitution = '{"stack":"ts"}'::jsonb WHERE id = $1`, [ctx.orgId]);

    const { project, repos, members } = await createProject(ctx.orgId, ctx.userId, input(ctx));

    expect(project).toMatchObject({ status: 'planning', autonomyPreset: 'L2', startedAt: null });
    expect(project.policyHash).toBe(await computePolicyHash(pool, project.id));
    expect(project.policyHash).not.toBe('pending');
    expect(repos.map((r) => r.fullName)).toEqual(['acme/api']);
    expect(members).toEqual([]);

    const policies = await pool.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE lock_key <> '-')::int AS locked
         FROM project_policies WHERE project_id = $1`,
      [project.id],
    );
    expect(policies.rows[0]).toEqual({ n: 17, locked: 5 });

    // 헌법은 이 시점 사본으로 고정된다 — org가 나중에 바뀌어도 판정 근거는 남아야 한다.
    const snapshot = await pool.query(`SELECT constitution, constitution_hash FROM projects WHERE id = $1`, [
      project.id,
    ]);
    expect(snapshot.rows[0]!.constitution).toEqual({ stack: 'ts' });
    expect(snapshot.rows[0]!.constitution_hash).toBe(project.constitutionHash);
  });

  it('레벨에 맞는 판정 열을 복사한다', async () => {
    const ctx = await setup();

    const { project } = await createProject(ctx.orgId, ctx.userId, input(ctx, { autonomyPreset: 'L4' }));

    const { rows } = await pool.query(
      `SELECT p.action_key FROM project_policies p JOIN action_catalog a USING (action_key)
        WHERE p.project_id = $1 AND p.mode <> a.mode_l4`,
      [project.id],
    );
    expect(rows).toEqual([]);
  });

  it('PROJECT_CREATED 이벤트를 남긴다', async () => {
    const ctx = await setup();

    const { project } = await createProject(ctx.orgId, ctx.userId, input(ctx));

    const { rows } = await pool.query(
      `SELECT project_id, on_behalf_of, policy_hash, payload FROM events WHERE type = 'PROJECT_CREATED'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project_id: project.id,
      on_behalf_of: ctx.userId,
      policy_hash: project.policyHash,
    });
    expect(rows[0]!.payload).toMatchObject({ autonomyPreset: 'L2', repoIds: [ctx.repoApi] });
  });

  it('허용 레벨 어휘를 벗어나면 422다', async () => {
    const ctx = await setup();

    await expect(createProject(ctx.orgId, ctx.userId, input(ctx, { autonomyPreset: 'L5' }))).rejects.toMatchObject({
      code: 'INVALID_AUTONOMY_PRESET',
      status: 422,
    });
    expect((await pool.query(`SELECT count(*)::int AS n FROM projects`)).rows[0]!.n).toBe(0);
  });

  it('없는 레포는 404, 남의 조직 레포는 403이다', async () => {
    const ctx = await setup();
    const other = await setup('rep2');

    await expect(
      createProject(ctx.orgId, ctx.userId, input(ctx, { repoIds: ['11111111-1111-1111-1111-111111111111'] })),
    ).rejects.toMatchObject({ code: 'REPO_NOT_FOUND', status: 404 });

    await expect(
      createProject(ctx.orgId, ctx.userId, input(ctx, { repoIds: [other.repoApi] })),
    ).rejects.toMatchObject({ code: 'CROSS_ORG_ACCESS', status: 403 });
  });

  it('활성 프로젝트가 쓰는 레포는 다시 못 쓴다 — 경로 소유권이 겹친다', async () => {
    const ctx = await setup();
    await createProject(ctx.orgId, ctx.userId, input(ctx));

    await expect(createProject(ctx.orgId, ctx.userId, input(ctx))).rejects.toMatchObject({
      code: 'REPO_IN_ACTIVE_PROJECT',
      status: 409,
    });

    // 다른 레포로는 만들 수 있다.
    await expect(
      createProject(ctx.orgId, ctx.userId, input(ctx, { repoIds: [ctx.repoWeb] })),
    ).resolves.toMatchObject({ project: { status: 'planning' } });
  });

  it('끝난 프로젝트의 레포는 다시 쓸 수 있다', async () => {
    const ctx = await setup();
    const first = await createProject(ctx.orgId, ctx.userId, input(ctx));
    await pool.query(`UPDATE projects SET status = 'completed' WHERE id = $1`, [first.project.id]);

    await expect(createProject(ctx.orgId, ctx.userId, input(ctx))).resolves.toMatchObject({
      project: { status: 'planning' },
    });
  });

  // 레포 연결은 팀원에게도 열려 있다. 소유권을 안 정한 레포가 프로젝트에 들어가면 owner_role이 전부 NULL이라
  // inspectPaths가 모든 역할을 통과시킨다 — 소유권 지정이 대표 전용이어도 "지정 안 함"이 열려 있으면 의미가 없다.
  it('소유 역할이 하나도 없는 레포는 422이고 아무것도 만들어지지 않는다', async () => {
    const ctx = await setup();
    const [fresh] = await connectRepos({
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      repos: [{ fullName: 'acme/unowned' }],
    });

    await expect(
      createProject(ctx.orgId, ctx.userId, input(ctx, { repoIds: [fresh!.id] })),
    ).rejects.toMatchObject({ code: 'REPO_OWNERSHIP_NOT_SET', status: 422 });

    expect((await pool.query(`SELECT count(*)::int AS n FROM projects`)).rows[0]!.n).toBe(0);
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'PROJECT_CREATED'`)).rows[0]!.n,
    ).toBe(0);
  });

  it('막힌 레포를 전부 알려준다 — 지정된 레포와 섞여 있어도 미지정 레포만 짚는다', async () => {
    const ctx = await setup();
    const unownedRepos = await connectRepos({
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      repos: [{ fullName: 'acme/unowned-1' }, { fullName: 'acme/unowned-2' }],
    });
    const [a, b] = unownedRepos.map((r) => r.id);

    const failure = createProject(ctx.orgId, ctx.userId, input(ctx, { repoIds: [ctx.repoApi, a!, b!] }));

    await expect(failure).rejects.toMatchObject({ code: 'REPO_OWNERSHIP_NOT_SET' });
    const message = await failure.catch((err: Error) => err.message);
    // 무엇을 먼저 해야 하는지 알려준다. 소유권이 지정된 acme/api는 짚지 않는다.
    expect(message).toContain(`/api/repos/${a}/paths`);
    expect(message).toContain(`/api/repos/${b}/paths`);
    expect(message).not.toContain(ctx.repoApi);
  });

  // 규칙은 "소유 역할이 지정된 경로 규칙이 하나라도 있는가"다. '**'가 아닌 규칙만 지정해도 통과한다 —
  // 모노레포처럼 apps/web/**·apps/api/**만 나누고 루트는 공용으로 두는 설계를 막지 않기 위해서다.
  it("'**'가 아닌 규칙 하나만 소유자가 있어도 통과한다", async () => {
    const ctx = await setup();
    const [mono] = await connectRepos({
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      repos: [{ fullName: 'acme/monorepo' }],
    });
    const tests = (await getRepoPaths(ctx.orgId, mono!.id)).find((p) => p.pathPattern === 'tests/**')!;
    await updatePathOwnership(ctx.orgId, ctx.userId, mono!.id, tests.id, { ownerRole: 'BACKEND' });

    await expect(
      createProject(ctx.orgId, ctx.userId, input(ctx, { repoIds: [mono!.id] })),
    ).resolves.toMatchObject({ project: { status: 'planning' } });
  });
});

// 같은 조직의 일반 멤버 하나를 초대로 들여보낸다. 직접 UPDATE하면 agents.org_id를 함께 채우는 경로를 건너뛴다.
async function addMember(ctx: Ctx, loginId: string, agentName: string): Promise<{ userId: string; agentId: string }> {
  const userId = await createTestUser(loginId);
  const invite = await createInvite(ctx.orgId, ctx.userId, { teamRole: 'BACKEND' });
  await acceptInvite(invite.token, userId);
  return { userId, agentId: await createTestAgent(userId, agentName) };
}

describe('멤버 배정', () => {
  it('배정하면 목록에 나오고 MEMBER_ASSIGNED가 남는다', async () => {
    const ctx = await setup();
    const { project } = await createProject(ctx.orgId, ctx.userId, input(ctx));
    const be = await addMember(ctx, 'be', 'be-laptop');

    const members = await assignMember(ctx.actor, project.id, be.agentId, 'BACKEND');

    expect(members).toEqual([
      { agentId: be.agentId, agentName: 'be-laptop', teamRole: 'BACKEND', userId: be.userId, githubInvites: [] }, // GitHub 레포가 없는 프로젝트라 초대 결과는 비어 있다
    ]);
    const { rows } = await pool.query(
      `SELECT actor_agent_id, on_behalf_of, payload FROM events WHERE type = 'MEMBER_ASSIGNED'`,
    );
    expect(rows[0]).toMatchObject({ actor_agent_id: be.agentId, on_behalf_of: ctx.userId });
    expect(rows[0]!.payload).toEqual({ agentId: be.agentId, teamRole: 'BACKEND' });
  });

  it('같은 역할은 둘이 될 수 없고, 같은 에이전트를 두 번 배정할 수도 없다', async () => {
    const ctx = await setup();
    const { project } = await createProject(ctx.orgId, ctx.userId, input(ctx));
    const first = await addMember(ctx, 'be', 'be-laptop');
    const second = await addMember(ctx, 'be2', 'be2-laptop');
    await assignMember(ctx.actor, project.id, first.agentId, 'BACKEND');

    await expect(assignMember(ctx.actor, project.id, second.agentId, 'BACKEND')).rejects.toMatchObject({
      code: 'ROLE_ALREADY_ASSIGNED',
      status: 409,
    });
    await expect(assignMember(ctx.actor, project.id, first.agentId, 'FRONTEND')).rejects.toMatchObject({
      code: 'AGENT_ALREADY_ASSIGNED',
      status: 409,
    });
  });

  it('다른 조직의 에이전트와 없는 에이전트는 배정할 수 없다', async () => {
    const ctx = await setup();
    const other = await setup('rep2');
    const { project } = await createProject(ctx.orgId, ctx.userId, input(ctx));
    const foreign = await createTestAgent(other.userId, 'foreign-laptop');

    await expect(assignMember(ctx.actor, project.id, foreign, 'BACKEND')).rejects.toMatchObject({
      code: 'AGENT_NOT_IN_ORG',
      status: 403,
    });
    await expect(
      assignMember(ctx.actor, project.id, '11111111-1111-1111-1111-111111111111', 'BACKEND'),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_IN_ORG' });
  });

  it('G1(started_at) 이후에는 배정도 해제도 막힌다', async () => {
    const ctx = await setup();
    const { project } = await createProject(ctx.orgId, ctx.userId, input(ctx));
    const be = await addMember(ctx, 'be', 'be-laptop');
    await assignMember(ctx.actor, project.id, be.agentId, 'BACKEND');
    await pool.query(`UPDATE projects SET started_at = now(), status = 'active' WHERE id = $1`, [project.id]);

    await expect(assignMember(ctx.actor, project.id, be.agentId, 'FRONTEND')).rejects.toMatchObject({
      code: 'PROJECT_STARTED',
      status: 403,
    });
    await expect(unassignMember(ctx.actor, project.id, be.agentId)).rejects.toMatchObject({
      code: 'PROJECT_STARTED',
    });
  });

  it('해제하면 목록에서 빠지고 MEMBER_UNASSIGNED가 남는다 — 역할 교체는 해제 후 재배정', async () => {
    const ctx = await setup();
    const { project } = await createProject(ctx.orgId, ctx.userId, input(ctx));
    const be = await addMember(ctx, 'be', 'be-laptop');
    await assignMember(ctx.actor, project.id, be.agentId, 'BACKEND');

    expect(await unassignMember(ctx.actor, project.id, be.agentId)).toEqual([]);
    const { rows } = await pool.query(`SELECT payload FROM events WHERE type = 'MEMBER_UNASSIGNED'`);
    expect(rows[0]!.payload).toEqual({ agentId: be.agentId, teamRole: 'BACKEND' });

    // 같은 에이전트를 다른 역할로 다시 배정할 수 있다.
    const after = await assignMember(ctx.actor, project.id, be.agentId, 'FRONTEND');
    expect(after[0]).toMatchObject({ teamRole: 'FRONTEND' });
  });

  it('배정되지 않은 에이전트를 해제하면 404다', async () => {
    const ctx = await setup();
    const { project } = await createProject(ctx.orgId, ctx.userId, input(ctx));
    const be = await addMember(ctx, 'be', 'be-laptop');

    await expect(unassignMember(ctx.actor, project.id, be.agentId)).rejects.toMatchObject({
      code: 'MEMBER_NOT_FOUND',
      status: 404,
    });
  });
});

describe('프로젝트 조회', () => {
  it('대표는 레포·멤버·상태를 함께 본다', async () => {
    const ctx = await setup();
    const { project } = await createProject(ctx.orgId, ctx.userId, input(ctx, { repoIds: [ctx.repoApi, ctx.repoWeb] }));
    const be = await addMember(ctx, 'be', 'be-laptop');
    await assignMember(ctx.actor, project.id, be.agentId, 'BACKEND');

    const detail = await getProject(ctx.actor, project.id);

    expect(detail.project).toMatchObject({ status: 'planning', autonomyPreset: 'L2', pmBudgetUsd: '40.00' });
    expect(detail.repos.map((r) => r.fullName)).toEqual(['acme/api', 'acme/web']);
    expect(detail.members.map((m) => m.teamRole)).toEqual(['BACKEND']);
  });

  it('배정된 에이전트의 주인은 보고, 무관한 멤버는 못 본다', async () => {
    const ctx = await setup();
    const { project } = await createProject(ctx.orgId, ctx.userId, input(ctx));
    const be = await addMember(ctx, 'be', 'be-laptop');
    const stranger = await addMember(ctx, 'other', 'other-laptop');
    await assignMember(ctx.actor, project.id, be.agentId, 'BACKEND');

    const owner: Actor = { userId: be.userId, orgId: ctx.orgId, orgRole: 'MEMBER' };
    await expect(getProject(owner, project.id)).resolves.toMatchObject({ project: { id: project.id } });

    const outsider: Actor = { userId: stranger.userId, orgId: ctx.orgId, orgRole: 'MEMBER' };
    await expect(getProject(outsider, project.id)).rejects.toMatchObject({ code: 'NOT_PROJECT_MEMBER' });
  });

  it('다른 조직의 프로젝트는 403, 없는 프로젝트는 404다', async () => {
    const ctx = await setup();
    const other = await setup('rep2');
    const { project } = await createProject(other.orgId, other.userId, input(other));

    await expect(getProject(ctx.actor, project.id)).rejects.toMatchObject({ code: 'CROSS_ORG_ACCESS' });
    await expect(
      getProject(ctx.actor, '11111111-1111-1111-1111-111111111111'),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
});

// 대표 전용 게이트는 미들웨어에 있어 서비스 테스트로는 덮이지 않는다. 실제 HTTP로 확인한다.
describe('HTTP — 대표 전용 게이트', () => {
  const PASSWORD = 'manual-test-1234';
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  async function account(loginId: string): Promise<{ userId: string; token: string }> {
    const { userId } = await signup({ loginId, password: PASSWORD, nickname: loginId });
    const { accessToken } = await login({ loginId, password: PASSWORD });
    return { userId, token: accessToken };
  }

  async function post(path: string, token: string, body: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, never> };
  }

  async function get(path: string, token: string) {
    const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json()) as Record<string, never> };
  }

  it('대표는 만들고, 일반 멤버는 403이다', async () => {
    const rep = await account('rep');
    const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
    const [repo] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/api' }] });
    await ownRepo(orgId, rep.userId, repo!.id, 'BACKEND');
    const member = await account('member');
    const invite = await createInvite(orgId, rep.userId, { teamRole: 'BACKEND' });
    await acceptInvite(invite.token, member.userId);

    const payload = { name: 'p1', autonomyPreset: 'L2', pmBudgetUsd: 40, repoIds: [repo!.id] };

    const denied = await post(`/api/orgs/${orgId}/projects`, member.token, payload);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { code: 'NOT_REPRESENTATIVE' } });

    const created = await post(`/api/orgs/${orgId}/projects`, rep.token, payload);
    expect(created.status).toBe(201);

    // 멤버 배정 응답은 토큰 재발급이 필요하다는 것을 알려준다.
    const agentId = await createTestAgent(member.userId, 'be-laptop');
    const projectId = (created.body as unknown as { data: { project: { id: string } } }).data.project.id;
    const assigned = await post(`/api/projects/${projectId}/members`, rep.token, {
      agentId,
      teamRole: 'BACKEND',
    });
    expect(assigned.status).toBe(201);
    expect((assigned.body as unknown as { data: { notice: string } }).data.notice).toContain('refresh');
  });

  it('다른 조직의 :orgId로는 만들 수 없다', async () => {
    const rep = await account('rep');
    const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
    const [repo] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/api' }] });
    const outsider = await account('outsider');
    await createOrganization(outsider.userId, 'Other Inc.');

    const res = await post(`/api/orgs/${orgId}/projects`, outsider.token, {
      name: 'p1',
      autonomyPreset: 'L2',
      pmBudgetUsd: 40,
      repoIds: [repo!.id],
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'CROSS_ORG_ACCESS' } });
  });

  it('허용 레벨 어휘 위반은 422로 무엇이 허용되는지 알려준다', async () => {
    const rep = await account('rep');
    const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
    const [repo] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/api' }] });

    const res = await post(`/api/orgs/${orgId}/projects`, rep.token, {
      name: 'p1',
      autonomyPreset: 'L9',
      pmBudgetUsd: 40,
      repoIds: [repo!.id],
    });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: 'INVALID_AUTONOMY_PRESET' } });
    expect((res.body as unknown as { error: { message: string } }).error.message).toContain('L1, L2, L3, L4');
  });

  // deadline은 date 컬럼이고 pg는 그걸 JS Date(로컬 자정)로 준다. 그대로 JSON에 실으면
  // KST 서버에서 하루 빠른 UTC 타임스탬프가 나가므로, 보낸 형식 그대로 돌아오는지 고정한다.
  it('deadline은 보낸 형식(YYYY-MM-DD) 그대로 돌아온다 — 타임존으로 하루 밀리지 않는다', async () => {
    const rep = await account('rep');
    const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
    const [repo] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/api' }] });
    await ownRepo(orgId, rep.userId, repo!.id, 'BACKEND');

    const created = await post(`/api/orgs/${orgId}/projects`, rep.token, {
      name: 'p1',
      autonomyPreset: 'L2',
      pmBudgetUsd: 40,
      deadline: '2026-10-31',
      repoIds: [repo!.id],
    });

    expect(created.status).toBe(201);
    const projectId = (created.body as unknown as { data: { project: { id: string; deadline: string } } }).data
      .project.id;
    expect(created.body).toMatchObject({ data: { project: { deadline: '2026-10-31' } } });

    // 조회 경로(findProjectById)도 같은 형식이어야 한다 — 생성 응답만 고치면 화면에서 값이 갈린다.
    const fetched = await get(`/api/projects/${projectId}`, rep.token);
    expect(fetched.body).toMatchObject({ data: { project: { deadline: '2026-10-31' } } });
  });

  // 팀원이 연결한 레포를 대표가 소유권 지정 없이 곧장 프로젝트에 넣는 흐름. 프론트는 이 422를 받으면
  // 경로 소유권 화면으로 보내면 된다 — 메시지에 어느 레포인지와 무엇을 부를지가 함께 들어 있다.
  it('소유권을 안 정한 레포로 만들면 422 REPO_OWNERSHIP_NOT_SET과 할 일을 돌려준다', async () => {
    const rep = await account('rep');
    const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
    const [repo] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/api' }] });

    const res = await post(`/api/orgs/${orgId}/projects`, rep.token, {
      name: 'p1',
      autonomyPreset: 'L2',
      pmBudgetUsd: 40,
      repoIds: [repo!.id],
    });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: 'REPO_OWNERSHIP_NOT_SET' } });
    expect((res.body as unknown as { error: { message: string } }).error.message).toContain(
      `PATCH /api/repos/${repo!.id}/paths/:pathId`,
    );
  });
});

describe('레포 사용 중 판정 — 목록과 생성이 같은 판정', () => {
  const inUse = async (ctx: Ctx) =>
    Object.fromEntries((await listRepos(ctx.orgId)).map((r) => [r.fullName, r.activeProjectId]));
  const conflictOf = (ctx: Ctx, repoIds: string[]) =>
    createProject(ctx.orgId, ctx.userId, input(ctx, { name: 'p-next', repoIds })).then(
      () => null,
      (e: unknown) => e as AppError,
    );

  it('겹치는 레포를 전부 details로 알려주고, 목록의 activeProjectId도 같은 답을 낸다', async () => {
    const ctx = await setup();
    const { project } = await createProject(ctx.orgId, ctx.userId, input(ctx, { repoIds: [ctx.repoApi, ctx.repoWeb] }));

    expect(await inUse(ctx)).toEqual({ 'acme/api': project.id, 'acme/web': project.id });
    const repos = await listRepos(ctx.orgId);
    expect(repos.map((r) => r.activeProjectName)).toEqual([project.name, project.name]);

    const err = await conflictOf(ctx, [ctx.repoApi, ctx.repoWeb]);
    expect(err?.code).toBe('REPO_IN_ACTIVE_PROJECT');
    expect(err?.details).toEqual([
      { repoId: ctx.repoApi, fullName: 'acme/api', projectId: project.id, projectName: project.name },
      { repoId: ctx.repoWeb, fullName: 'acme/web', projectId: project.id, projectName: project.name },
    ]);
  });

  // 상태별로 목록과 생성이 같은 답을 내는지 — 한쪽만 다르면 "목록에서는 고를 수 있는데 저장할 때 막힌다".
  it.each([
    ['planning', true],
    ['active', true],
    ['halted', true], // 재개될 수 있다
    ['completed', false],
    ['aborted', false],
  ])('%s 프로젝트의 레포: 사용 중=%s', async (status, held) => {
    const ctx = await setup();
    const { project } = await createProject(ctx.orgId, ctx.userId, input(ctx, { repoIds: [ctx.repoApi] }));
    // 상태 전이 API(정지·완료·중단)가 아직 없어 행만 바꾼다.
    await pool.query(`UPDATE projects SET status = $2, halt_reason = CASE WHEN $2 = 'halted' THEN 'manual' END WHERE id = $1`, [project.id, status]);

    expect((await inUse(ctx))['acme/api']).toBe(held ? project.id : null);
    const err = await conflictOf(ctx, [ctx.repoApi]);
    expect(err?.code ?? null).toBe(held ? 'REPO_IN_ACTIVE_PROJECT' : null);
  });
});
