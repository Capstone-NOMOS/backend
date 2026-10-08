import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { connectAgent } from '../src/domain/agent/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { drainTasksChanged } from '../src/domain/dispatch/tasks-changed.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { pmOnlyProblems, type PlanDraft } from '../src/domain/pm/draft.js';
import { setPmModel, type PmModelResponse } from '../src/domain/pm/model.js';
import { drainPmJobs } from '../src/domain/pm/service.js';
import { assignMember, createProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { gitMirrorInspector, setCommitInspector } from '../src/domain/verification/commit-inspector.js';
import { assignRootOwner } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 통합 확인은 에이전트가 아니라 대표가 한다(운영 테스트 4-3): PM은 INTEGRATION 태스크 대신 확인 항목(integrationChecks)을 쓰고,
// 모든 태스크가 DONE이 되면 대표에게 G3(통합 확인·완료 승인) 카드가 생긴다. 승인하면 프로젝트 완료.

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
  setCommitInspector({ kind: 'fake', async changedPaths() { return ['src/a.ts']; } });
});

afterEach(async () => {
  await drainPmJobs();
  setPmModel(null);
});

afterAll(async () => {
  setCommitInspector(gitMirrorInspector());
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

type Res = { status: number; data: Record<string, unknown>; error?: { code: string } };

async function http(method: string, path: string, token: string | null, body?: unknown): Promise<Res> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { data?: Record<string, unknown>; error?: { code: string } };
  return { status: res.status, data: json.data ?? {}, ...(json.error ? { error: json.error } : {}) };
}

async function account(loginId: string) {
  const { userId, connectKey } = await signup({ loginId, password: 'correct-horse-battery', nickname: loginId });
  const { accessToken } = await login({ loginId, password: 'correct-horse-battery' });
  return { userId, token: accessToken, connectKey };
}

const CHECKS = ['목록 화면이 GET /api/todos 응답을 보여 준다', '추가 입력 → POST /api/todos 201 → 목록에 보인다'];

function draft(extra: Partial<PlanDraft> = {}): PlanDraft {
  return {
    mode: 'SEQUENTIAL',
    rationale: '작다',
    estimate: { workingDays: 1, notes: '' },
    specs: [{ featureKey: 'F-01', title: 'Todo', content: 'WHEN 추가하면 THEN 201' }],
    tasks: [
      { ref: 'a', title: 'T-1 목록 API', repo: 'acme/api', teamRole: 'BACKEND', kind: 'IMPLEMENT', spec: 'F-01', dependsOn: [] },
      { ref: 'b', title: 'T-2 추가 API', repo: 'acme/api', teamRole: 'BACKEND', kind: 'IMPLEMENT', spec: 'F-01', dependsOn: [] },
    ],
    integrationChecks: CHECKS,
    ...extra,
  };
}

function respond(d: unknown): PmModelResponse {
  return { stopReason: 'end_turn', servedModel: 'claude-sonnet-5-5', text: JSON.stringify(d), attempts: [] };
}

// 대표·BE 팀원(에이전트), PM 계획 적용(확인 항목 포함), 배정, 시작.
async function world() {
  const rep = await account('rep');
  const { orgId } = await createOrganization(rep.userId, 'Acme');
  const be = await account('be-dev');
  const { token } = await createInvite(orgId, rep.userId);
  await acceptInvite(token, be.userId);
  const agent = await connectAgent({ connectKey: be.connectKey, agentName: 'be-laptop', harness: 'claude-code', skills: [], maxConcurrent: 1 });
  const [repo] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/api' }] });
  await assignRootOwner(orgId, rep.userId, repo!.id, 'BACKEND');
  const actor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' };
  const { project } = await createProject(orgId, rep.userId, { name: 'p', autonomyPreset: 'L2', pmBudgetUsd: 10, repoIds: [repo!.id] });
  await assignMember(actor, project.id, agent.agentId, 'BACKEND');

  setPmModel({ kind: 'fake', async generate() { return respond(draft()); } });
  const requested = await http('POST', `/projects/${project.id}/pm/plans`, rep.token, { instruction: 'Todo' });
  await drainPmJobs();
  await http('POST', `/projects/${project.id}/pm/plans/${requested.data.id as string}/apply`, rep.token);
  await http('POST', `/projects/${project.id}/start`, rep.token);
  await drainTasksChanged();

  const refreshed = await fetch(`${baseUrl}/api/agents/token/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: agent.refreshToken }),
  });
  const agentToken = ((await refreshed.json()) as { data: { accessToken: string } }).data.accessToken;
  const tasks = (await http('GET', `/projects/${project.id}/tasks`, rep.token)).data.tasks as { id: string; title: string }[];
  return { rep, orgId, projectId: project.id, repoId: repo!.id, agentToken, tasks };
}

let sha = 0;
// 에이전트가 태스크 하나를 끝까지: 수령 → 제출(V3 PASS) → V2·V4 보고 → DONE(L2·자기 경로는 AUTO).
async function finish(agentToken: string, taskId: string): Promise<void> {
  expect((await http('POST', `/tasks/${taskId}/claim`, agentToken)).status).toBe(200);
  sha += 1;
  const submitted = await http('POST', `/tasks/${taskId}/artifacts`, agentToken, { commitSha: sha.toString(16).padStart(40, 'a'), changedPaths: ['src/a.ts'] });
  expect(submitted.status).toBe(201);
  for (const stage of ['V2', 'V4']) {
    await http('POST', `/artifacts/${submitted.data.id as string}/verifications`, agentToken, { stage, result: 'SKIPPED', detail: { reason: '없음' } });
  }
  const { rows } = await testPool.query(`SELECT state FROM tasks WHERE id = $1`, [taskId]);
  expect(rows[0].state).toBe('DONE');
}

async function releases(projectId: string) {
  const { rows } = await testPool.query(`SELECT id, decision, payload FROM approvals WHERE project_id = $1 AND gate = 'G3' ORDER BY requested_at`, [projectId]);
  return rows as { id: string; decision: string | null; payload: { integrationChecks: string[]; tasks: { title: string; repo: string }[] } }[];
}

describe('PM은 통합 태스크 대신 확인 항목을 쓴다', () => {
  it('INTEGRATION 태스크는 위반으로 돌려준다(교정 1회에 싣는다)', () => {
    const bad = draft({ tasks: [{ ref: 'i', title: '통합', repo: 'acme/api', teamRole: 'FRONTEND', kind: 'INTEGRATION', spec: null, dependsOn: [] }] });
    expect(pmOnlyProblems(bad)).toEqual([expect.stringContaining('INTEGRATION 태스크를 만들지 않는다')]);
    expect(pmOnlyProblems(draft())).toEqual([]);
  });
});

describe('G3 — 통합 확인·완료 승인', () => {
  it('마지막 태스크가 DONE이 되는 순간 카드 하나 — 확인 항목과 태스크별 레포·브랜치·커밋이 담긴다', async () => {
    const w = await world();
    await finish(w.agentToken, w.tasks[0]!.id);
    expect(await releases(w.projectId)).toEqual([]);
    await finish(w.agentToken, w.tasks[1]!.id);

    const [card, ...rest] = await releases(w.projectId);
    expect(rest).toEqual([]);
    expect(card!.decision).toBeNull();
    expect(card!.payload.integrationChecks).toEqual(CHECKS);
    expect(card!.payload.tasks.map((t) => t.repo)).toEqual(['acme/api', 'acme/api']);

    // 대기열 API: gate G3, taskId null(프로젝트 전체).
    const queue = await http('GET', `/orgs/${w.orgId}/approvals?status=pending`, w.rep.token);
    expect(queue.data.approvals).toEqual([expect.objectContaining({ gate: 'G3', taskId: null, projectId: w.projectId })]);

    // 룸(모든 룸)에 PM 줄.
    await drainTasksChanged();
    const feed = await http('GET', `/projects/${w.projectId}/rooms/FRONTEND/feed`, w.rep.token);
    expect((feed.data.messages as { text: string }[])[0]!.text).toBe('모든 태스크가 완료되었습니다 → 대표의 통합 확인을 기다립니다 (확인 항목 2개)');
  });

  it('반려하면 진행 중 그대로 → 고칠 태스크가 끝나면 새 카드 → 승인하면 프로젝트 완료', async () => {
    const w = await world();
    for (const t of w.tasks) await finish(w.agentToken, t.id);
    const [first] = await releases(w.projectId);

    expect((await http('POST', `/approvals/${first!.id}/reject`, w.rep.token, { reason: '추가 후 목록이 갱신되지 않는다' })).status).toBe(200);
    const project = await testPool.query(`SELECT status FROM projects WHERE id = $1`, [w.projectId]);
    expect(project.rows[0].status).toBe('active');
    expect((await http('POST', `/approvals/${first!.id}/approve`, w.rep.token)).error?.code).toBe('APPROVAL_ALREADY_DECIDED');

    const fix = await http('POST', `/projects/${w.projectId}/tasks`, w.rep.token, { title: 'T-3 목록 갱신 고치기', teamRole: 'BACKEND', kind: 'REWORK', repoId: w.repoId });
    await drainTasksChanged();
    await finish(w.agentToken, fix.data.id as string);
    const cards = await releases(w.projectId);
    expect(cards.map((c) => c.decision)).toEqual(['REJECT', null]);

    expect((await http('POST', `/approvals/${cards[1]!.id}/approve`, w.rep.token)).status).toBe(200);
    const done = await testPool.query(`SELECT status FROM projects WHERE id = $1`, [w.projectId]);
    expect(done.rows[0].status).toBe('completed');
    const events = await testPool.query(`SELECT type, on_behalf_of FROM events WHERE type IN ('RELEASE_REQUESTED', 'RELEASE_DECIDED') ORDER BY id`);
    expect(events.rows.map((r) => `${r.type}:${r.on_behalf_of === 'system:pm' ? 'pm' : 'rep'}`)).toEqual([
      'RELEASE_REQUESTED:pm',
      'RELEASE_DECIDED:rep',
      'RELEASE_REQUESTED:pm',
      'RELEASE_DECIDED:rep',
    ]);
  });
});
