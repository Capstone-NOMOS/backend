import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { NomosClient } from '../src/bridge/nomos-client.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { createTask } from '../src/domain/authoring/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { clearPolicyCache } from '../src/domain/policy/policy-cache.js';
import { abortProject, assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { setQuestionRouter } from '../src/domain/question/router-registry.js';
import { teamRulesTag, type QuestionRouter, type RoutingInput } from '../src/domain/question/router.js';
import { drainRoutingRecords } from '../src/domain/question/routing-eval.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 팀별 질문 라우팅 규칙(039) — 대표가 역할마다·공통 문장을 적으면 질문이 올 때 라우터 입력(teamRules)에 들어가고,
// 판정 기록 이름(routed_by)에 +team-<해시>가 붙어 규칙 전·후가 섞이지 않는다.

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

// 대표, FE 담당, BE 담당. FE·BE 태스크를 각 에이전트가 잡은 상태까지.
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
  const task = await createTask(rep.userId, project.id, { title: 'T-1 목록 화면', teamRole: 'FRONTEND', kind: 'INTEGRATION', repoId: web!.id, specId: null, dependsOn: [] });
  await startProject(repActor, project.id);
  const agentClient = async (refreshToken: string) =>
    new NomosClient({ baseUrl, tokens: { accessToken: (await refreshAgentToken(refreshToken)).accessToken, refreshToken } });
  const feClient = await agentClient(feAgent.refreshToken);
  await feClient.claimTask(task.id);
  const beClient = await agentClient(beAgent.refreshToken);
  return { projectId: project.id, orgId, taskId: task.id, rep, fe, be, feClient, beClient, repActor };
}

const Q1 = { question: '목록 화면에 한 번에 몇 개씩 보여 줄까요?', header: '페이지 크기', multiSelect: false, options: [{ label: '20개' }, { label: '50개' }] };
const RULES = { COMMON: '화면은 모습·문구는 PM, 동작은 FE로 가른다', PM: '정책·문구·표시 형식', FRONTEND: '목록을 나눠 보여 주는 방식과 한 번에 불러올 개수', BACKEND: 'DB 구조·API 응답 형식' };

type Json = { data?: unknown; error?: { code: string } };
async function http(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Json };
}
const putRules = (projectId: string, token: string, rules: unknown) => http('PUT', `/projects/${projectId}/routing-rules`, token, { rules });

// 라우터가 받은 입력을 붙잡는다 — 판정은 늘 BACKEND.
function captureRouter(): { router: QuestionRouter; seen: RoutingInput[] } {
  const seen: RoutingInput[] = [];
  return { seen, router: { name: 'capture:v3', route: async (input) => { seen.push(input); return { target: 'BACKEND', confidence: null, reason: null, routedBy: 'capture:v3' }; } } };
}

describe('팀별 질문 라우팅 규칙', () => {
  it('대표가 규칙을 적으면 프로젝트에 남고 이벤트가 생긴다 — 빈 칸은 지우고, 같은 규칙이면 이벤트가 없고, null이면 전부 지운다', async () => {
    const w = await world();
    const rep = await w.rep.token();
    const set = await putRules(w.projectId, rep, { ...RULES, BACKEND: '  ', FRONTEND: null });
    expect(set.status).toBe(200);
    expect((set.json.data as { routingRules: unknown }).routingRules).toEqual({ COMMON: RULES.COMMON, PM: RULES.PM });
    await putRules(w.projectId, rep, { COMMON: RULES.COMMON, PM: RULES.PM });
    const { rows } = await testPool.query(`SELECT payload FROM events WHERE type = 'ROUTING_RULES_UPDATED' AND project_id = $1 ORDER BY id`, [w.projectId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ before: null, after: { COMMON: RULES.COMMON, PM: RULES.PM }, beforeTag: null, afterTag: teamRulesTag({ COMMON: RULES.COMMON, PM: RULES.PM }) });

    const cleared = await putRules(w.projectId, rep, null);
    expect((cleared.json.data as { routingRules: unknown }).routingRules).toBeNull();
    const detail = await http('GET', `/projects/${w.projectId}`, rep);
    expect(JSON.stringify(detail.json.data)).toContain('"routingRules":null');
  });

  it('대표만 바꾼다 — 시작한 프로젝트도 되고, 끝난 프로젝트는 409, 모르는 칸·너무 긴 문장은 400', async () => {
    const w = await world(); // 이미 시작한 프로젝트
    expect((await putRules(w.projectId, await w.be.token(), RULES)).json.error?.code).toBe('NOT_REPRESENTATIVE');
    const rep = await w.rep.token();
    expect((await putRules(w.projectId, rep, RULES)).status).toBe(200);
    expect((await putRules(w.projectId, rep, { QA: '테스트' })).status).toBe(400);
    expect((await putRules(w.projectId, rep, { PM: 'x'.repeat(2001) })).status).toBe(400);
    await abortProject(w.repActor, w.projectId, null);
    expect((await putRules(w.projectId, rep, { PM: '바꿈' })).json.error?.code).toBe('PROJECT_NOT_OPEN');
  });

  it('규칙이 있으면 질문 라우터 입력에 들어가고, 판정 기록 이름에 규칙 해시가 붙고, 입력 스냅샷에 남는다', async () => {
    const w = await world();
    const cap = captureRouter();
    const previous = setQuestionRouter(cap.router);
    try {
      const plain = await w.feClient.askQuestions(w.taskId, [Q1]);
      await putRules(w.projectId, await w.rep.token(), RULES);
      const ruled = await w.feClient.askQuestions(w.taskId, [{ ...Q1, question: '목록을 무한 스크롤로 할까요?' }]);
      await drainRoutingRecords();

      expect(cap.seen[0]!.teamRules).toBeUndefined();
      expect(cap.seen[1]!.teamRules).toEqual(RULES);
      const tag = teamRulesTag(RULES);
      expect(tag).toMatch(/^\+team-[0-9a-f]{8}$/);
      const { rows } = await testPool.query(`SELECT id, routed_by, routing_input FROM agent_questions WHERE id = ANY($1::uuid[])`, [[plain.id, ruled.id]]);
      const byId = new Map(rows.map((r) => [r.id as string, r]));
      expect(byId.get(plain.id)!.routed_by).toBe('capture:v3');
      expect(byId.get(plain.id)!.routing_input.teamRules).toBeUndefined();
      expect(byId.get(ruled.id)!.routed_by).toBe(`capture:v3${tag}`);
      expect(byId.get(ruled.id)!.routing_input.teamRules).toEqual(RULES);
      const runs = await testPool.query(`SELECT router FROM question_routing_runs WHERE question_id = $1 AND mode = 'primary'`, [ruled.id]);
      expect(runs.rows.map((r) => r.router)).toEqual([`capture:v3${tag}`]);
    } finally {
      setQuestionRouter(previous);
    }
  });
});
