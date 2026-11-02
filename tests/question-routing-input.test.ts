import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { NomosClient } from '../src/bridge/nomos-client.js';
import { pool, withTransaction } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { createSpec, createTask } from '../src/domain/authoring/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { requestContractsInTx } from '../src/domain/contract/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { clearPolicyCache } from '../src/domain/policy/policy-cache.js';
import { assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { drainRoutingRecords } from '../src/domain/question/routing-eval.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 라우팅 입력 저장(032)과 평가 데이터셋 내보내기 — 운영에서 나온 실제 질문을 라우터가 본 입력 그대로 다시 비교할 수 있게.
// 픽스처는 전부 서비스·HTTP를 거친다(계약도 요청 → BE 초안 → BE 확정의 실제 경로로).

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await resetSchema();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await drainRoutingRecords();
  await truncateAll();
  clearPolicyCache();
});

afterAll(async () => {
  await drainRoutingRecords();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

const PASSWORD = 'correct-horse-battery';

async function account(loginId: string) {
  const { userId, connectKey } = await signup({ loginId, password: PASSWORD, nickname: loginId });
  return { userId, connectKey, token: async () => (await login({ loginId, password: PASSWORD })).accessToken };
}

type Json = { data?: Record<string, unknown>; error?: { code: string } };
async function http(method: string, urlPath: string, token: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}/api${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

const CONTRACT_YAML = `paths:
  /api/studies:
    get:
      responses:
        '200':
          description: 스터디 목록
`;

// 대표·FE·BE. F-1(API 필요 — 계약을 확정한다)과 F-2(API 없음)의 FE 태스크를 FE 에이전트가 잡은 상태까지.
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

  const withApi = await createSpec(rep.userId, project.id, { featureKey: 'F-1', title: '스터디 목록', content: '모집 중인 스터디 목록을 보여 준다.', tests: [], needsApi: true, apiNeeds: '스터디 목록' });
  const noApi = await createSpec(rep.userId, project.id, { featureKey: 'F-2', title: '공유 버튼', content: '주소를 복사한다.', tests: [] });
  const projectRow = (await pool.query(`SELECT id, org_id, policy_hash FROM projects WHERE id = $1`, [project.id])).rows[0]!;
  await withTransaction((tx) => requestContractsInTx(tx, { id: project.id, orgId: projectRow.org_id, policyHash: projectRow.policy_hash }, [withApi.id], rep.userId));

  const agentClient = async (refreshToken: string) =>
    new NomosClient({ baseUrl, tokens: { accessToken: (await refreshAgentToken(refreshToken)).accessToken, refreshToken } });
  const beClient = await agentClient(beAgent.refreshToken);
  const jobs = (await beClient.listContractJobs()) as unknown as { contracts: { id: string; attempt: number }[] };
  const job = jobs.contracts[0]!;
  await beClient.submitContractDraft(job.id, { attempt: job.attempt, openapiYaml: CONTRACT_YAML, summary: 'GET /api/studies → data.studies', openQuestions: [] });
  expect((await http('POST', `/contracts/${job.id}/approve`, await be.token())).status).toBe(200);

  const listTask = await createTask(rep.userId, project.id, { title: 'T-1 스터디 목록 화면', teamRole: 'FRONTEND', kind: 'IMPLEMENT', repoId: web!.id, specId: withApi.id, dependsOn: [] });
  const shareTask = await createTask(rep.userId, project.id, { title: 'T-2 공유 버튼', teamRole: 'FRONTEND', kind: 'IMPLEMENT', repoId: web!.id, specId: noApi.id, dependsOn: [] });
  await startProject(repActor, project.id);
  const feClient = await agentClient(feAgent.refreshToken);
  return { orgId, projectId: project.id, rep, fe, be, feClient, listTaskId: listTask.id, shareTaskId: shareTask.id };
}

const PAGE = { question: '스터디 목록 한 페이지 크기는?', options: [{ label: '10개' }, { label: '20개' }] };

describe('라우팅 입력 저장 (032)', () => {
  it('질문을 올리면 라우터가 본 입력이 RoutingInputSnapshot 그대로 저장되고 context(orgId)는 없다 — 확정한 계약도 들어 있다', async () => {
    const w = await world();
    await w.feClient.claimTask(w.listTaskId);
    const asked = await w.feClient.askQuestions(w.listTaskId, [PAGE]);
    const { rows } = await pool.query(`SELECT routing_input FROM agent_questions WHERE id = $1`, [asked.id]);
    expect(rows[0]!.routing_input).toEqual({
      stage: 'implementation',
      askerRole: 'FRONTEND',
      roles: ['FRONTEND', 'BACKEND'],
      task: { title: 'T-1 스터디 목록 화면', kind: 'IMPLEMENT' },
      spec: { featureKey: 'F-1', title: '스터디 목록', content: '모집 중인 스터디 목록을 보여 준다.' },
      repo: { fullName: 'acme/web' },
      questions: [PAGE],
      contract: { featureKey: 'F-1', summary: 'GET /api/studies → data.studies' },
    });
    expect(rows[0]!.routing_input).not.toHaveProperty('context');
    expect(JSON.stringify(rows[0]!.routing_input)).not.toContain(w.orgId);
  });

  it('계약이 없는 기능이면 contract는 null이다', async () => {
    const w = await world();
    await w.feClient.claimTask(w.shareTaskId);
    const asked = await w.feClient.askQuestions(w.shareTaskId, [PAGE]);
    const { rows } = await pool.query(`SELECT routing_input FROM agent_questions WHERE id = $1`, [asked.id]);
    expect(rows[0]!.routing_input).toMatchObject({ spec: { featureKey: 'F-2' }, contract: null });
  });
});

describe('평가 데이터셋 내보내기 (GET /projects/:id/routing-dataset)', () => {
  it('대표만 — gold 라벨이 accept로, labeledOnly, 입력이 없는 옛 질문은 빠진다, 지운 프로젝트는 404', async () => {
    const w = await world();
    await w.feClient.claimTask(w.listTaskId);
    const labeled = await w.feClient.askQuestions(w.listTaskId, [PAGE]);
    const unlabeled = await w.feClient.askQuestions(w.listTaskId, [{ question: '정렬 기준은?', options: [] }]);
    const legacy = await w.feClient.askQuestions(w.listTaskId, [{ question: '옛 질문', options: [] }]);
    // 032 이전 질문을 흉내 낸다 — 입력이 저장되지 않은 행(서비스로는 만들 수 없는 과거 상태라 직접 비운다).
    await pool.query(`UPDATE agent_questions SET routing_input = NULL WHERE id = $1`, [legacy.id]);
    expect((await http('POST', `/questions/${labeled.id}/gold`, await w.rep.token(), { target: 'BACKEND' })).status).toBe(200);

    const repToken = await w.rep.token();
    const eventsBefore = (await pool.query(`SELECT count(*)::int AS n FROM events`)).rows[0]!.n as number;
    const all = await http('GET', `/projects/${w.projectId}/routing-dataset`, repToken);
    expect(all.status).toBe(200);
    const items = (all.json.data as { items: { id: string; accept: string[]; gold_labeled: boolean; source: string; primary: { router: string; target: string }; input: unknown }[] }).items;
    expect(items.map((i) => i.id)).toEqual([labeled.id, unlabeled.id]);
    expect(items[0]).toMatchObject({ stage: 'implementation', accept: ['BACKEND'], gold_labeled: true, source: 'real-run', primary: { router: 'role_rule:opposite', target: 'BACKEND' } });
    expect(items[1]).toMatchObject({ accept: [], gold_labeled: false });
    expect(items[0]!.input).toMatchObject({ askerRole: 'FRONTEND', questions: [PAGE] });
    // 읽기는 이벤트를 남기지 않는다.
    expect((await pool.query(`SELECT count(*)::int AS n FROM events`)).rows[0]!.n).toBe(eventsBefore);

    const onlyLabeled = await http('GET', `/projects/${w.projectId}/routing-dataset?labeledOnly=true`, repToken);
    expect((onlyLabeled.json.data as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([labeled.id]);

    // stage 필터 — 지금 생기는 질문은 전부 implementation이다.
    const impl = await http('GET', `/projects/${w.projectId}/routing-dataset?stage=implementation`, repToken);
    expect((impl.json.data as { items: unknown[] }).items).toHaveLength(2);
    const spec = await http('GET', `/projects/${w.projectId}/routing-dataset?stage=feature_spec`, repToken);
    expect((spec.json.data as { items: unknown[] }).items).toEqual([]);
    expect((await http('GET', `/projects/${w.projectId}/routing-dataset?stage=planning`, repToken)).status).toBe(400);

    // 운영 보고서의 단계별 일치율 — 정답이 붙은 질문 하나가 implementation에 잡힌다.
    await drainRoutingRecords();
    const report = (await http('GET', `/projects/${w.projectId}/routing-report`, repToken)).json.data as unknown as {
      byStage: { stage: string; questions: number; labeled: number; routers: { router: string; labeled: number; aligned: number }[] }[];
      rows: { questionId: string; stage: string }[];
    };
    expect(report.byStage.map((s) => s.stage)).toEqual(['implementation', 'feature_spec', 'contract']);
    expect(report.byStage[0]).toMatchObject({ stage: 'implementation', questions: 3, labeled: 1 });
    expect(report.byStage[0]!.routers.find((r) => r.router === 'role_rule:opposite')).toMatchObject({ labeled: 1, aligned: 1 });
    expect(report.byStage[1]).toMatchObject({ questions: 0, labeled: 0, routers: [] });
    expect(report.rows.every((r) => r.stage === 'implementation')).toBe(true);

    const member = await http('GET', `/projects/${w.projectId}/routing-dataset`, await w.fe.token());
    expect(member.status).toBe(403);
    expect(member.json.error?.code).toBe('NOT_REPRESENTATIVE');

    expect((await http('DELETE', `/projects/${w.projectId}`, repToken)).status).toBe(200);
    expect((await http('GET', `/projects/${w.projectId}/routing-dataset`, repToken)).status).toBe(404);
  });
});
