import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { NomosClient } from '../src/bridge/nomos-client.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { createTask } from '../src/domain/authoring/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { clearPolicyCache } from '../src/domain/policy/policy-cache.js';
import { assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { setQuestionRouter } from '../src/domain/question/router-registry.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 에이전트 질문 중계(실험) — FE 에이전트가 BE 소관 결정을 물으면 BE 담당(또는 대표)이 답하고, 에이전트가 답을 읽는다.

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

// 대표, FE 담당, BE 담당. FE 태스크를 FE 에이전트가 잡은 상태까지.
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
  const task = await createTask(rep.userId, project.id, { title: 'T-1 멤버 목록 화면', teamRole: 'FRONTEND', kind: 'INTEGRATION', repoId: web!.id, specId: null, dependsOn: [] });
  const beTask = await createTask(rep.userId, project.id, { title: 'T-2 멤버 목록 API', teamRole: 'BACKEND', kind: 'INTEGRATION', repoId: api!.id, specId: null, dependsOn: [] });
  await startProject(repActor, project.id);

  const agentClient = async (refreshToken: string) =>
    new NomosClient({ baseUrl, tokens: { accessToken: (await refreshAgentToken(refreshToken)).accessToken, refreshToken } });
  const feClient = await agentClient(feAgent.refreshToken);
  await feClient.claimTask(task.id);
  const beClient = await agentClient(beAgent.refreshToken);
  await beClient.claimTask(beTask.id);
  return { orgId, projectId: project.id, taskId: task.id, beTaskId: beTask.id, rep, fe, be, feClient, beClient };
}

// NomosClient가 들고 있는 access token(직접 HTTP로 부를 때)
const agentToken = async (client: NomosClient) => (client as unknown as { tokens: { accessToken: string } }).tokens.accessToken;

const Q1 = { question: 'GET /api/studies/:id/members 의 응답 본문 형태는?', header: '응답 형태', multiSelect: false, options: [{ label: '{ members: [...] }' }, { label: '배열' }] };
const Q2 = { question: '가입일 필드 이름은?', header: '필드', multiSelect: false, options: [{ label: 'joinedAt' }, { label: 'joined_at' }] };

type Json = { data?: { id: string; status: string; targetRole: string; answers: Record<string, string> | null; questions: unknown[] } & { questions: { id: string }[] }; error?: { code: string; details?: { where: string }[] } };
async function http(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

describe('질문 올리기', () => {
  it('FE 에이전트가 물으면 대상은 BACKEND이고 QUESTION_ASKED가 남는다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1, Q2]);
    expect(asked).toMatchObject({ status: 'pending', targetRole: 'BACKEND', answers: null });
    const { rows } = await pool.query(`SELECT payload FROM events WHERE type = 'QUESTION_ASKED'`);
    expect(rows[0]!.payload).toMatchObject({ questionId: asked.id, taskId: w.taskId, askerRole: 'FRONTEND', targetRole: 'BACKEND', routedBy: 'role_rule:opposite', questionCount: 2 });
  });

  it('질문 형식 위반은 전부 모아 422로 돌려준다(중복 질문은 답의 키가 겹친다)', async () => {
    const w = await world();
    await expect(w.feClient.askQuestions(w.taskId, [Q1, Q1, { ...Q2, question: '' }])).rejects.toMatchObject({ code: 'QUESTION_INVALID' });
  });

  it('남의 태스크로는 물을 수 없다', async () => {
    const w = await world();
    await expect(w.beClient.askQuestions(w.taskId, [Q1])).rejects.toMatchObject({ code: 'NOT_TASK_ASSIGNEE' });
  });
});

describe('답하기', () => {
  it('BE 담당이 답하면 에이전트가 답을 읽는다 — 키는 질문 문장 그대로', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    const beToken = await w.be.token();

    const list = await http('GET', `/projects/${w.projectId}/questions`, beToken);
    expect(list.json.data!.questions.map((q) => q.id)).toEqual([asked.id]);

    const answered = await http('POST', `/questions/${asked.id}/answer`, beToken, { answers: { [Q1.question]: '{ members: [...] } — 공통 목록 형식' } });
    expect(answered.status).toBe(200);
    expect(answered.json.data).toMatchObject({ status: 'answered' });

    expect(await w.feClient.getQuestion(w.taskId, asked.id)).toMatchObject({ status: 'answered', answers: { [Q1.question]: '{ members: [...] } — 공통 목록 형식' } });
    const { rows } = await pool.query(`SELECT payload, on_behalf_of FROM events WHERE type = 'QUESTION_ANSWERED'`);
    expect(rows[0]).toMatchObject({ on_behalf_of: w.be.userId, payload: { questionId: asked.id, answeredByRole: 'TARGET_OWNER' } });
  });

  it('대상 역할이 아닌 사람(FE 담당)은 답할 수 없고, 대표는 답할 수 있다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    const fe = await http('POST', `/questions/${asked.id}/answer`, await w.fe.token(), { answers: { [Q1.question]: '배열' } });
    expect(fe.status).toBe(403);
    expect(fe.json.error!.code).toBe('NOT_QUESTION_TARGET');

    const rep = await http('POST', `/questions/${asked.id}/answer`, await w.rep.token(), { answers: { [Q1.question]: '배열' } });
    expect(rep.status).toBe(200);
    const { rows } = await pool.query(`SELECT payload FROM events WHERE type = 'QUESTION_ANSWERED'`);
    expect(rows[0]!.payload).toMatchObject({ answeredByRole: 'REPRESENTATIVE' });
  });

  it('키가 질문과 다르거나 빠지면 422 — 에이전트가 "답하지 않음"으로 받게 되기 때문이다(실험 E3)', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1, Q2]);
    const res = await http('POST', `/questions/${asked.id}/answer`, await w.be.token(), { answers: { [Q1.question]: '배열', '다른 질문': 'x' } });
    expect(res.status).toBe(422);
    expect(res.json.error!.code).toBe('QUESTION_INVALID');
    expect(res.json.error!.details!.map((d) => d.where).sort()).toEqual([Q2.question, '다른 질문'].sort());
  });

  it('두 번 답할 수 없다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    const token = await w.be.token();
    await http('POST', `/questions/${asked.id}/answer`, token, { answers: { [Q1.question]: '배열' } });
    const again = await http('POST', `/questions/${asked.id}/answer`, token, { answers: { [Q1.question]: '{ members }' } });
    expect(again.status).toBe(409);
    expect(again.json.error!.code).toBe('QUESTION_CLOSED');
  });
});

describe('BE → FE (반대 방향)', () => {
  // 라우팅은 "묻는 쪽의 반대 역할"이라 대칭이어야 한다 — BE가 화면 요구사항을 물으면 FE 담당이 답한다.
  it('BE 에이전트가 물으면 대상은 FRONTEND이고, FE 담당이 답하며 BE 담당은 답할 수 없다', async () => {
    const w = await world();
    const ask = { question: '멤버 목록 화면에 어떤 필드가 필요한가요?', header: '필드', multiSelect: true, options: [{ label: 'nickname' }, { label: 'avatarUrl' }, { label: 'joinedAt' }] };
    const asked = await w.beClient.askQuestions(w.beTaskId, [ask]);
    expect(asked).toMatchObject({ status: 'pending', targetRole: 'FRONTEND' });

    const be = await http('POST', `/questions/${asked.id}/answer`, await w.be.token(), { answers: { [ask.question]: 'nickname, joinedAt' } });
    expect(be.status).toBe(403);
    expect(be.json.error!.code).toBe('NOT_QUESTION_TARGET');

    const fe = await http('POST', `/questions/${asked.id}/answer`, await w.fe.token(), { answers: { [ask.question]: 'nickname, avatarUrl, joinedAt' } });
    expect(fe.status).toBe(200);
    expect(await w.beClient.getQuestion(w.beTaskId, asked.id)).toMatchObject({ status: 'answered', answers: { [ask.question]: 'nickname, avatarUrl, joinedAt' } });
    const { rows } = await pool.query(`SELECT payload, on_behalf_of FROM events WHERE type = 'QUESTION_ANSWERED'`);
    expect(rows[0]).toMatchObject({ on_behalf_of: w.fe.userId, payload: { targetRole: 'FRONTEND', answeredByRole: 'TARGET_OWNER' } });
  });
});

describe('질문 라우터 교체', () => {
  // 라우터는 바꿔 끼우며 비교하는 자리다 — 판정·확신도·대체 여부가 기록에 남아야 비교할 수 있다.
  afterEach(() => void setQuestionRouter(null));

  it('라우터가 고른 역할과 확신도·근거가 질문 기록과 이벤트에 남는다', async () => {
    const w = await world();
    setQuestionRouter({ name: 'fake-llm:v0', route: async () => ({ target: 'BACKEND', confidence: 0.82, reason: 'API 응답 형식', routedBy: 'fake-llm:v0' }) });
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    expect(asked).toMatchObject({ status: 'pending', targetRole: 'BACKEND', routedBy: 'fake-llm:v0', routing: { confidence: 0.82, reason: 'API 응답 형식', fallback: null } });
    const { rows } = await pool.query(`SELECT payload FROM events WHERE type = 'QUESTION_ASKED'`);
    expect(rows[0]!.payload).toMatchObject({ routedBy: 'fake-llm:v0', confidence: 0.82, fallback: null });
  });

  it('SELF면 넘기지 않고 self_owned로 돌려보낸다 — 아무도 답할 수 없다', async () => {
    const w = await world();
    setQuestionRouter({ name: 'fake', route: async () => ({ target: 'SELF', confidence: 0.9, reason: '화면 문구는 FE 소관', routedBy: 'fake' }) });
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    expect(asked).toMatchObject({ status: 'self_owned', targetRole: 'FRONTEND' });
    expect((await http('GET', `/projects/${w.projectId}/questions`, await w.be.token())).json.data!.questions).toEqual([]);
    const res = await http('POST', `/questions/${asked.id}/answer`, await w.rep.token(), { answers: { [Q1.question]: '배열' } });
    expect(res.status).toBe(409);
    const { rows } = await pool.query(`SELECT payload FROM events WHERE type = 'QUESTION_ASKED'`);
    expect(rows[0]!.payload).toMatchObject({ targetRole: 'SELF' });
  });

  it('라우터가 실패하면 규칙 라우터로 대체하고 그 사실을 남긴다', async () => {
    const w = await world();
    setQuestionRouter({ name: 'broken', route: async () => { throw new Error('model unavailable'); } });
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    expect(asked).toMatchObject({ status: 'pending', targetRole: 'BACKEND', routedBy: 'role_rule:opposite', routing: { fallback: 'broken: model unavailable' } });
  });
});

describe('C안 — 상담 초안·멈춤·재개', () => {
  const draftOf = (answers: Record<string, string>, decided: Record<string, boolean>) => ({ answers, decided, basis: {} });

  it('BE 에이전트는 상담할 질문과 읽을 레포를 받는다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    const jobs = await http('GET', '/agents/me/questions', await agentToken(w.beClient));
    expect(jobs.status).toBe(200);
    const data = jobs.json.data as unknown as { questions: { id: string }[]; repos: { fullName: string }[] };
    expect(data.questions.map((x) => x.id)).toEqual([asked.id]);
    expect(data.repos.map((r) => r.fullName)).toEqual(['acme/api']);
  });

  it('초안이 전부 decided면 곧 답이다(agent_answered) — 묻는 쪽이 바로 읽는다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1, Q2]);
    const drafted = await http('POST', `/questions/${asked.id}/draft`, await agentToken(w.beClient), draftOf({ [Q1.question]: '{ members }', [Q2.question]: 'joinedAt' }, { [Q1.question]: true, [Q2.question]: true }));
    expect(drafted.status).toBe(200);
    expect(await w.feClient.getQuestion(w.taskId, asked.id)).toMatchObject({ status: 'agent_answered', answers: { [Q1.question]: '{ members }', [Q2.question]: 'joinedAt' } });
    const { rows } = await pool.query(`SELECT payload FROM events WHERE type = 'QUESTION_DRAFTED'`);
    expect(rows[0]!.payload).toMatchObject({ decidedCount: 2, questionCount: 2, autoAnswered: true });
    // BE 목록에서도 사라진다(초안이 있으니)
    expect(((await http('GET', '/agents/me/questions', await agentToken(w.beClient))).json.data as unknown as { questions: unknown[] }).questions).toEqual([]);
  });

  it('하나라도 decided가 아니면 초안은 참고로 남고 사람이 답한다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1, Q2]);
    await http('POST', `/questions/${asked.id}/draft`, await agentToken(w.beClient), draftOf({ [Q1.question]: '{ members }', [Q2.question]: '제안: joinedAt' }, { [Q1.question]: true, [Q2.question]: false }));
    const pending = await w.feClient.getQuestion(w.taskId, asked.id);
    expect(pending).toMatchObject({ status: 'pending', answers: null });
    const res = await http('POST', `/questions/${asked.id}/answer`, await w.be.token(), { answers: { [Q1.question]: '{ members }', [Q2.question]: 'joinedAt' } });
    expect(res.json.data).toMatchObject({ status: 'answered' });
    expect(await w.feClient.getQuestion(w.taskId, asked.id)).toMatchObject({ status: 'answered' });
  });

  it('질문의 대상 역할 에이전트만 초안을 올린다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    const res = await http('POST', `/questions/${asked.id}/draft`, await agentToken(w.feClient), draftOf({ [Q1.question]: 'x' }, { [Q1.question]: true }));
    expect(res.status).toBe(403);
    expect(res.json.error!.code).toBe('NOT_QUESTION_TARGET');
  });

  it('사람은 에이전트 답을 확인(같은 답)하거나 뒤집는다(다른 답 — 고치는 태스크는 미구현으로 남긴다)', async () => {
    const w = await world();
    const beToken = await agentToken(w.beClient);
    const a1 = await w.feClient.askQuestions(w.taskId, [Q1]);
    await http('POST', `/questions/${a1.id}/draft`, beToken, draftOf({ [Q1.question]: '{ members }' }, { [Q1.question]: true }));
    const confirm = await http('POST', `/questions/${a1.id}/answer`, await w.be.token(), { answers: { [Q1.question]: '{ members }' } });
    expect(confirm.json.data).toMatchObject({ status: 'answered', answerSource: 'agent_confirmed' });

    const a2 = await w.feClient.askQuestions(w.taskId, [Q2]);
    await http('POST', `/questions/${a2.id}/draft`, beToken, draftOf({ [Q2.question]: 'joined_at' }, { [Q2.question]: true }));
    const override = await http('POST', `/questions/${a2.id}/answer`, await w.be.token(), { answers: { [Q2.question]: 'joinedAt' } });
    expect(override.json.data).toMatchObject({ status: 'answered', answerSource: 'human_override' });
    const { rows } = await pool.query(`SELECT payload FROM events WHERE type = 'QUESTION_ANSWERED' ORDER BY id`);
    expect(rows.map((r) => r.payload.source)).toEqual(['agent_confirmed', 'human_override']);
    expect(rows[1]!.payload).toMatchObject({ notice: 'REWORK_NOT_IMPLEMENTED' });
  });

  it('기다림을 포기하면 태스크가 BLOCKED(QUESTION)로 내려가고, 답이 오면 READY로 돌아가 브리핑에 받은 답이 실린다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    const detached = await http('POST', `/tasks/${w.taskId}/questions/${asked.id}/detach`, await agentToken(w.feClient));
    expect(detached.json.data).toMatchObject({ status: 'pending' });
    const blocked = await pool.query(`SELECT state, blocked_reason, assignee_agent_id FROM tasks WHERE id = $1`, [w.taskId]);
    expect(blocked.rows[0]).toEqual({ state: 'BLOCKED', blocked_reason: 'QUESTION', assignee_agent_id: null });

    const answered = await http('POST', `/questions/${asked.id}/answer`, await w.be.token(), { answers: { [Q1.question]: '{ members } — 공통 목록 형식' } });
    expect(answered.status).toBe(200);
    const ready = await pool.query(`SELECT state, blocked_reason FROM tasks WHERE id = $1`, [w.taskId]);
    expect(ready.rows[0]).toEqual({ state: 'READY', blocked_reason: null });
    const { rows } = await pool.query(`SELECT payload FROM events WHERE type = 'QUESTION_ANSWERED'`);
    expect(rows[0]!.payload).toMatchObject({ resumedTask: true, source: 'human' });

    // 같은 역할 에이전트가 다시 잡으면 브리핑에 받은 답이 있다.
    await w.feClient.claimTask(w.taskId);
    const briefing = (await w.feClient.getBriefing(w.taskId)) as { answeredQuestions: { question: string; answer: string; source: string }[] };
    expect(briefing.answeredQuestions).toEqual([{ question: Q1.question, answer: '{ members } — 공통 목록 형식', source: 'human' }]);
  });

  it('질문이 둘이면 둘 다 답이 와야 재개된다', async () => {
    const w = await world();
    const a1 = await w.feClient.askQuestions(w.taskId, [Q1]);
    const a2 = await w.feClient.askQuestions(w.taskId, [Q2]);
    await http('POST', `/tasks/${w.taskId}/questions/${a2.id}/detach`, await agentToken(w.feClient));
    const beToken = await w.be.token();
    await http('POST', `/questions/${a1.id}/answer`, beToken, { answers: { [Q1.question]: 'x' } });
    expect((await pool.query(`SELECT state FROM tasks WHERE id = $1`, [w.taskId])).rows[0]!.state).toBe('BLOCKED');
    await http('POST', `/questions/${a2.id}/answer`, beToken, { answers: { [Q2.question]: 'y' } });
    expect((await pool.query(`SELECT state FROM tasks WHERE id = $1`, [w.taskId])).rows[0]!.state).toBe('READY');
  });

  it('그 사이 답이 왔으면 포기해도 아무것도 바뀌지 않는다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    await http('POST', `/questions/${asked.id}/answer`, await w.be.token(), { answers: { [Q1.question]: 'x' } });
    const detached = await http('POST', `/tasks/${w.taskId}/questions/${asked.id}/detach`, await agentToken(w.feClient));
    expect(detached.json.data).toMatchObject({ status: 'answered' });
    expect((await pool.query(`SELECT state FROM tasks WHERE id = $1`, [w.taskId])).rows[0]!.state).toBe('CLAIMED');
  });

  it('멈춘 채 기간이 지나면 질문은 만료되고 태스크는 ESCALATED', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    await http('POST', `/tasks/${w.taskId}/questions/${asked.id}/detach`, await agentToken(w.feClient));
    await pool.query(`UPDATE agent_questions SET expires_at = now() - interval '1 second' WHERE id = $1`, [asked.id]);
    const list = await http('GET', `/projects/${w.projectId}/questions?status=all`, await w.be.token());
    expect(list.json.data!.questions[0]).toMatchObject({ status: 'expired' });
    expect((await pool.query(`SELECT state, blocked_reason FROM tasks WHERE id = $1`, [w.taskId])).rows[0]).toEqual({ state: 'ESCALATED', blocked_reason: null });
  });
});

describe('만료', () => {
  it('시간이 지나면 조회할 때 expired로 바뀌고, 그 뒤의 답은 받지 않는다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    await pool.query(`UPDATE agent_questions SET expires_at = now() - interval '1 second' WHERE id = $1`, [asked.id]);

    expect(await w.feClient.getQuestion(w.taskId, asked.id)).toMatchObject({ status: 'expired' });
    const { rows } = await pool.query(`SELECT on_behalf_of FROM events WHERE type = 'QUESTION_EXPIRED'`);
    expect(rows).toEqual([{ on_behalf_of: 'system:question-timeout' }]);

    const late = await http('POST', `/questions/${asked.id}/answer`, await w.be.token(), { answers: { [Q1.question]: '배열' } });
    expect(late.status).toBe(409);
  });

  it('다른 에이전트는 남의 질문을 읽지 못한다', async () => {
    const w = await world();
    const asked = await w.feClient.askQuestions(w.taskId, [Q1]);
    await expect(w.beClient.getQuestion(w.taskId, asked.id)).rejects.toMatchObject({ code: 'QUESTION_NOT_FOUND' });
  });
});
