import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { connectAgent } from '../src/domain/agent/service.js';
import { createTask } from '../src/domain/authoring/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { gitMirrorInspector, setCommitInspector } from '../src/domain/verification/commit-inspector.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 사람이 닫기(027): 재실행으로 풀리지 않는 태스크를 대표가 취소하거나, 개발자가 직접 커밋해 완료한다.

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
afterEach(() => setCommitInspector(gitMirrorInspector()));
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

async function http(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: unknown } };
  return { status: res.status, data: json.data ?? {}, error: json.error };
}

async function account(loginId: string) {
  const { userId, connectKey } = await signup({ loginId, password: 'correct-horse-battery', nickname: loginId });
  const { accessToken } = await login({ loginId, password: 'correct-horse-battery' });
  return { userId, connectKey, token: accessToken };
}

// 대표·BE·FE, BE 태스크 둘(T-2가 T-1에 걸림), 시작한 프로젝트.
async function world() {
  const rep = await account('rep');
  const be = await account('be');
  const fe = await account('fe');
  const { orgId } = await createOrganization(rep.userId, 'Acme');
  for (const u of [be, fe]) await acceptInvite((await createInvite(orgId, rep.userId)).token, u.userId);
  const [api] = await connectRepos({ orgId, actorUserId: rep.userId, actorOrgRole: 'REPRESENTATIVE', repos: [{ fullName: 'acme/api', ownerRole: 'BACKEND' }] });
  const { project } = await createProject(orgId, rep.userId, { name: 'P', autonomyPreset: 'L2', pmBudgetUsd: 5, repoIds: [api!.id] });
  const actor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' as const };
  const beAgent = await connectAgent({ connectKey: be.connectKey, agentName: 'be', harness: 't', skills: [], maxConcurrent: 1 });
  await assignMember(actor, project.id, beAgent.agentId, 'BACKEND');
  const t1 = await createTask(rep.userId, project.id, { title: 'T-1 기반', teamRole: 'BACKEND', kind: 'INTEGRATION', repoId: api!.id, specId: null, dependsOn: [] });
  const t2 = await createTask(rep.userId, project.id, { title: 'T-2 그 위', teamRole: 'BACKEND', kind: 'INTEGRATION', repoId: api!.id, specId: null, dependsOn: [t1.id] });
  await startProject(actor, project.id);
  return { rep, be, fe, projectId: project.id, t1: t1.id, t2: t2.id };
}

const stateOf = async (id: string) => (await testPool.query(`SELECT state FROM tasks WHERE id = $1`, [id])).rows[0].state as string;

describe('태스크 취소 (대표)', () => {
  it('취소하면 CANCELLED로 남고, 그걸 선행으로 둔 태스크가 풀리며, 남은 태스크가 끝나면 통합 확인 카드가 나온다', async () => {
    const w = await world();
    expect((await http('POST', `/tasks/${w.t1}/cancel`, w.be.token, { reason: 'x' })).error?.code).toBe('NOT_REPRESENTATIVE');
    const res = await http('POST', `/tasks/${w.t1}/cancel`, w.rep.token, { reason: '범위에서 빠짐' });
    expect(res).toMatchObject({ status: 200, data: { state: 'CANCELLED', assigneeAgentId: null } });
    const ev = await testPool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'TASK_CANCELLED'`);
    expect(ev.rows[0]).toMatchObject({ on_behalf_of: w.rep.userId, payload: { reason: '범위에서 빠짐', unblockedDependents: [w.t2], previousState: 'READY' } });
    expect((await http('POST', `/tasks/${w.t1}/cancel`, w.rep.token, { reason: 'x' })).error?.code).toBe('TASK_ALREADY_CLOSED');

    // 남은 T-2를 직접 완료하면 모든 태스크가 끝나(취소 포함) G3 카드가 하나 생긴다. 취소한 태스크는 카드에 없다.
    setCommitInspector({ kind: 'fake', async changedPaths() { return ['src/a.ts']; } });
    expect((await http('POST', `/tasks/${w.t2}/manual-completion`, w.rep.token, { commitSha: 'abcdef1', changedPaths: ['src/a.ts'] })).status).toBe(200);
    const g3 = await testPool.query(`SELECT payload FROM approvals WHERE gate = 'G3'`);
    expect(g3.rows).toHaveLength(1);
    expect((g3.rows[0].payload.tasks as { taskId: string }[]).map((t) => t.taskId)).toEqual([w.t2]);
  });

  it('에이전트가 잡고 있으면 취소할 수 없다', async () => {
    const w = await world();
    // 실행 중 상태를 흉내 낸다(수령 경로는 이 테스트의 대상이 아니다).
    await testPool.query(`UPDATE tasks SET state = 'IN_PROGRESS' WHERE id = $1`, [w.t1]);
    expect((await http('POST', `/tasks/${w.t1}/cancel`, w.rep.token, { reason: 'x' })).error?.code).toBe('TASK_IN_PROGRESS');
  });
});

describe('사람이 직접 완료 (그 역할 담당 또는 대표)', () => {
  it('에이전트 제출과 같은 V3를 통과하면 DONE — 산출물(HUMAN)·V3 결과·이벤트가 남는다', async () => {
    const w = await world();
    setCommitInspector({ kind: 'fake', async changedPaths() { return ['src/a.ts', 'src/b.ts']; } });
    const fromFe = await http('POST', `/tasks/${w.t1}/manual-completion`, w.fe.token, { commitSha: 'abcdef1', changedPaths: ['src/a.ts', 'src/b.ts'] });
    expect(fromFe.error?.code).toBe('NOT_TASK_OWNER');
    const res = await http('POST', `/tasks/${w.t1}/manual-completion`, w.be.token, { commitSha: 'abcdef1', changedPaths: ['src/a.ts', 'src/b.ts'], note: '직접 고침' });
    expect(res).toMatchObject({ status: 200, data: { state: 'DONE' } });
    const art = await testPool.query(`SELECT a.gate_mode, v.stage, v.result FROM artifacts a JOIN verifications v ON v.artifact_id = a.id WHERE a.task_id = $1`, [w.t1]);
    expect(art.rows).toEqual([{ gate_mode: 'HUMAN', stage: 'V3', result: 'PASS' }]);
    const ev = await testPool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'TASK_COMPLETED_MANUALLY'`);
    expect(ev.rows[0]).toMatchObject({ on_behalf_of: w.be.userId, payload: { v3: 'PASS', note: '직접 고침' } });
  });

  it('신고가 실제 diff와 다르면 422(위반 목록)이고 아무것도 바뀌지 않는다', async () => {
    const w = await world();
    setCommitInspector({ kind: 'fake', async changedPaths() { return ['src/a.ts', 'src/secret-extra.ts']; } });
    const res = await http('POST', `/tasks/${w.t1}/manual-completion`, w.be.token, { commitSha: 'abcdef1', changedPaths: ['src/a.ts'] });
    expect(res).toMatchObject({ status: 422, error: { code: 'MANUAL_COMPLETION_INVALID', details: { undeclared: ['src/secret-extra.ts'] } } });
    expect(await stateOf(w.t1)).toBe('READY');
    expect((await testPool.query(`SELECT count(*)::int AS n FROM artifacts`)).rows[0].n).toBe(0);
  });
});
