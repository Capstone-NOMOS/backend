import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { createTask } from '../src/domain/authoring/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 해제·삭제(021) — 에이전트 연결 해제, 조직에서 내보내기·탈퇴, 시작 뒤 멤버 교체, 레포 연결 해제, 초대 취소.
// 공통 규칙: 행은 지우지 않는다(기록이 가리킨다). 진행 중 태스크를 붙잡은 에이전트는 빼지 않는다(409 ACTIVE_TASKS_HELD).

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
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

type Res = { status: number; data: Record<string, unknown>; error?: { code: string; details?: unknown } };

async function http(method: string, path: string, token: string | null, body?: unknown): Promise<Res> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
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

const spec = (name: string) => ({ agentName: name, harness: 'claude-code', skills: [], maxConcurrent: 1 });

// 대표·BE 팀원·FE 팀원, 레포 하나(** = BACKEND), 프로젝트 하나(BE 배정, 태스크 하나).
async function world(options: { started?: boolean } = {}) {
  const rep = await account('rep');
  const { orgId } = await createOrganization(rep.userId, 'Acme');
  const be = await account('be');
  const fe = await account('fe');
  for (const u of [be, fe]) {
    const { token } = await createInvite(orgId, rep.userId);
    await acceptInvite(token, u.userId);
  }
  const actor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' as const };
  const [repo] = await connectRepos({ orgId, actorUserId: rep.userId, actorOrgRole: 'REPRESENTATIVE', repos: [{ fullName: 'acme/api', ownerRole: 'BACKEND' }] });
  const { project } = await createProject(orgId, rep.userId, { name: 'p', autonomyPreset: 'L2', pmBudgetUsd: 1, repoIds: [repo!.id] });
  const beAgent = await connectAgent({ connectKey: be.connectKey, ...spec('be-laptop') });
  const feAgent = await connectAgent({ connectKey: fe.connectKey, ...spec('fe-laptop') });
  await assignMember(actor, project.id, beAgent.agentId, 'BACKEND');
  const task = await createTask(rep.userId, project.id, { title: 'T-1', teamRole: 'BACKEND', kind: 'INTEGRATION', repoId: repo!.id, specId: null, dependsOn: [] });
  if (options.started) await startProject(actor, project.id);
  return { rep, be, fe, orgId, actor, repoId: repo!.id, projectId: project.id, taskId: task.id, beAgent, feAgent };
}

const agentToken = async (refreshToken: string) => (await refreshAgentToken(refreshToken)).accessToken;

describe('에이전트 연결 해제 (DELETE /agents/:agentId)', () => {
  it('주인이 끊으면 토큰이 거부되고 목록에서 빠진다 — 같은 노트북 이름으로 다시 connect하면 되살아난다', async () => {
    const w = await world();
    const before = await agentToken(w.feAgent.refreshToken);
    const res = await http('DELETE', `/agents/${w.feAgent.agentId}`, w.fe.token);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ agentId: w.feAgent.agentId, unassignedFrom: null });

    // 남은 access token은 거부, refresh token은 폐기
    const me = await http('GET', '/agents/me', before);
    expect(me).toMatchObject({ status: 401, error: { code: 'AGENT_DISCONNECTED' } });
    await expect(refreshAgentToken(w.feAgent.refreshToken)).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
    const listed = (await http('GET', `/orgs/${w.orgId}/agents`, w.rep.token)).data.agents as { agentId: string }[];
    expect(listed.map((a) => a.agentId)).not.toContain(w.feAgent.agentId);
    // 두 번 끊으면 404
    expect((await http('DELETE', `/agents/${w.feAgent.agentId}`, w.fe.token)).status).toBe(404);

    // 같은 이름으로 다시 연결 → 같은 에이전트가 되살아난다
    const again = await connectAgent({ connectKey: w.fe.connectKey, ...spec('fe-laptop') });
    expect(again.agentId).toBe(w.feAgent.agentId);
    const relisted = (await http('GET', `/orgs/${w.orgId}/agents`, w.rep.token)).data.agents as { agentId: string }[];
    expect(relisted.map((a) => a.agentId)).toContain(w.feAgent.agentId);

    const { rows } = await testPool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'AGENT_DISCONNECTED'`);
    expect(rows).toEqual([{ on_behalf_of: w.fe.userId, payload: expect.objectContaining({ agentId: w.feAgent.agentId, byOwner: true }) }]);
  });

  it('대표는 멤버의 에이전트를 끊을 수 있다 — 시작한 프로젝트 배정도 함께 풀린다. 다른 멤버는 403', async () => {
    const w = await world({ started: true });
    expect((await http('DELETE', `/agents/${w.beAgent.agentId}`, w.fe.token))).toMatchObject({ status: 403, error: { code: 'NOT_AGENT_OWNER' } });

    const res = await http('DELETE', `/agents/${w.beAgent.agentId}`, w.rep.token);
    expect(res).toMatchObject({ status: 200, data: { unassignedFrom: w.projectId } });
    const members = (await http('GET', `/projects/${w.projectId}`, w.rep.token)).data.members as unknown[];
    expect(members).toEqual([]);
    const { rows } = await testPool.query(`SELECT payload FROM events WHERE type = 'MEMBER_UNASSIGNED'`);
    expect(rows[0]!.payload).toMatchObject({ agentId: w.beAgent.agentId, cause: 'agent_disconnected' });
  });

  it('진행 중 태스크를 붙잡고 있으면 409 ACTIVE_TASKS_HELD(태스크 목록) — 연결은 그대로', async () => {
    const w = await world({ started: true });
    const token = await agentToken(w.beAgent.refreshToken);
    expect((await http('POST', `/tasks/${w.taskId}/claim`, token)).status).toBe(200);
    const res = await http('DELETE', `/agents/${w.beAgent.agentId}`, w.be.token);
    expect(res).toMatchObject({ status: 409, error: { code: 'ACTIVE_TASKS_HELD', details: [{ taskId: w.taskId, state: 'CLAIMED' }] } });
    expect((await http('GET', '/agents/me', token)).status).toBe(200);
  });
});

describe('시작 뒤 멤버 교체 (021)', () => {
  it('진행 중 태스크가 없으면 시작 뒤에도 빼고, 다른 에이전트를 같은 역할에 배정할 수 있다', async () => {
    const w = await world({ started: true });
    expect((await http('DELETE', `/projects/${w.projectId}/members/${w.beAgent.agentId}`, w.rep.token)).status).toBe(200);
    const res = await http('POST', `/projects/${w.projectId}/members`, w.rep.token, { agentId: w.feAgent.agentId, teamRole: 'BACKEND' });
    expect(res.status).toBe(201);
    // 새 담당이 그 역할 태스크를 가져간다(배정 뒤 재발급)
    const token = await agentToken(w.feAgent.refreshToken);
    expect((await http('POST', `/tasks/${w.taskId}/claim`, token)).status).toBe(200);
  });

  it('진행 중 태스크를 붙잡은 멤버는 뺄 수 없다', async () => {
    const w = await world({ started: true });
    await http('POST', `/tasks/${w.taskId}/claim`, await agentToken(w.beAgent.refreshToken));
    const res = await http('DELETE', `/projects/${w.projectId}/members/${w.beAgent.agentId}`, w.rep.token);
    expect(res).toMatchObject({ status: 409, error: { code: 'ACTIVE_TASKS_HELD' } });
  });
});

describe('조직에서 내보내기·탈퇴 (DELETE /orgs/:orgId/members/:userId)', () => {
  it('대표가 내보내면 계정은 남고 조직만 비며, 에이전트는 배정이 풀리고 연결이 끊긴다 — 다른 조직에 다시 들어갈 수 있다', async () => {
    const w = await world({ started: true });
    const beToken = await agentToken(w.beAgent.refreshToken);
    const res = await http('DELETE', `/orgs/${w.orgId}/members/${w.be.userId}`, w.rep.token);
    expect(res).toMatchObject({ status: 200, data: { userId: w.be.userId, agentIds: [w.beAgent.agentId], unassignedFrom: [w.projectId] } });

    expect((await http('GET', '/me', w.be.token)).data).toMatchObject({ orgId: null, orgRole: null });
    expect((await http('GET', '/agents/me', beToken)).error?.code).toBe('AGENT_DISCONNECTED');
    const members = (await http('GET', `/orgs/${w.orgId}/members`, w.rep.token)).data.members as { userId: string }[];
    expect(members.map((m) => m.userId)).not.toContain(w.be.userId);

    // 다른 조직의 초대를 받을 수 있다
    const other = await account('other-rep');
    const { orgId: otherOrg } = await createOrganization(other.userId, 'Other');
    const { token } = await createInvite(otherOrg, other.userId);
    expect((await http('POST', `/invites/${token}/accept`, w.be.token)).status).toBe(200);
    expect((await http('GET', '/me', w.be.token)).data).toMatchObject({ orgId: otherOrg, orgRole: 'MEMBER' });
  });

  it('멤버는 스스로 나갈 수 있고, 남을 내보낼 수는 없다. 대표는 나갈 수 없다', async () => {
    const w = await world();
    expect((await http('DELETE', `/orgs/${w.orgId}/members/${w.fe.userId}`, w.be.token))).toMatchObject({ status: 403, error: { code: 'NOT_REPRESENTATIVE' } });
    expect((await http('DELETE', `/orgs/${w.orgId}/members/${w.rep.userId}`, w.rep.token))).toMatchObject({ status: 409, error: { code: 'REPRESENTATIVE_CANNOT_LEAVE' } });
    expect((await http('DELETE', `/orgs/${w.orgId}/members/${w.fe.userId}`, w.fe.token)).status).toBe(200);
    const { rows } = await testPool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'ORG_MEMBER_REMOVED'`);
    expect(rows).toEqual([{ on_behalf_of: w.fe.userId, payload: expect.objectContaining({ userId: w.fe.userId, self: true }) }]);
  });

  it('진행 중 태스크를 붙잡은 멤버는 내보낼 수 없다 — 아무것도 바뀌지 않는다', async () => {
    const w = await world({ started: true });
    await http('POST', `/tasks/${w.taskId}/claim`, await agentToken(w.beAgent.refreshToken));
    expect((await http('DELETE', `/orgs/${w.orgId}/members/${w.be.userId}`, w.rep.token)).error?.code).toBe('ACTIVE_TASKS_HELD');
    expect((await http('GET', '/me', w.be.token)).data).toMatchObject({ orgId: w.orgId });
  });
});

describe('레포 연결 해제 (DELETE /repos/:repoId)', () => {
  it('진행 중 프로젝트가 쓰면 409, 아니면 해제 — 다시 연결하면 같은 행이 경로 규칙·소유권과 함께 되살아난다', async () => {
    const w = await world();
    expect((await http('DELETE', `/repos/${w.repoId}`, w.rep.token)).error?.code).toBe('REPO_IN_ACTIVE_PROJECT');

    const [spare] = await connectRepos({ orgId: w.orgId, actorUserId: w.rep.userId, actorOrgRole: 'REPRESENTATIVE', repos: [{ fullName: 'acme/web', ownerRole: 'FRONTEND' }] });
    expect((await http('DELETE', `/repos/${spare!.id}`, w.be.token)).status).toBe(403); // 대표 전용
    expect((await http('DELETE', `/repos/${spare!.id}`, w.rep.token))).toMatchObject({ status: 200, data: { repoId: spare!.id, fullName: 'acme/web' } });
    const listed = (await http('GET', `/orgs/${w.orgId}/repos`, w.rep.token)).data.repos as { id: string }[];
    expect(listed.map((r) => r.id)).not.toContain(spare!.id);
    expect((await http('GET', `/repos/${spare!.id}/paths`, w.rep.token)).error?.code).toBe('REPO_NOT_FOUND');

    const again = await http('POST', `/orgs/${w.orgId}/repos`, w.rep.token, { repos: [{ fullName: 'acme/web' }] });
    expect(again.status).toBe(201);
    expect((again.data.repos as { id: string; rootOwnerRole: string | null }[])[0]).toMatchObject({ id: spare!.id });
    const paths = (await http('GET', `/repos/${spare!.id}/paths`, w.rep.token)).data.paths as { pathPattern: string; ownerRole: string | null }[];
    expect(paths.find((p) => p.pathPattern === '**')?.ownerRole).toBe('FRONTEND');
    const { rows } = await testPool.query(`SELECT payload FROM events WHERE type = 'REPO_CONNECTED' ORDER BY id DESC LIMIT 1`);
    expect(rows[0]!.payload).toMatchObject({ repoId: spare!.id, revived: true, seededPathCount: 0 });
  });
});

describe('초대 목록·취소 (GET·DELETE /orgs/:orgId/invites)', () => {
  it('대기 중인 초대만 보이고, 취소하면 미리보기는 revoked·수락은 410이다. 쓰인 초대는 취소할 수 없다', async () => {
    const w = await world();
    const created = await http('POST', `/orgs/${w.orgId}/invites`, w.rep.token, { teamRole: 'FRONTEND' });
    const inviteId = created.data.inviteId as string;
    const token = created.data.token as string;
    const listed = (await http('GET', `/orgs/${w.orgId}/invites`, w.rep.token)).data.invites as { inviteId: string; expired: boolean }[];
    expect(listed.map((i) => i.inviteId)).toEqual([inviteId]); // be·fe가 쓴 초대는 빠진다
    expect((await http('GET', `/orgs/${w.orgId}/invites`, w.be.token)).status).toBe(403);

    expect((await http('DELETE', `/orgs/${w.orgId}/invites/${inviteId}`, w.rep.token)).status).toBe(200);
    expect((await http('GET', `/invites/${token}`, null)).data).toMatchObject({ valid: false, reason: 'revoked' });
    const newcomer = await account('newcomer');
    expect((await http('POST', `/invites/${token}/accept`, newcomer.token))).toMatchObject({ status: 410, error: { code: 'INVITE_REVOKED' } });
    expect((await http('GET', `/orgs/${w.orgId}/invites`, w.rep.token)).data.invites).toEqual([]);

    // 이미 쓰인 초대(be가 수락한 것)는 404
    const { rows } = await testPool.query(`SELECT id FROM invites WHERE used_by = $1`, [w.be.userId]);
    expect((await http('DELETE', `/orgs/${w.orgId}/invites/${rows[0]!.id as string}`, w.rep.token)).status).toBe(404);
  });
});

describe('프로젝트 중단 (POST /projects/:projectId/abort)', () => {
  it('중단하면 aborted로 닫히고 에이전트·레포가 풀린다 — 룸에 사유가 남고, 다시 중단하면 409', async () => {
    const w = await world({ started: true });
    const token = await agentToken(w.beAgent.refreshToken);
    expect((await http('POST', `/projects/${w.projectId}/abort`, w.be.token, {})).status).toBe(403); // 대표 전용

    const res = await http('POST', `/projects/${w.projectId}/abort`, w.rep.token, { reason: '범위가 바뀌었다' });
    expect(res).toMatchObject({ status: 200, data: { project: { id: w.projectId, status: 'aborted' } } });
    expect((await http('POST', `/projects/${w.projectId}/abort`, w.rep.token, {})).error?.code).toBe('PROJECT_NOT_OPEN');

    // 에이전트는 이 프로젝트에서 풀린다(다른 프로젝트에 배정 가능)
    expect((await http('GET', '/agents/me/tasks', token)).error?.code).toBe('NOT_PROJECT_MEMBER');
    // 레포를 새 프로젝트에 쓸 수 있다
    const next = await http('POST', `/orgs/${w.orgId}/projects`, w.rep.token, { name: 'p2', autonomyPreset: 'L2', pmBudgetUsd: 1, repoIds: [w.repoId] });
    expect(next.status).toBe(201);
    const p2 = (next.data.project as { id: string }).id;
    expect((await http('POST', `/projects/${p2}/members`, w.rep.token, { agentId: w.beAgent.agentId, teamRole: 'BACKEND' })).status).toBe(201);

    const feed = (await http('GET', `/projects/${w.projectId}/rooms/BACKEND/feed`, w.rep.token)).data.messages as { text: string }[];
    expect(feed.map((m) => m.text)).toContain('프로젝트가 중단되었습니다: 범위가 바뀌었다');
    const { rows } = await testPool.query(`SELECT payload FROM events WHERE type = 'PROJECT_ABORTED'`);
    expect(rows[0]!.payload).toMatchObject({ previousStatus: 'active', reason: '범위가 바뀌었다', openTaskCount: 1, expiredQuestionIds: [] });
  });

  it('중단한 프로젝트의 대기 질문은 만료로 닫힌다', async () => {
    const w = await world({ started: true });
    const token = await agentToken(w.beAgent.refreshToken);
    await http('POST', `/tasks/${w.taskId}/claim`, token);
    const q = '응답 필드는?';
    const asked = await http('POST', `/tasks/${w.taskId}/questions`, token, { questions: [{ question: q, header: '필드', options: [{ label: 'a' }, { label: 'b' }], multiSelect: false }] });
    expect(asked.status).toBe(201);
    await http('POST', `/projects/${w.projectId}/abort`, w.rep.token, {});
    const { rows } = await testPool.query(`SELECT status FROM agent_questions WHERE id = $1`, [asked.data.id]);
    expect(rows[0]).toEqual({ status: 'expired' });
  });
});
