import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { buildSubmitBody, writeBriefingNotes } from '../src/bridge/briefing-notes.js';
import { NomosApiError, NomosClient } from '../src/bridge/nomos-client.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { createSpec, createTask } from '../src/domain/authoring/service.js';
import { setQuestionRouter } from '../src/domain/question/router-registry.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { clearPolicyCache } from '../src/domain/policy/policy-cache.js';
import { assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 질문으로 정해진 결정 — 사람이 보는 조회 API, 다른 태스크의 브리핑, 제출 시 확인(DECISIONS_UNACKNOWLEDGED).
// 픽스처는 전부 서비스·HTTP를 거친다(질문 → 답은 실제 경로로 만든다).

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

// 대표, FE 담당, BE 담당. 같은 명세 F-1의 FE 태스크(T-1)와 BE 태스크(T-2)를 각 에이전트가 잡은 상태까지(questions.test.ts의 world와 같은 모양).
// 전달 범위를 보려고 잡지 않은 태스크를 더 둔다: 다른 명세(F-2)의 BE 태스크, 명세 없는 BE·FE 태스크.
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
  const list = await createSpec(rep.userId, project.id, { featureKey: 'F-1', title: '스터디 목록', content: '스터디 목록을 보여 준다.', tests: [] });
  const join = await createSpec(rep.userId, project.id, { featureKey: 'F-2', title: '스터디 참여', content: '스터디에 참여한다.', tests: [] });
  const task = await createTask(rep.userId, project.id, { title: 'T-1 스터디 목록 화면', teamRole: 'FRONTEND', kind: 'IMPLEMENT', repoId: web!.id, specId: list.id, dependsOn: [] });
  const beTask = await createTask(rep.userId, project.id, { title: 'T-2 스터디 목록 API', teamRole: 'BACKEND', kind: 'IMPLEMENT', repoId: api!.id, specId: list.id, dependsOn: [] });
  const otherSpecBeTask = await createTask(rep.userId, project.id, { title: 'T-3 스터디 참여 API', teamRole: 'BACKEND', kind: 'IMPLEMENT', repoId: api!.id, specId: join.id, dependsOn: [] });
  const noSpecBeTask = await createTask(rep.userId, project.id, { title: 'T-4 공통 오류 형식', teamRole: 'BACKEND', kind: 'INTEGRATION', repoId: api!.id, specId: null, dependsOn: [] });
  const noSpecFeTask = await createTask(rep.userId, project.id, { title: 'T-5 공통 레이아웃', teamRole: 'FRONTEND', kind: 'INTEGRATION', repoId: web!.id, specId: null, dependsOn: [] });
  await startProject(repActor, project.id);

  const agentClient = async (refreshToken: string) =>
    new NomosClient({ baseUrl, tokens: { accessToken: (await refreshAgentToken(refreshToken)).accessToken, refreshToken } });
  const feClient = await agentClient(feAgent.refreshToken);
  await feClient.claimTask(task.id);
  const beClient = await agentClient(beAgent.refreshToken);
  await beClient.claimTask(beTask.id);
  return {
    orgId,
    projectId: project.id,
    taskId: task.id,
    beTaskId: beTask.id,
    otherSpecBeTaskId: otherSpecBeTask.id,
    noSpecBeTaskId: noSpecBeTask.id,
    noSpecFeTaskId: noSpecFeTask.id,
    rep,
    fe,
    be,
    feClient,
    beClient,
    beAgentId: beAgent.agentId,
  };
}
type World = Awaited<ReturnType<typeof world>>;

const agentToken = (client: NomosClient) => (client as unknown as { tokens: { accessToken: string } }).tokens.accessToken;

const PAGE = { question: '스터디 목록 한 페이지 크기는?', header: '스터디 목록 페이지 크기', multiSelect: false, options: [{ label: '10개' }, { label: '20개' }] };
const SORT = { question: '스터디 목록 기본 정렬은?', header: '정렬', multiSelect: false, options: [{ label: '최신순' }, { label: '이름순' }] };
const FIELD = { question: '가입일 필드 이름은?', header: '필드', multiSelect: false, options: [{ label: 'joinedAt' }, { label: 'joined_at' }] };
const LAYOUT = { question: '목록 카드에 썸네일을 보여 주나?', options: [{ label: '예' }, { label: '아니오' }] };

type Json = { data?: Record<string, unknown>; error?: { code: string } };
async function http(method: string, urlPath: string, token: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}/api${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

// FE가 묻고 BE 담당(사람)이 답한다 — 확정된 결정.
async function feAsksBeDecides(w: World, questions: { question: string }[], answers: Record<string, string>): Promise<string> {
  const asked = await w.feClient.askQuestions(w.taskId, questions);
  const res = await http('POST', `/questions/${asked.id}/answer`, await w.be.token(), { answers });
  expect(res.status).toBe(200);
  return asked.id;
}

// FE가 묻고 BE 에이전트의 상담 실행이 코드에서 답을 찾았다(agent_answered) — 확정된 결정이 아니다.
async function feAsksAgentFinds(w: World, q: { question: string }, answer: string): Promise<string> {
  const asked = await w.feClient.askQuestions(w.taskId, [q]);
  await w.beClient.submitDraft(asked.id, { answers: { [q.question]: answer }, decided: { [q.question]: true }, basis: {} });
  return asked.id;
}

type Decision = Record<string, unknown> & { id: string; questionId: string; question: string; answer: string | null; summary: string };
const decisionsOf = (res: { json: Json }) => (res.json.data as { decisions: Decision[] }).decisions;
const eventCount = async () => (await pool.query(`SELECT count(*)::int AS n FROM events`)).rows[0].n as number;

describe('GET /projects/:projectId/decisions', () => {
  it('사람 답·에이전트 답·뒤집은 답을 한 줄씩, 누가 정했는지와 요약을 함께 낸다 — 최신순', async () => {
    const w = await world();
    const human = await feAsksBeDecides(w, [PAGE], { [PAGE.question]: '20개' });
    const agent = await feAsksAgentFinds(w, FIELD, 'joinedAt');
    // 에이전트가 찾은 답을 대표가 뒤집는다(human_override) — draftAnswer와 answer가 다르다.
    const overridden = await feAsksAgentFinds(w, SORT, '이름순');
    await http('POST', `/questions/${overridden}/answer`, await w.rep.token(), { answers: { [SORT.question]: '최신순' } });

    const res = await http('GET', `/projects/${w.projectId}/decisions`, await w.rep.token());
    expect(res.status).toBe(200);
    const list = decisionsOf(res);
    expect(list.map((d) => d.questionId)).toEqual([overridden, agent, human]);

    expect(list[2]).toMatchObject({
      taskId: w.taskId,
      taskTitle: 'T-1 스터디 목록 화면',
      askerRole: 'FRONTEND',
      askedByAgentName: 'fe-mbp',
      targetRole: 'BACKEND',
      question: PAGE.question,
      header: PAGE.header,
      options: ['10개', '20개'],
      multiSelect: false,
      answer: '20개',
      answerSource: 'human',
      decidedBy: { kind: 'user', userId: w.be.userId, nickname: 'be', isRepresentative: false },
      draftAnswer: null,
      status: 'answered',
      summary: 'FE가 물음 · BE 담당 be이 정함 — 스터디 목록 페이지 크기 → 20개',
    });
    expect(list[1]).toMatchObject({
      answer: 'joinedAt',
      answerSource: 'agent',
      status: 'agent_answered',
      decidedBy: { kind: 'agent', agentId: w.beAgentId, agentName: 'be-mbp' },
      summary: 'FE가 물음 · BE 에이전트 be-mbp가 코드에서 찾음 — 필드 → joinedAt',
    });
    expect(list[0]).toMatchObject({
      answer: '최신순',
      draftAnswer: '이름순',
      answerSource: 'human_override',
      decidedBy: { kind: 'user', userId: w.rep.userId, nickname: 'rep', isRepresentative: true },
    });
    expect(list[0]!.summary).toContain('대표 rep이 정함(에이전트 답을 바꿈)');
  });

  it('한 질문 행에 질문이 둘이면 두 줄이다(같은 questionId, 질문 순서대로)', async () => {
    const w = await world();
    const id = await feAsksBeDecides(w, [PAGE, SORT], { [PAGE.question]: '20개', [SORT.question]: '최신순' });
    const list = decisionsOf(await http('GET', `/projects/${w.projectId}/decisions`, await w.rep.token()));
    expect(list.map((d) => [d.id, d.questionId, d.question, d.answer])).toEqual([
      [`${id}:0`, id, PAGE.question, '20개'],
      [`${id}:1`, id, SORT.question, '최신순'],
    ]);
    // questionId는 겹치지만 id는 줄마다 유일하다 — 화면의 줄 키.
    expect(new Set(list.map((d) => d.id)).size).toBe(2);
  });

  it('기본은 답이 있는 것만, status=all이면 대기 중인 질문도 — 답은 null', async () => {
    const w = await world();
    const decided = await feAsksBeDecides(w, [PAGE], { [PAGE.question]: '20개' });
    const pending = await w.feClient.askQuestions(w.taskId, [SORT]);
    const rep = await w.rep.token();

    expect(decisionsOf(await http('GET', `/projects/${w.projectId}/decisions`, rep)).map((d) => d.questionId)).toEqual([decided]);
    const all = decisionsOf(await http('GET', `/projects/${w.projectId}/decisions?status=all`, rep));
    expect(all.map((d) => d.questionId).sort()).toEqual([decided, pending.id].sort());
    expect(all.find((d) => d.questionId === pending.id)).toMatchObject({
      status: 'pending',
      answer: null,
      answerSource: null,
      decidedBy: null,
      answeredAt: null,
      summary: 'FE가 물음 · BE 답 대기 — 정렬',
    });
  });

  it('role·taskId·limit으로 거른다', async () => {
    const w = await world();
    const fromFe = await feAsksBeDecides(w, [PAGE], { [PAGE.question]: '20개' });
    // BE가 묻고 FE 담당이 답한다.
    const fromBe = await w.beClient.askQuestions(w.beTaskId, [LAYOUT]);
    await http('POST', `/questions/${fromBe.id}/answer`, await w.fe.token(), { answers: { [LAYOUT.question]: '예' } });
    const rep = await w.rep.token();
    const ids = async (query: string) => decisionsOf(await http('GET', `/projects/${w.projectId}/decisions${query}`, rep)).map((d) => d.questionId);

    expect(await ids(`?taskId=${w.taskId}`)).toEqual([fromFe]);
    expect(await ids(`?taskId=${w.beTaskId}`)).toEqual([fromBe.id]);
    // role은 묻는 쪽 또는 답할 쪽 — 둘 다 FE·BE가 끼어 있다. PM이 낀 결정은 없다.
    expect(await ids('?role=BACKEND')).toEqual([fromBe.id, fromFe]);
    expect(await ids('?role=PM')).toEqual([]);
    expect(await ids('?limit=1')).toEqual([fromBe.id]);
  });

  it('볼 수 없는 사람은 403이고 TOOL_DENIED를 남기지 않는다, 에이전트 토큰은 401, 조회는 이벤트를 남기지 않는다', async () => {
    const w = await world();
    await feAsksBeDecides(w, [PAGE], { [PAGE.question]: '20개' });
    const outsider = await account('outsider');
    await createOrganization(outsider.userId, 'Other');

    const before = await eventCount();
    expect((await http('GET', `/projects/${w.projectId}/decisions`, await outsider.token())).status).toBe(403);
    expect((await http('GET', `/projects/${w.projectId}/decisions`, agentToken(w.feClient))).status).toBe(401);
    // 팀원은 자기 프로젝트의 결정을 본다.
    expect(decisionsOf(await http('GET', `/projects/${w.projectId}/decisions`, await w.fe.token()))).toHaveLength(1);
    expect(await eventCount()).toBe(before);
    expect((await pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'TOOL_DENIED'`)).rows[0].n).toBe(0);
  });
});

type BriefingDecision = { id: string; question: string; answer: string | null; askerRole: string; targetRole: string; decidedByName: string | null; answeredAt: string | null };
const briefingDecisions = async (client: NomosClient, taskId: string) => (await client.getBriefing(taskId)).decisions as BriefingDecision[];

describe('브리핑 decisions', () => {
  it('다른 태스크의 확정된 결정이 들어가고, 질문한 태스크 자신에는 들어가지 않는다', async () => {
    const w = await world();
    const id = await feAsksBeDecides(w, [PAGE, SORT], { [PAGE.question]: '20개', [SORT.question]: '최신순' });

    const be = await briefingDecisions(w.beClient, w.beTaskId);
    expect(be).toEqual([
      { id: `${id}:0`, question: PAGE.question, answer: '20개', askerRole: 'FRONTEND', targetRole: 'BACKEND', decidedByName: 'be', answeredAt: expect.any(String) },
      { id: `${id}:1`, question: SORT.question, answer: '최신순', askerRole: 'FRONTEND', targetRole: 'BACKEND', decidedByName: 'be', answeredAt: expect.any(String) },
    ]);
    // 질문한 태스크는 answeredQuestions로 받는다 — decisions에는 없다.
    expect(await briefingDecisions(w.feClient, w.taskId)).toEqual([]);
  });

  it('에이전트가 코드에서 찾은 답(agent_answered)과 대기 중인 질문은 들어가지 않는다', async () => {
    const w = await world();
    await feAsksAgentFinds(w, FIELD, 'joinedAt');
    await w.feClient.askQuestions(w.taskId, [SORT]);
    expect(await briefingDecisions(w.beClient, w.beTaskId)).toEqual([]);
  });
});

describe('제출 시 결정 확인', () => {
  const SHA = 'abc1234';
  const submit = (w: World, extra: { acknowledgedDecisionIds?: string[]; acknowledgedNoteIds?: string[] }) =>
    w.beClient.submitArtifact(w.beTaskId, { commitSha: SHA, changedPaths: ['src/studies.ts'], ...extra });
  const rejection = (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error('제출이 받아들여졌다');
      },
      (e: unknown) => e as NomosApiError,
    );
  const submittedPayload = async () =>
    (await pool.query(`SELECT payload FROM events WHERE type = 'ARTIFACT_SUBMITTED'`)).rows.map((r) => r.payload as Record<string, unknown>);

  it('브리핑 뒤 새 결정이 생기면 409 + 결정 전문 + 이벤트 — 재시도 횟수·TOOL_DENIED 없음, id를 넣어 다시 내면 받는다', async () => {
    const w = await world();
    expect(await briefingDecisions(w.beClient, w.beTaskId)).toEqual([]); // 시작할 때는 결정이 없었다
    const id = await feAsksBeDecides(w, [PAGE], { [PAGE.question]: '20개' });

    const err = await rejection(submit(w, { acknowledgedDecisionIds: [] }));
    expect(err).toMatchObject({ status: 409, code: 'DECISIONS_UNACKNOWLEDGED' });
    expect(err.details).toEqual({
      decisions: [{ id: `${id}:0`, question: PAGE.question, answer: '20개', askerRole: 'FRONTEND', targetRole: 'BACKEND', decidedByName: 'be', answeredAt: expect.any(String) }],
      notes: [],
    });
    // 모델은 err.message만 본다 — 결정 전문이 메시지에도 실린다.
    expect(err.message).toContain('20개');

    const required = await pool.query(`SELECT payload FROM events WHERE type = 'DECISIONS_ACK_REQUIRED'`);
    expect(required.rows.map((r) => r.payload)).toEqual([{ taskId: w.beTaskId, decisionIds: [`${id}:0`] }]);
    expect((await pool.query(`SELECT state, retry_count FROM tasks WHERE id = $1`, [w.beTaskId])).rows[0]).toEqual({ state: 'CLAIMED', retry_count: 0 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM artifacts`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'TOOL_DENIED'`)).rows[0].n).toBe(0);

    await expect(submit(w, { acknowledgedDecisionIds: [`${id}:0`] })).resolves.toMatchObject({ taskId: w.beTaskId });
    expect((await submittedPayload())[0]).toMatchObject({ acknowledgedDecisionIds: [`${id}:0`] });
    expect((await submittedPayload())[0]).not.toHaveProperty('decisionAck');
  });

  it('브리핑으로 받은 결정은 브릿지가 작업공간 파일에서 읽어 자동으로 확인한다', async () => {
    const w = await world();
    const id = await feAsksBeDecides(w, [PAGE, SORT], { [PAGE.question]: '20개', [SORT.question]: '최신순' });
    const dir = mkdtempSync(path.join(tmpdir(), 'nomos-decisions-'));
    try {
      // Executor가 하는 일: 브리핑의 결정 id를 작업공간 파일에 남긴다. MCP submit_artifact가 그 파일로 본문을 만든다.
      writeBriefingNotes(dir, w.beTaskId, [], (await briefingDecisions(w.beClient, w.beTaskId)).map((d) => d.id));
      const body = buildSubmitBody({ workspaceDir: dir, taskId: w.beTaskId, commitSha: SHA, changedPaths: ['src/studies.ts'] });
      expect(body.acknowledgedDecisionIds).toEqual([`${id}:0`, `${id}:1`]);
      await expect(w.beClient.submitArtifact(w.beTaskId, body)).resolves.toMatchObject({ taskId: w.beTaskId });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('필드 자체가 없는 옛 CLI(0.1.14 이하)는 확인을 건너뛰고 skipped_legacy_client를 남긴다', async () => {
    const w = await world();
    await feAsksBeDecides(w, [PAGE], { [PAGE.question]: '20개' });
    await expect(submit(w, {})).resolves.toMatchObject({ taskId: w.beTaskId });
    const payload = (await submittedPayload())[0]!;
    expect(payload.decisionAck).toBe('skipped_legacy_client');
    expect(payload).not.toHaveProperty('acknowledgedDecisionIds');
    expect((await pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'DECISIONS_ACK_REQUIRED'`)).rows[0].n).toBe(0);
  });

  it('노트와 결정이 둘 다 미확인이면 DECISIONS_UNACKNOWLEDGED 하나로 한 번에 알린다 — 두 이벤트가 다 남고, 둘 다 넣으면 받는다', async () => {
    const w = await world();
    const id = await feAsksBeDecides(w, [PAGE], { [PAGE.question]: '20개' });
    // FE가 DECIDED 노트를 낸다 — DECIDED는 프로젝트 전체에 전달되므로 BE 태스크도 확인해야 한다.
    const published = await w.feClient.publishNote(w.taskId, { kind: 'DECIDED', headline: '목록 응답은 20개씩', keyPoints: ['목록 화면은 20개씩 받는다'], affects: [] });
    const noteId = published.id as string;

    const err = await rejection(submit(w, { acknowledgedDecisionIds: [] }));
    expect(err.code).toBe('DECISIONS_UNACKNOWLEDGED');
    expect(err.details).toMatchObject({
      decisions: [expect.objectContaining({ id: `${id}:0` })],
      notes: [expect.objectContaining({ id: noteId, kind: 'DECIDED', headline: '목록 응답은 20개씩' })],
    });
    expect((await pool.query(`SELECT type FROM events WHERE type IN ('NOTES_ACK_REQUIRED', 'DECISIONS_ACK_REQUIRED') ORDER BY type`)).rows.map((r) => r.type)).toEqual([
      'DECISIONS_ACK_REQUIRED',
      'NOTES_ACK_REQUIRED',
    ]);

    // 결정만 확인하면 노트가 남아 예전 모양(NOTES_UNACKNOWLEDGED)으로 반려된다.
    expect((await rejection(submit(w, { acknowledgedDecisionIds: [`${id}:0`] }))).code).toBe('NOTES_UNACKNOWLEDGED');
    await expect(submit(w, { acknowledgedDecisionIds: [`${id}:0`], acknowledgedNoteIds: [noteId] })).resolves.toMatchObject({ taskId: w.beTaskId });
  });

  it('결정 id 형식이 틀려도 400으로 막지 않는다 — 모르는 id는 무시하고, 필요한 id가 다 있으면 받고 빠졌으면 409', async () => {
    const w = await world();
    const id = await feAsksBeDecides(w, [PAGE], { [PAGE.question]: '20개' });
    const err = await rejection(submit(w, { acknowledgedDecisionIds: ['garbage', 'not-a-uuid:x', `${id}:7`] }));
    expect(err).toMatchObject({ status: 409, code: 'DECISIONS_UNACKNOWLEDGED' });
    await expect(submit(w, { acknowledgedDecisionIds: ['garbage', `${id}:0`] })).resolves.toMatchObject({ taskId: w.beTaskId });
  });
});

describe('전달 범위 — PM 대상은 전부, FE·BE 대상은 같은 명세만', () => {
  afterEach(() => {
    setQuestionRouter(null);
  });
  const ids = async (client: NomosClient, taskId: string) => (await briefingDecisions(client, taskId)).map((d) => d.id);

  it('BE 대상 결정은 같은 명세의 다른 태스크에만 간다 — 다른 명세·명세 없는 태스크에는 브리핑에도 없고 제출도 409 없이 받는다', async () => {
    const w = await world();
    const id = await feAsksBeDecides(w, [PAGE], { [PAGE.question]: '20개' });

    expect(await ids(w.beClient, w.beTaskId)).toEqual([`${id}:0`]);
    expect(await ids(w.beClient, w.otherSpecBeTaskId)).toEqual([]);
    expect(await ids(w.beClient, w.noSpecBeTaskId)).toEqual([]);

    // 같은 명세(T-2)는 제출 때 확인을 요구받고, 다른 명세(T-3)는 받지 않는다.
    const sameSpec = await w.beClient.submitArtifact(w.beTaskId, { commitSha: 'abc1234', changedPaths: ['src/studies.ts'], acknowledgedDecisionIds: [] }).then(
      () => null,
      (e: unknown) => e as NomosApiError,
    );
    expect(sameSpec?.code).toBe('DECISIONS_UNACKNOWLEDGED');
    await w.beClient.claimTask(w.otherSpecBeTaskId);
    await expect(
      w.beClient.submitArtifact(w.otherSpecBeTaskId, { commitSha: 'abc1234', changedPaths: ['src/join.ts'], acknowledgedDecisionIds: [] }),
    ).resolves.toMatchObject({ taskId: w.otherSpecBeTaskId });
  });

  it('PM 대상 결정은 다른 명세·명세 없는 태스크에도 간다 — 질문한 태스크 자신만 빠진다', async () => {
    const w = await world();
    setQuestionRouter({ name: 'test:pm', route: async () => ({ target: 'PM', confidence: null, reason: '정책', routedBy: 'test:pm' }) });
    const asked = await w.feClient.askQuestions(w.taskId, [SORT]);
    expect(asked.targetRole).toBe('PM');
    expect((await http('POST', `/questions/${asked.id}/answer`, await w.rep.token(), { answers: { [SORT.question]: '최신순' } })).status).toBe(200);

    for (const taskId of [w.beTaskId, w.otherSpecBeTaskId, w.noSpecBeTaskId]) expect(await ids(w.beClient, taskId)).toEqual([`${asked.id}:0`]);
    expect(await ids(w.feClient, w.noSpecFeTaskId)).toEqual([`${asked.id}:0`]);
    expect(await ids(w.feClient, w.taskId)).toEqual([]);
  });

  it('명세 없는 태스크가 BE에게 물은 결정은 어느 태스크에도 전달되지 않는다 — 조회 API에는 전부 나온다', async () => {
    const w = await world();
    await w.feClient.claimTask(w.noSpecFeTaskId);
    const asked = await w.feClient.askQuestions(w.noSpecFeTaskId, [FIELD]);
    expect((await http('POST', `/questions/${asked.id}/answer`, await w.be.token(), { answers: { [FIELD.question]: 'joinedAt' } })).status).toBe(200);
    const sameSpec = await feAsksBeDecides(w, [PAGE], { [PAGE.question]: '20개' });

    for (const taskId of [w.beTaskId, w.otherSpecBeTaskId, w.noSpecBeTaskId]) {
      expect(await ids(w.beClient, taskId)).not.toContain(`${asked.id}:0`);
    }
    expect(await ids(w.feClient, w.taskId)).toEqual([]);
    // 사람은 범위 제한 없이 전부 본다.
    const all = decisionsOf(await http('GET', `/projects/${w.projectId}/decisions`, await w.rep.token())).map((d) => d.id);
    expect(all.sort()).toEqual([`${asked.id}:0`, `${sameSpec}:0`].sort());
  });
});
