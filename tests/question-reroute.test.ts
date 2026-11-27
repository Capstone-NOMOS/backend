import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { NomosClient } from '../src/bridge/nomos-client.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { createTask } from '../src/domain/authoring/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { onQuestionsChanged } from '../src/domain/dispatch/questions-changed.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { clearPolicyCache } from '../src/domain/policy/policy-cache.js';
import { assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { drainPmDrafts } from '../src/domain/question/pm-draft.js';
import { drainRoutingRecords } from '../src/domain/question/routing-eval.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 질문 재지정(038) — 라우터가 보낸 대상이 그 결정을 내릴 사람이 아니면 지금 대상 역할 담당 또는 대표가 다른 역할로 다시 보낸다.
// 테스트의 기본 라우터는 반대 역할 규칙이라 FE 에이전트의 질문은 BACKEND로 간다.

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
  return { projectId: project.id, taskId: task.id, rep, fe, be, feClient, beClient };
}

const Q1 = { question: '목록 화면에 한 번에 몇 개씩 보여 줄까요?', header: '페이지 크기', multiSelect: false, options: [{ label: '20개' }, { label: '50개' }] };

type Question = { id: string; status: string; targetRole: string; reroutedFrom: string | null; draft: unknown };
type Json = { data?: unknown; error?: { code: string; details?: { where: string; message: string }[] } };
async function http(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Json };
}
const reroute = (id: string, token: string, body: unknown) => http('POST', `/questions/${id}/reroute`, token, body);

describe('질문 재지정', () => {
  it('BE 담당이 "FE가 정할 일"로 다시 보내면 FE 담당이 답하고, 기다리던 에이전트가 그 답을 받는다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    expect(asked).toMatchObject({ targetRole: 'BACKEND' });
    const beToken = await w.be.token();
    const feToken = await w.fe.token();

    const signals: string[] = [];
    const off = onQuestionsChanged((_p, role) => signals.push(role));
    const moved = await reroute(asked.id, beToken, { targetRole: 'FRONTEND', reason: '화면 정책은 프론트가 정한다' }).finally(off);
    expect(moved.status).toBe(200);
    expect(moved.json.data).toMatchObject({ id: asked.id, status: 'pending', targetRole: 'FRONTEND', reroutedFrom: 'BACKEND' });
    // 질문한 역할로 보낸 질문은 사람이 답한다 — 묻는 에이전트 쪽 상담 실행을 깨우지 않는다.
    expect(signals).toEqual([]);
    expect((await w.feClient.listConsultJobs()).questions).toEqual([]);

    // 옛 대상은 더 이상 답할 수 없고, 새 대상의 "내가 답할 질문"에 나온다.
    expect((await http('POST', `/questions/${asked.id}/answer`, beToken, { answers: { [Q1.question]: '20개' } })).json.error?.code).toBe('NOT_QUESTION_TARGET');
    const beList = (await http('GET', '/me/questions', beToken)).json.data as { questions: unknown[] };
    expect(beList.questions).toEqual([]);
    const feList = (await http('GET', '/me/questions', feToken)).json.data as { questions: { question: { id: string } }[] };
    expect(feList.questions.map((r) => r.question.id)).toEqual([asked.id]);

    const answered = await http('POST', `/questions/${asked.id}/answer`, feToken, { answers: { [Q1.question]: '20개' } });
    expect(answered.status).toBe(200);
    expect(await w.feClient.getQuestion(w.taskId, asked.id)).toMatchObject({ status: 'answered', answers: { [Q1.question]: '20개' } });

    const { rows } = await pool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'QUESTION_REROUTED'`);
    expect(rows).toEqual([
      {
        on_behalf_of: w.be.userId,
        payload: expect.objectContaining({
          questionId: asked.id, taskId: w.taskId, stage: 'implementation', fromRole: 'BACKEND', targetRole: 'FRONTEND',
          reroutedByRole: 'TARGET_OWNER', reason: '화면 정책은 프론트가 정한다', clearedDraft: false,
        }),
      },
    ]);
  });

  it('다른 역할로 보내면 그 역할을 깨우고, 여러 번 옮겨도 처음 판정만 reroutedFrom에 남는다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    const repToken = await w.rep.token();

    const toPm = await reroute(asked.id, await w.be.token(), { targetRole: 'PM' });
    expect(toPm.json.data).toMatchObject({ targetRole: 'PM', reroutedFrom: 'BACKEND' });
    await drainPmDrafts(); // PM 모델이 없어 초안은 못 만든다(대표가 직접 답한다) — 실패가 흐름을 막지 않는다.

    // PM 대상은 대표만 옮길 수 있다(PM 역할 멤버가 없다). 다시 BE로 — 그 역할 Executor를 깨운다.
    expect((await reroute(asked.id, await w.be.token(), { targetRole: 'BACKEND' })).json.error?.code).toBe('NOT_QUESTION_TARGET');
    const signals: string[] = [];
    const off = onQuestionsChanged((_p, role) => signals.push(role));
    const back = await reroute(asked.id, repToken, { targetRole: 'BACKEND' }).finally(off);
    expect(back.json.data).toMatchObject({ targetRole: 'BACKEND', reroutedFrom: 'BACKEND' });
    expect(signals).toEqual(['BACKEND']);
    expect((await w.beClient.listConsultJobs()).questions.map((q) => q.id)).toEqual([asked.id]);

    const { rows } = await pool.query(`SELECT payload->>'fromRole' AS f, payload->>'targetRole' AS t, payload->>'reroutedByRole' AS by FROM events WHERE type = 'QUESTION_REROUTED' ORDER BY id`);
    expect(rows).toEqual([{ f: 'BACKEND', t: 'PM', by: 'TARGET_OWNER' }, { f: 'PM', t: 'BACKEND', by: 'REPRESENTATIVE' }]);
  });

  it('라우팅 평가는 그대로다 — 데이터셋의 판정은 라우터가 처음 보낸 대상, 평가 기록도 바뀌지 않는다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    await drainRoutingRecords();
    const before = (await pool.query(`SELECT router, mode, target FROM question_routing_runs ORDER BY id`)).rows;

    await reroute(asked.id, await w.be.token(), { targetRole: 'FRONTEND' });
    const repToken = await w.rep.token();
    const dataset = (await http('GET', `/projects/${w.projectId}/routing-dataset`, repToken)).json.data as { items: { id: string; primary: { target: string } }[] };
    expect(dataset.items).toMatchObject([{ id: asked.id, primary: { target: 'BACKEND' } }]);
    expect((await pool.query(`SELECT router, mode, target FROM question_routing_runs ORDER BY id`)).rows).toEqual(before);
  });

  it('옛 대상의 상담 초안은 지우고, 재지정 뒤에 늦게 온 초안은 받지 않는다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    // 코드에 정해져 있지 않다는 초안 — 질문은 대기로 남는다.
    await w.beClient.submitDraft(asked.id, { answers: { [Q1.question]: '20개?' }, decided: { [Q1.question]: false }, basis: {} });
    const moved = await reroute(asked.id, await w.rep.token(), { targetRole: 'PM' });
    expect(moved.json.data).toMatchObject({ targetRole: 'PM', draft: null });
    const ev = await pool.query(`SELECT payload FROM events WHERE type = 'QUESTION_REROUTED'`);
    expect(ev.rows[0].payload).toMatchObject({ clearedDraft: true, reroutedByRole: 'REPRESENTATIVE' });
    await drainPmDrafts();
    await expect(
      w.beClient.submitDraft(asked.id, { answers: { [Q1.question]: '20개' }, decided: { [Q1.question]: true }, basis: {} }),
    ).rejects.toMatchObject({ code: 'NOT_QUESTION_TARGET' });
  });

  it('지금 대상 담당·대표만, 대기 중인 질문만, 다른 역할로만 보낼 수 있다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    // 질문한 FE 담당은 지금 대상(BE)이 아니다.
    expect((await reroute(asked.id, await w.fe.token(), { targetRole: 'PM' })).json.error?.code).toBe('NOT_QUESTION_TARGET');
    const same = await reroute(asked.id, await w.be.token(), { targetRole: 'BACKEND' });
    expect(same.status).toBe(422);
    expect(same.json.error).toMatchObject({ code: 'QUESTION_INVALID', details: [{ where: 'targetRole' }] });
    expect((await reroute(asked.id, await w.be.token(), { targetRole: 'QA' })).status).toBe(400);

    await http('POST', `/questions/${asked.id}/answer`, await w.be.token(), { answers: { [Q1.question]: '20개' } });
    expect((await reroute(asked.id, await w.rep.token(), { targetRole: 'PM' })).json.error?.code).toBe('QUESTION_CLOSED');
    expect((await pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'QUESTION_REROUTED'`)).rows[0].n).toBe(0);
  });

  it('룸에는 넘긴 역할과 받은 역할 모두에 나온다', async () => {
    const w = await world();
    // 질문한 태스크가 FE라 FE 룸에는 원래 나온다 — 넘긴 쪽(BE 룸)에도 나오는지 본다. BE → PM으로 보내 FE와 겹치지 않게 한다.
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    await reroute(asked.id, await w.be.token(), { targetRole: 'PM', reason: '정책 결정' });
    await drainPmDrafts();
    const repToken = await w.rep.token();
    for (const role of ['BACKEND', 'FRONTEND']) {
      const feed = (await http('GET', `/projects/${w.projectId}/rooms/${role}/feed`, repToken)).json.data as { messages: { type: string; text: string; questionId: string | null }[] };
      const line = feed.messages.find((m) => m.type === 'QUESTION_REROUTED');
      expect(line, role).toMatchObject({ questionId: asked.id, text: 'BE 담당이 질문을 PM(대표)에게 다시 보냈습니다: 정책 결정' });
    }
  });
});
