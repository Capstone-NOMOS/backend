import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { NomosClient } from '../src/bridge/nomos-client.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { createSpec, createTask } from '../src/domain/authoring/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { clearPolicyCache } from '../src/domain/policy/policy-cache.js';
import { setPmModel, type PmModelResponse } from '../src/domain/pm/model.js';
import { drainPmJobs } from '../src/domain/pm/service.js';
import { assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { drainPmDrafts } from '../src/domain/question/pm-draft.js';
import { setQuestionRouter } from '../src/domain/question/router-registry.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { gitMirrorInspector, setCommitInspector } from '../src/domain/verification/commit-inspector.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 받은 편지함 — 알림(일어난 일, events에서 계산)과 처리할 일(지금 상태에서 계산).
// 픽스처는 전부 서비스·HTTP를 거친다(완료·질문·답·계약·계획은 실제 경로로 만든다).

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

afterEach(() => {
  setCommitInspector(gitMirrorInspector());
  setQuestionRouter(null);
  setPmModel(null);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

const PASSWORD = 'correct-horse-battery';

async function account(loginId: string, nickname: string) {
  const { userId, connectKey } = await signup({ loginId, password: PASSWORD, nickname });
  return { userId, connectKey, token: async () => (await login({ loginId, password: PASSWORD })).accessToken };
}
type Account = Awaited<ReturnType<typeof account>>;

// 대표, FE 담당(지수), BE 담당(민수), 역할 없는 팀원. 같은 명세의 FE·BE 구현 태스크와 명세 없는 FE 태스크. 시작한 상태.
// repOwnsFrontend: FE 역할을 대표가 맡는다(대표이면서 담당).
async function world(options: { repOwnsFrontend?: boolean } = {}) {
  const rep = await account('rep', '대표');
  const fe = await account('fe', '지수');
  const be = await account('be', '민수');
  const idle = await account('idle', '한가');
  const { orgId } = await createOrganization(rep.userId, 'Acme');
  for (const u of [fe, be, idle]) {
    const { token } = await createInvite(orgId, rep.userId);
    await acceptInvite(token, u.userId);
  }
  const [web, api] = await connectRepos({
    orgId,
    actorUserId: rep.userId,
    actorOrgRole: 'REPRESENTATIVE',
    repos: [{ fullName: 'acme/web', ownerRole: 'FRONTEND' }, { fullName: 'acme/api', ownerRole: 'BACKEND' }],
  });
  const { project } = await createProject(orgId, rep.userId, { name: '스터디', autonomyPreset: 'L2', pmBudgetUsd: 5, repoIds: [web!.id, api!.id] });
  const repActor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' as const };
  const feOwner = options.repOwnsFrontend ? rep : fe;
  const feAgent = await connectAgent({ connectKey: feOwner.connectKey, agentName: 'fe-mbp', harness: 'test', skills: [], maxConcurrent: 1 });
  const beAgent = await connectAgent({ connectKey: be.connectKey, agentName: 'be-mbp', harness: 'test', skills: [], maxConcurrent: 1 });
  await assignMember(repActor, project.id, feAgent.agentId, 'FRONTEND');
  await assignMember(repActor, project.id, beAgent.agentId, 'BACKEND');
  const spec = await createSpec(rep.userId, project.id, { featureKey: 'F-1', title: '스터디 목록', content: '스터디 목록을 보여 준다.', tests: [] });
  const feTask = await createTask(rep.userId, project.id, { title: '목록 화면', teamRole: 'FRONTEND', kind: 'IMPLEMENT', repoId: web!.id, specId: spec.id, dependsOn: [] });
  const beTask = await createTask(rep.userId, project.id, { title: '목록 API', teamRole: 'BACKEND', kind: 'IMPLEMENT', repoId: api!.id, specId: spec.id, dependsOn: [] });
  const layoutTask = await createTask(rep.userId, project.id, { title: '공통 레이아웃', teamRole: 'FRONTEND', kind: 'INTEGRATION', repoId: web!.id, specId: null, dependsOn: [] });
  await startProject(repActor, project.id);

  const agentClient = async (refreshToken: string) =>
    new NomosClient({ baseUrl, tokens: { accessToken: (await refreshAgentToken(refreshToken)).accessToken, refreshToken } });
  return {
    orgId,
    projectId: project.id,
    feTaskId: feTask.id,
    beTaskId: beTask.id,
    layoutTaskId: layoutTask.id,
    rep,
    fe,
    be,
    idle,
    feAgentId: feAgent.agentId,
    beAgentId: beAgent.agentId,
    feClient: await agentClient(feAgent.refreshToken),
    beClient: await agentClient(beAgent.refreshToken),
  };
}
type World = Awaited<ReturnType<typeof world>>;

type Notification = { id: string; type: string; read: boolean; taskId: string | null; questionId: string | null; role: string | null; text: string; projectName: string };
type InboxItem = { kind: string; approvalId: string | null; questionId: string | null; contractId: string | null; planId: string | null; taskId: string | null; role: string | null; text: string };
type Json = { data?: Record<string, unknown>; error?: { code: string } };

async function http(method: string, urlPath: string, token: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}/api${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

async function notifications(who: Account, query = ''): Promise<{ notifications: Notification[]; unreadCount: number }> {
  const res = await http('GET', `/me/notifications${query}`, await who.token());
  expect(res.status).toBe(200);
  return res.json.data as unknown as { notifications: Notification[]; unreadCount: number };
}

async function inbox(who: Account): Promise<{ items: InboxItem[]; counts: Record<string, number> }> {
  const res = await http('GET', '/me/inbox', await who.token());
  expect(res.status).toBe(200);
  return res.json.data as unknown as { items: InboxItem[]; counts: Record<string, number> };
}

const kinds = async (who: Account) => (await inbox(who)).items.map((i) => i.kind);
const types = async (who: Account) => (await notifications(who)).notifications.map((n) => n.type);

// 수령 → 제출 → V2·V4 보고. L2에서 migrations/**는 HUMAN(승인 대기), src/**는 AUTO(검증만으로 완료).
async function submit(client: NomosClient, taskId: string, path: string, sha = 'abc1234'): Promise<{ taskState: string; approvalId?: string }> {
  await client.claimTask(taskId);
  const { id } = (await client.submitArtifact(taskId, { commitSha: sha, changedPaths: [path] })) as unknown as { id: string };
  await client.reportVerification(id, { stage: 'V2', result: 'SKIPPED', detail: { reason: '시험지 없음' } });
  return (await client.reportVerification(id, { stage: 'V4', result: 'SKIPPED', detail: { reason: 'lint 없음' } })) as unknown as {
    taskState: string;
    approvalId?: string;
  };
}

const PAGE = { question: '스터디 목록 한 페이지 크기는?', options: [{ label: '10개' }, { label: '20개' }] };
const SORT = { question: '기본 정렬은?', options: [{ label: '최신순' }, { label: '이름순' }] };

describe('알림 — 태스크 완료', () => {
  it('FE 태스크 최종 승인 → FE 담당·대표에게 task_done, BE 담당에게는 없다 — 1차 검토 승인은 알림이 아니다', async () => {
    const w = await world();
    const { approvalId } = await submit(w.feClient, w.feTaskId, 'migrations/020_x.sql');
    expect((await http('POST', `/approvals/${approvalId!}/approve`, await w.fe.token())).status).toBe(200);
    // 1차 검토 승인은 완료가 아니다.
    for (const who of [w.rep, w.fe, w.be]) expect(await types(who)).not.toContain('task_done');

    const final = (await http('GET', `/orgs/${w.orgId}/approvals?stage=final`, await w.rep.token())).json.data as unknown as { approvals: { id: string }[] };
    expect((await http('POST', `/approvals/${final.approvals[0]!.id}/approve`, await w.rep.token())).status).toBe(200);

    for (const who of [w.rep, w.fe]) {
      const done = (await notifications(who)).notifications.filter((n) => n.type === 'task_done');
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ taskId: w.feTaskId, role: 'FRONTEND', questionId: null, read: false, projectName: '스터디', text: '목록 화면 — 대표가 승인해 완료됐습니다' });
    }
    expect(await types(w.be)).not.toContain('task_done');
    expect(await types(w.idle)).toEqual([]);
  });

  it('검증만으로 완료·직접 완료도 task_done이다', async () => {
    const w = await world();
    expect((await submit(w.beClient, w.beTaskId, 'src/app.ts')).taskState).toBe('DONE');
    const beDone = (await notifications(w.be)).notifications;
    expect(beDone.map((n) => [n.type, n.text])).toEqual([['task_done', '목록 API — 검증을 통과해 완료됐습니다']]);
    expect(await types(w.fe)).toEqual([]);

    setCommitInspector({ kind: 'fake', async changedPaths() { return ['src/layout.tsx']; } });
    const manual = await http('POST', `/tasks/${w.layoutTaskId}/manual-completion`, await w.fe.token(), { commitSha: 'def5678', changedPaths: ['src/layout.tsx'] });
    expect(manual.status).toBe(200);
    expect((await notifications(w.fe)).notifications.map((n) => n.text)).toEqual(['공통 레이아웃 — FE 담당 지수가 직접 완료했습니다']);
    expect((await notifications(w.rep)).notifications.map((n) => n.taskId)).toEqual([w.layoutTaskId, w.beTaskId]);
  });
});

describe('알림 — 질문', () => {
  it('FE가 BE에게 물으면 BE 담당·대표에게 question_asked, BE가 답하면 FE 담당·대표에게 question_answered(답 요약)', async () => {
    const w = await world();
    await w.feClient.claimTask(w.feTaskId);
    const asked = await w.feClient.askQuestions(w.feTaskId, [PAGE, SORT]);

    for (const who of [w.be, w.rep]) {
      const [n] = (await notifications(who)).notifications;
      expect(n).toMatchObject({ type: 'question_asked', questionId: asked.id, taskId: w.feTaskId, role: 'BACKEND', text: 'FE 에이전트가 물었습니다 — 스터디 목록 한 페이지 크기는? 외 1개' });
    }
    expect(await types(w.fe)).toEqual([]);

    const answered = await http('POST', `/questions/${asked.id}/answer`, await w.be.token(), { answers: { [PAGE.question]: '20개', [SORT.question]: '최신순' } });
    expect(answered.status).toBe(200);
    for (const who of [w.fe, w.rep]) {
      const n = (await notifications(who)).notifications.find((x) => x.type === 'question_answered');
      expect(n).toMatchObject({ questionId: asked.id, role: 'FRONTEND', text: 'BE 담당 민수가 답했습니다 — 스터디 목록 한 페이지 크기는? → 20개 외 1개' });
    }
    expect(await types(w.be)).toEqual(['question_asked']);
    // 질문 내용·답 전체는 싣지 않는다(화면은 questionId로 질문 API를 읽는다).
    const raw = JSON.stringify((await notifications(w.fe)).notifications);
    expect(raw).not.toContain('최신순');
  });

  it('상담 초안이 그대로 답이 된 경우(agent_answered)도 question_answered다', async () => {
    const w = await world();
    await w.feClient.claimTask(w.feTaskId);
    const asked = await w.feClient.askQuestions(w.feTaskId, [PAGE]);
    await w.beClient.submitDraft(asked.id, { answers: { [PAGE.question]: '20개' }, decided: { [PAGE.question]: true }, basis: {} });
    const n = (await notifications(w.fe)).notifications.find((x) => x.type === 'question_answered');
    expect(n).toMatchObject({ questionId: asked.id, text: 'BE 에이전트가 코드에서 찾아 답했습니다 — 스터디 목록 한 페이지 크기는? → 20개' });
  });

  it('PM 대상 질문은 대표에게만, SELF(자기 소관)는 알림이 없다', async () => {
    const w = await world();
    await w.feClient.claimTask(w.feTaskId);
    setQuestionRouter({ name: 'test:self', route: async () => ({ target: 'SELF', confidence: null, reason: null, routedBy: 'test:self' }) });
    await w.feClient.askQuestions(w.feTaskId, [PAGE]);
    for (const who of [w.rep, w.fe, w.be]) expect(await types(who)).toEqual([]);

    setQuestionRouter({ name: 'test:pm', route: async () => ({ target: 'PM', confidence: null, reason: '정책', routedBy: 'test:pm' }) });
    const asked = await w.feClient.askQuestions(w.feTaskId, [SORT]);
    await drainPmDrafts();
    expect((await notifications(w.rep)).notifications).toMatchObject([{ type: 'question_asked', questionId: asked.id, role: 'PM' }]);
    expect(await types(w.fe)).toEqual([]);
    expect(await types(w.be)).toEqual([]);
  });
});

describe('알림 — 읽음 커서와 범위', () => {
  it('읽음 커서는 앞으로만 가고, 읽음은 events에 남지 않는다', async () => {
    const w = await world();
    await w.feClient.claimTask(w.feTaskId);
    await w.feClient.askQuestions(w.feTaskId, [PAGE]);
    await w.feClient.askQuestions(w.feTaskId, [SORT]);
    const before = await notifications(w.rep);
    expect(before.unreadCount).toBe(2);
    const [newest, older] = before.notifications;

    const eventsBefore = (await pool.query(`SELECT count(*)::int AS n FROM events`)).rows[0]!.n as number;
    const read = await http('POST', '/me/notifications/read', await w.rep.token(), { upToEventId: older!.id });
    expect(read.json.data).toEqual({ readUpToEventId: older!.id, unreadCount: 1 });
    expect((await notifications(w.rep)).notifications.map((n) => n.read)).toEqual([false, true]);

    // 더 작은 값은 무시(뒤로 가지 않는다).
    const back = await http('POST', '/me/notifications/read', await w.rep.token(), { upToEventId: '1' });
    expect(back.json.data).toEqual({ readUpToEventId: older!.id, unreadCount: 1 });
    // 없으면 지금 최신까지.
    expect((await http('POST', '/me/notifications/read', await w.rep.token())).json.data).toMatchObject({ unreadCount: 0 });
    expect((await notifications(w.rep)).notifications.every((n) => n.read)).toBe(true);
    expect((await pool.query(`SELECT count(*)::int AS n FROM events`)).rows[0]!.n).toBe(eventsBefore);

    // 다른 사람의 커서와는 무관하다.
    expect((await notifications(w.be)).unreadCount).toBe(2);
    // 더 보기(before).
    expect((await notifications(w.rep, `?limit=1&before=${newest!.id}`)).notifications.map((n) => n.id)).toEqual([older!.id]);
  });

  it('다른 조직·내 역할이 아닌 프로젝트·지운 프로젝트의 알림은 보이지 않는다', async () => {
    const w = await world();
    await w.feClient.claimTask(w.feTaskId);
    await w.feClient.askQuestions(w.feTaskId, [PAGE]);
    expect(await types(w.be)).toEqual(['question_asked']);
    expect(await types(w.idle)).toEqual([]);

    const rival = await account('rival', '경쟁');
    await createOrganization(rival.userId, 'Rival');
    expect(await types(rival)).toEqual([]);

    expect((await http('POST', `/projects/${w.projectId}/abort`, await w.rep.token(), {})).status).toBe(200);
    // 끝난 프로젝트의 알림은 남는다(일어난 일이다).
    expect(await types(w.be)).toEqual(['question_asked']);
    expect((await http('DELETE', `/projects/${w.projectId}`, await w.rep.token())).status).toBe(200);
    expect(await types(w.be)).toEqual([]);
    expect(await types(w.rep)).toEqual([]);
  });

  it('대표가 그 역할 담당이어도 알림은 한 번이다', async () => {
    const w = await world({ repOwnsFrontend: true });
    expect((await submit(w.feClient, w.feTaskId, 'src/list.tsx')).taskState).toBe('DONE');
    const list = (await notifications(w.rep)).notifications;
    expect(list.map((n) => [n.type, n.taskId])).toEqual([['task_done', w.feTaskId]]);
  });
});

describe('처리할 일 (GET /me/inbox)', () => {
  it('승인: 담당 1차 검토 → 대표 최종 → G3 — 처리하면 빠지고, 팀원에게 대표 전용 항목은 없다', async () => {
    const w = await world();
    // 다른 태스크는 취소해 이 승인이 마지막 완료가 되게 한다(G3).
    for (const id of [w.beTaskId, w.layoutTaskId]) {
      expect((await http('POST', `/tasks/${id}/cancel`, await w.rep.token(), { reason: '범위 밖' })).status).toBe(200);
    }
    const { approvalId } = await submit(w.feClient, w.feTaskId, 'migrations/020_x.sql');

    const feBox = await inbox(w.fe);
    expect(feBox.items).toMatchObject([{ kind: 'approval_role_review', approvalId, taskId: w.feTaskId, role: 'FRONTEND' }]);
    expect(feBox.counts).toMatchObject({ approval_role_review: 1, approval_final: 0 });
    expect(feBox.items[0]!.text).toContain('1차 검토를 기다립니다');
    // GET /me/approvals와 같은 선택.
    const mine = (await http('GET', '/me/approvals', await w.fe.token())).json.data as unknown as { approvals: { id: string }[] };
    expect(mine.approvals.map((a) => a.id)).toEqual([approvalId]);
    expect(await kinds(w.rep)).not.toContain('approval_role_review');

    await http('POST', `/approvals/${approvalId!}/approve`, await w.fe.token());
    expect(await kinds(w.fe)).toEqual([]);
    const repBox = await inbox(w.rep);
    const final = repBox.items.find((i) => i.kind === 'approval_final')!;
    expect(final.text).toBe('목록 화면 — 최종 승인을 기다립니다 (FE 담당 지수 1차 승인)');
    expect(await kinds(w.fe)).not.toContain('approval_final');

    await http('POST', `/approvals/${final.approvalId!}/approve`, await w.rep.token());
    const afterFinal = await inbox(w.rep);
    expect(afterFinal.items.map((i) => i.kind)).toEqual(['release']);
    expect(await kinds(w.fe)).toEqual([]);
    await http('POST', `/approvals/${afterFinal.items[0]!.approvalId!}/approve`, await w.rep.token());
    expect(await kinds(w.rep)).toEqual([]);
  });

  it('질문: 답할 사람(대상 역할 담당·대표)에게 생기고 답하면 빠진다', async () => {
    const w = await world();
    await w.feClient.claimTask(w.feTaskId);
    const asked = await w.feClient.askQuestions(w.feTaskId, [PAGE]);
    for (const who of [w.be, w.rep]) expect((await inbox(who)).items).toMatchObject([{ kind: 'question', questionId: asked.id, role: 'BACKEND' }]);
    expect(await kinds(w.fe)).toEqual([]);
    await http('POST', `/questions/${asked.id}/answer`, await w.be.token(), { answers: { [PAGE.question]: '20개' } });
    for (const who of [w.be, w.rep]) expect(await kinds(who)).toEqual([]);
  });

  it('계획·계약: PM 초안(실패·준비)은 대표에게, 계약 확정은 BE 담당에게 — 처리하면 빠진다', async () => {
    const w = await world();
    const replies: PmModelResponse[] = [
      { stopReason: 'refusal', servedModel: 'claude-sonnet-5-5', text: '', attempts: [] },
      { stopReason: 'end_turn', servedModel: 'claude-sonnet-5-5', text: JSON.stringify(FEATURE_DRAFT), attempts: [] },
    ];
    setPmModel({ kind: 'fake', generate: async () => replies.shift()! });

    const failed = await http('POST', `/projects/${w.projectId}/pm/features`, await w.rep.token(), { instruction: '멤버 목록' });
    await drainPmJobs();
    expect((await inbox(w.rep)).items).toMatchObject([{ kind: 'plan', planId: (failed.json.data as { id: string }).id }]);
    expect((await inbox(w.rep)).items[0]!.text).toContain('실패');
    expect(await kinds(w.be)).toEqual([]);

    // 다시 요청하면 실패한 초안은 지나간 일이다 — 새 초안(준비)만 남는다.
    const ready = await http('POST', `/projects/${w.projectId}/pm/features`, await w.rep.token(), { instruction: '멤버 목록' });
    await drainPmJobs();
    const planId = (ready.json.data as { id: string }).id;
    expect((await inbox(w.rep)).items).toMatchObject([{ kind: 'plan', planId }]);
    expect((await http('POST', `/projects/${w.projectId}/pm/plans/${planId}/apply`, await w.rep.token())).status).toBe(200);
    expect(await kinds(w.rep)).toEqual([]);

    // 확정하면 API 계약이 작성 대기 → BE 에이전트가 초안을 내면 BE 담당이 확정할 일.
    const jobs = await w.beClient.listContractJobs();
    const job = (jobs as unknown as { contracts: { id: string; attempt: number }[] }).contracts[0]!;
    await w.beClient.submitContractDraft(job.id, { attempt: job.attempt, openapiYaml: CONTRACT_YAML, summary: '멤버 목록', openQuestions: [] });
    expect((await inbox(w.be)).items).toMatchObject([{ kind: 'contract', contractId: job.id, role: 'BACKEND' }]);
    // BE 담당이 있으면 대표는 확정할 수 없다(확정 API와 같은 판정).
    expect(await kinds(w.rep)).toEqual([]);
    expect(await kinds(w.fe)).toEqual([]);
    expect((await http('POST', `/contracts/${job.id}/approve`, await w.be.token())).status).toBe(200);
    expect(await kinds(w.be)).toEqual([]);
  });

  it('멈춘 태스크는 대표에게(재개하면 빠진다), 에이전트가 없는 내 역할은 그 담당에게', async () => {
    const w = await world();
    await w.beClient.startRun(w.beTaskId);
    await w.beClient.claimTask(w.beTaskId);
    await w.beClient.endRun(w.beTaskId, { outcome: 'completed', committed: false, durationMs: 1000, exitCode: 0 });
    expect((await inbox(w.rep)).items).toMatchObject([{ kind: 'stuck_task', taskId: w.beTaskId, agentId: w.beAgentId }]);
    expect(await kinds(w.be)).toEqual([]);
    expect((await http('POST', `/tasks/${w.beTaskId}/resume`, await w.rep.token(), {})).status).toBe(200);
    expect(await kinds(w.rep)).toEqual([]);

    expect((await http('DELETE', `/agents/${w.beAgentId}`, await w.be.token())).status).toBe(200);
    expect((await inbox(w.be)).items).toMatchObject([{ kind: 'agent_needed', role: 'BACKEND' }]);
    expect(await kinds(w.rep)).toEqual([]);
    expect(await kinds(w.fe)).toEqual([]);
  });

  it('끝난·지운 프로젝트의 일은 없다', async () => {
    const w = await world();
    await w.feClient.claimTask(w.feTaskId);
    await w.feClient.askQuestions(w.feTaskId, [PAGE]);
    expect(await kinds(w.rep)).toEqual(['question']);
    expect((await http('POST', `/projects/${w.projectId}/abort`, await w.rep.token(), {})).status).toBe(200);
    expect(await kinds(w.rep)).toEqual([]);
    expect(await kinds(w.be)).toEqual([]);
  });
});

const FEATURE_DRAFT = {
  summary: '스터디 멤버 목록',
  assumptions: [],
  features: [
    {
      featureKey: 'F-20',
      title: '스터디 멤버 목록',
      description: '스터디 상세 화면 아래에 멤버 목록이 보인다.',
      acceptance: ['멤버가 있으면 닉네임이 보인다'],
      needsApi: true,
      apiNeeds: '스터디의 멤버 목록',
    },
  ],
};

const CONTRACT_YAML = `paths:
  /api/studies/{studyId}/members:
    get:
      responses:
        '200':
          description: 멤버 목록
`;
