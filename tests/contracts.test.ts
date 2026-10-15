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
