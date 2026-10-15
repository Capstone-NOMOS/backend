import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { checkContractYaml } from '../src/domain/contract/validate.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { setPmModel } from '../src/domain/pm/model.js';
import { drainPmJobs } from '../src/domain/pm/service.js';
import { assignMember, createProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { assignRootOwner } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// API 계약(023, 새 계획 흐름 2단계): 기능 명세 확정 → API가 필요한 기능마다 작성 대기 → BE 에이전트 초안 → BE 담당 확정·수정 요청.

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

afterEach(() => {
  setPmModel(null);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

type Res = { status: number; data: Record<string, unknown>; error?: { code: string; details?: unknown } };

async function http(method: string, path: string, token: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: unknown } };
  return { status: res.status, data: json.data ?? {}, ...(json.error ? { error: json.error } : {}) };
}

async function account(loginId: string) {
  const { userId, connectKey } = await signup({ loginId, password: 'correct-horse-battery', nickname: loginId });
  const { accessToken } = await login({ loginId, password: 'correct-horse-battery' });
  return { userId, token: accessToken, connectKey };
}

const FEATURES = {
  summary: '멤버 목록과 링크 복사',
  assumptions: [],
  features: [
    { featureKey: 'F-20', title: '스터디 멤버 목록', description: '상세 화면에 멤버 목록', acceptance: ['닉네임과 가입일이 보인다'], needsApi: true, apiNeeds: '멤버마다 닉네임과 가입일' },
    { featureKey: 'F-21', title: '링크 복사', description: '공유 버튼', acceptance: ['주소가 복사된다'], needsApi: false, apiNeeds: null },
  ],
};

const GOOD_YAML = `paths:
  /api/studies/{studyId}/members:
    get:
      summary: 스터디 멤버 목록
      responses:
        '200':
          description: 멤버 목록
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: object
                    properties:
                      members:
                        type: array
        '404':
          description: 스터디 없음
`;

// 대표·BE 팀원·FE 팀원. BE·FE 에이전트를 배정하고, PM 기능 명세를 확정까지 한다(실제 경로 — 가짜 모델).
async function world() {
  const rep = await account('rep');
  const { orgId } = await createOrganization(rep.userId, 'Acme');
  const be = await account('be');
  const fe = await account('fe');
  for (const u of [be, fe]) {
    const { token } = await createInvite(orgId, rep.userId);
    await acceptInvite(token, u.userId);
  }
  const [api, web] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/api' }, { fullName: 'acme/web' }] });
  await assignRootOwner(orgId, rep.userId, api!.id, 'BACKEND');
  await assignRootOwner(orgId, rep.userId, web!.id, 'FRONTEND');
  const { project } = await createProject(orgId, rep.userId, { name: 'p', autonomyPreset: 'L2', pmBudgetUsd: 10, repoIds: [api!.id, web!.id] });
  const actor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' as const };
  const beAgent = await connectAgent({ connectKey: be.connectKey, agentName: 'be-laptop', harness: 'claude-code', skills: [], maxConcurrent: 1 });
  const feAgent = await connectAgent({ connectKey: fe.connectKey, agentName: 'fe-laptop', harness: 'claude-code', skills: [], maxConcurrent: 1 });
  await assignMember(actor, project.id, beAgent.agentId, 'BACKEND');
  await assignMember(actor, project.id, feAgent.agentId, 'FRONTEND');

  setPmModel({
    kind: 'fake',
    async generate() {
      return { stopReason: 'end_turn', servedModel: 'fake', text: JSON.stringify(FEATURES), attempts: [] };
    },
  });
  const req = await http('POST', `/projects/${project.id}/pm/features`, rep.token, { instruction: '멤버 목록' });
  await drainPmJobs();
  expect((await http('POST', `/projects/${project.id}/pm/plans/${req.data.id as string}/apply`, rep.token)).status).toBe(200);

  return {
    rep,
    be,
    fe,
    projectId: project.id,
    beToken: (await refreshAgentToken(beAgent.refreshToken)).accessToken,
    feToken: (await refreshAgentToken(feAgent.refreshToken)).accessToken,
  };
}

type Contract = { id: string; status: string; attempt: number; featureKey: string; schemaYaml: string | null; feedback: string | null };

async function contracts(w: Awaited<ReturnType<typeof world>>): Promise<Contract[]> {
  return (await http('GET', `/projects/${w.projectId}/contracts`, w.fe.token)).data.contracts as Contract[];
}

describe('계약 형식 검사 (checkContractYaml)', () => {
  it('경로·메서드·응답 상태 코드가 있는 OpenAPI 조각만 통과한다', () => {
    expect(checkContractYaml(GOOD_YAML)).toMatchObject({ ok: true, operations: ['GET /api/studies/{studyId}/members'] });
    expect(checkContractYaml('a: [')).toMatchObject({ ok: false });
    expect(checkContractYaml('paths: {}')).toMatchObject({ ok: false, problems: [expect.stringContaining('paths가 비어 있다')] });
    const bad = checkContractYaml(`paths:\n  api/x:\n    fetch: {}\n  /api/y:\n    get:\n      responses:\n        ok: {}\n`);
    expect(bad.ok).toBe(false);
    expect((bad as { problems: string[] }).problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("'/'로 시작"),
        expect.stringContaining('알 수 없는 키'),
        expect.stringContaining('상태 코드가 아니다'),
      ]),
    );
  });
});

describe('API 계약 흐름', () => {
  it('기능 명세를 확정하면 API가 필요한 기능에만 작성 대기 계약이 생기고, BE 에이전트만 작업을 받는다', async () => {
    const w = await world();
    const list = await contracts(w);
    expect(list.map((c) => [c.featureKey, c.status, c.attempt])).toEqual([['F-20', 'pending', 1]]);

    const jobs = await http('GET', '/agents/me/contract-jobs', w.beToken);
    expect(jobs.data).toMatchObject({
      contracts: [{ featureKey: 'F-20', apiNeeds: '멤버마다 닉네임과 가입일', previous: null }],
      repos: [{ fullName: 'acme/api' }],
    });
    expect((jobs.data.contracts as { specContent: string }[])[0]!.specContent).toContain('## 수용 기준');
    expect((await http('GET', '/agents/me/contract-jobs', w.feToken)).data).toEqual({ contracts: [], approved: [], repos: [] });

    const { rows } = await testPool.query(`SELECT type FROM events WHERE type LIKE 'CONTRACT_%'`);
    expect(rows.map((r) => r.type)).toEqual(['CONTRACT_REQUESTED']);
  });

  it('형식이 틀린 초안은 422(위반 목록), 맞으면 초안 — BE 담당만 확정한다(FE 403)', async () => {
    const w = await world();
    const [c] = await contracts(w);
    const invalid = await http('POST', `/contracts/${c!.id}/draft`, w.beToken, { attempt: 1, openapiYaml: 'paths: {}', summary: 's', openQuestions: [] });
    expect(invalid).toMatchObject({ status: 422, error: { code: 'CONTRACT_INVALID' } });
    expect((invalid.error!.details as string[])[0]).toContain('paths');
    expect((await http('POST', `/contracts/${c!.id}/draft`, w.feToken, { attempt: 1, openapiYaml: GOOD_YAML, summary: 's' })).error?.code).toBe('NOT_CONTRACT_WRITER');

    const drafted = await http('POST', `/contracts/${c!.id}/draft`, w.beToken, { attempt: 1, openapiYaml: GOOD_YAML, summary: '멤버 목록을 data.members로', openQuestions: ['정원 제한?'] });
    expect(drafted).toMatchObject({ status: 200, data: { status: 'draft', openQuestions: ['정원 제한?'] } });
    // 같은 회차를 또 내면 409
    expect((await http('POST', `/contracts/${c!.id}/draft`, w.beToken, { attempt: 1, openapiYaml: GOOD_YAML, summary: 's' })).error?.code).toBe('CONTRACT_STALE');

    expect((await http('POST', `/contracts/${c!.id}/approve`, w.fe.token)).error?.code).toBe('NOT_CONTRACT_APPROVER');
    expect((await http('POST', `/contracts/${c!.id}/approve`, w.rep.token)).error?.code).toBe('NOT_CONTRACT_APPROVER'); // BE 담당이 있으면 대표도 아니다
    const approved = await http('POST', `/contracts/${c!.id}/approve`, w.be.token);
    expect(approved).toMatchObject({ status: 200, data: { status: 'approved' } });
    expect((await http('POST', `/contracts/${c!.id}/approve`, w.be.token)).error?.code).toBe('CONTRACT_NOT_DRAFT');

    const { rows } = await testPool.query(`SELECT type, payload FROM events WHERE type = 'CONTRACT_DRAFTED'`);
    expect(rows[0]!.payload).toMatchObject({ featureKey: 'F-20', attempt: 1, operations: ['GET /api/studies/{studyId}/members'], openQuestionCount: 1 });
  });

  it('수정 요청하면 다음 회차로 다시 작성 대기 — 직전 초안과 피드백을 작업으로 받는다. 3회까지', async () => {
    const w = await world();
    const [c] = await contracts(w);
    let attempt = 1;
    for (let i = 0; i < 3; i += 1) {
      await http('POST', `/contracts/${c!.id}/draft`, w.beToken, { attempt, openapiYaml: GOOD_YAML, summary: `v${attempt}` });
      const revised = await http('POST', `/contracts/${c!.id}/revise`, w.be.token, { feedback: `고쳐 ${i}` });
      expect(revised).toMatchObject({ status: 200, data: { status: 'pending', attempt: attempt + 1, feedback: `고쳐 ${i}` } });
      attempt += 1;
    }
    const jobs = (await http('GET', '/agents/me/contract-jobs', w.beToken)).data.contracts as { attempt: number; feedback: string; previous: { summary: string } }[];
    expect(jobs[0]).toMatchObject({ attempt: 4, feedback: '고쳐 2', previous: { summary: 'v3' } });

    await http('POST', `/contracts/${c!.id}/draft`, w.beToken, { attempt: 4, openapiYaml: GOOD_YAML, summary: 'v4' });
    expect((await http('POST', `/contracts/${c!.id}/revise`, w.be.token, { feedback: '또' })).error).toMatchObject({
      code: 'CONTRACT_REVISION_LIMIT',
      details: { limit: 3, used: 3 },
    });
  });

  it('노트북이 못 쓰면 failed — 수정 요청으로 다시 시킬 수 있다. BE 담당이 빠지면 대표가 대신한다', async () => {
    const w = await world();
    const [c] = await contracts(w);
    const failed = await http('POST', `/contracts/${c!.id}/failure`, w.beToken, { attempt: 1, reason: '형식을 두 번 다 못 맞췄다' });
    expect(failed).toMatchObject({ status: 200, data: { status: 'failed', errorReason: '형식을 두 번 다 못 맞췄다' } });

    // BE 담당을 빼면(시작 전) 확정·수정 요청은 대표가 한다.
    const beAgentId = (await testPool.query(`SELECT agent_id FROM project_members WHERE project_id = $1 AND team_role = 'BACKEND'`, [w.projectId])).rows[0]!.agent_id as string;
    expect((await http('DELETE', `/projects/${w.projectId}/members/${beAgentId}`, w.rep.token)).status).toBe(200);
    const revised = await http('POST', `/contracts/${c!.id}/revise`, w.rep.token, {});
    expect(revised).toMatchObject({ status: 200, data: { status: 'pending', attempt: 2, feedback: null } });
  });

  it('룸에 계약 진행이 모든 역할에 보인다', async () => {
    const w = await world();
    const [c] = await contracts(w);
    await http('POST', `/contracts/${c!.id}/draft`, w.beToken, { attempt: 1, openapiYaml: GOOD_YAML, summary: 's' });
    await http('POST', `/contracts/${c!.id}/approve`, w.be.token);
    const feed = (await http('GET', `/projects/${w.projectId}/rooms/FRONTEND/feed`, w.rep.token)).data.messages as { text: string }[];
    expect(feed.map((m) => m.text).reverse()).toEqual(
      expect.arrayContaining([
        '기능 명세를 확정했습니다',
        'API가 필요한 기능 1개의 계약 작성을 백엔드 에이전트에게 맡겼습니다',
        'F-20 API 계약 초안을 썼습니다 — 백엔드 담당 확인을 기다립니다',
        'F-20 API 계약을 확정했습니다',
      ]),
    );
  });
});

// 새 계획 흐름 3단계 — 확정한 명세·계약 위에서만 태스크를 나누고, 태스크에는 그 계약이 붙는다.
describe('태스크 나누기 → 시작 → 브리핑', () => {
  const SPLIT = {
    mode: 'CONTRACT_PARALLEL',
    rationale: '계약이 확정돼 병행',
    estimate: { workingDays: 3, notes: '' },
    tasks: [
      { ref: 'api', title: '멤버 목록 API', repo: 'acme/api', teamRole: 'BACKEND', kind: 'IMPLEMENT', spec: 'F-20', dependsOn: [] },
      { ref: 'list', title: '멤버 목록 화면', repo: 'acme/web', teamRole: 'FRONTEND', kind: 'IMPLEMENT', spec: 'F-20', dependsOn: [] },
      { ref: 'copy', title: '링크 복사 버튼', repo: 'acme/web', teamRole: 'FRONTEND', kind: 'IMPLEMENT', spec: 'F-21', dependsOn: [] },
    ],
    integrationChecks: ['상세 화면이 멤버 목록 API 응답의 멤버를 보여 준다'],
  };

  function splitModel(): string[] {
    const users: string[] = [];
    setPmModel({
      kind: 'fake',
      async generate(req) {
        users.push(req.user);
        return { stopReason: 'end_turn', servedModel: 'fake', text: JSON.stringify(SPLIT), attempts: [] };
      },
    });
    return users;
  }

  async function approve(w: Awaited<ReturnType<typeof world>>) {
    const [c] = await contracts(w);
    await http('POST', `/contracts/${c!.id}/draft`, w.beToken, { attempt: 1, openapiYaml: GOOD_YAML, summary: '기존 /api/studies 아래에 둔다' });
    expect((await http('POST', `/contracts/${c!.id}/approve`, w.be.token)).status).toBe(200);
    return c!;
  }

  it('API 계약이 확정되기 전에는 나눌 수 없다(409 CONTRACTS_NOT_APPROVED, 어느 기능인지)', async () => {
    const w = await world();
    splitModel();
    const res = await http('POST', `/projects/${w.projectId}/pm/plans`, w.rep.token, {});
    expect(res).toMatchObject({ status: 409, error: { code: 'CONTRACTS_NOT_APPROVED', details: { featureKeys: ['F-20'] } } });
  });

  it('확정하면 지시 없이도 나누고, PM은 명세·계약 본문을 받는다 — 태스크에 계약이 붙고 FE·BE 브리핑에 같은 계약이 간다', async () => {
    const w = await world();
    const contract = await approve(w);
    const users = splitModel();
    const req = await http('POST', `/projects/${w.projectId}/pm/plans`, w.rep.token);
    expect(req.status).toBe(202);
    await drainPmJobs();
    expect(users[0]).toContain('### F-20 스터디 멤버 목록');
    expect(users[0]).toContain('/api/studies/{studyId}/members');
    expect(users[0]).toContain('(서버 API가 필요 없는 기능)'); // F-21
    expect(users[0]).toContain('(추가 지시 없음');
    expect((await http('POST', `/projects/${w.projectId}/pm/plans/${req.data.id as string}/apply`, w.rep.token)).status).toBe(200);

    const tasks = (await testPool.query(`SELECT id, title, contract_id FROM tasks ORDER BY title`)).rows;
    expect(tasks.map((t) => [t.title, t.contract_id])).toEqual([
      ['링크 복사 버튼', null],
      ['멤버 목록 API', contract.id],
      ['멤버 목록 화면', contract.id],
    ]);

    expect((await http('POST', `/projects/${w.projectId}/start`, w.rep.token)).status).toBe(200);
    const byTitle = new Map(tasks.map((t) => [t.title as string, t.id as string]));
    const fe = await http('GET', `/tasks/${byTitle.get('멤버 목록 화면')!}/briefing`, w.feToken);
    expect(fe.data.contract).toMatchObject({ id: contract.id, featureKey: 'F-20', schemaYaml: GOOD_YAML, summary: '기존 /api/studies 아래에 둔다' });
    const be = await http('GET', `/tasks/${byTitle.get('멤버 목록 API')!}/briefing`, w.beToken);
    expect((be.data.contract as { id: string }).id).toBe(contract.id);
    expect((await http('GET', `/tasks/${byTitle.get('링크 복사 버튼')!}/briefing`, w.feToken)).data.contract).toBeNull();
  });

  it('계약이 확정되지 않은 기능의 태스크가 있으면 시작할 수 없다(사람이 직접 만든 태스크도)', async () => {
    const w = await world();
    const ids = (await testPool.query(`SELECT (SELECT id FROM repos WHERE full_name = 'acme/api') AS repo_id, (SELECT id FROM specs WHERE feature_key = 'F-20') AS spec_id`)).rows[0];
    const created = await http('POST', `/projects/${w.projectId}/tasks`, w.rep.token, {
      title: '손으로 만든 API 태스크', repoId: ids.repo_id, specId: ids.spec_id, teamRole: 'BACKEND', kind: 'IMPLEMENT',
    });
    expect(created.status).toBe(201);
    const start = await http('POST', `/projects/${w.projectId}/start`, w.rep.token);
    expect(start.status).toBe(422);
    expect(start.error!.details).toEqual(expect.arrayContaining([expect.objectContaining({ where: 'contracts.F-20' })]));

    await approve(w);
    expect((await http('POST', `/projects/${w.projectId}/start`, w.rep.token)).status).toBe(200);
  });
});
