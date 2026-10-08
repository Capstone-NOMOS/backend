import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { connectAgent } from '../src/domain/agent/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { createTask } from '../src/domain/authoring/service.js';
import { drainTasksChanged } from '../src/domain/dispatch/tasks-changed.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { gitMirrorInspector, setCommitInspector } from '../src/domain/verification/commit-inspector.js';
import { sweepUnresponsiveClaims } from '../src/domain/task/stall.js';
import { assignRootOwner } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 룸(프로젝트 × 역할) 피드: 서버의 "실행해 주세요" → 수령 → 실행 시작 → 도구 사용 → 제출 → 검증 결과가 한 줄씩.
// 팀원은 자기 역할 룸만, 대표는 전부 본다.

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
  // V3는 가짜 검사기 — 제출과 같은 경로를 바꿨다고 답한다.
  setCommitInspector({ kind: 'fake', async changedPaths() { return ['src/api/join.ts']; } });
});

afterAll(async () => {
  setCommitInspector(gitMirrorInspector());
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

type Res = { status: number; data: Record<string, unknown>; error?: { code: string } };

async function http(method: string, path: string, token: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
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

// 대표, BE·FE 팀원(각자 에이전트), BE·FE 태스크 하나씩. 시작까지 해 둔다.
async function world() {
  const rep = await account('rep');
  const { orgId } = await createOrganization(rep.userId, 'Acme');
  const be = await account('be-dev');
  const fe = await account('fe-dev');
  for (const m of [be, fe]) {
    const { token } = await createInvite(orgId, rep.userId);
    await acceptInvite(token, m.userId);
  }
  const beAgent = await connectAgent({ connectKey: be.connectKey, agentName: 'be-laptop', harness: 'claude-code', skills: [], maxConcurrent: 1 });
  const feAgent = await connectAgent({ connectKey: fe.connectKey, agentName: 'fe-laptop', harness: 'claude-code', skills: [], maxConcurrent: 1 });
  const [repo] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/app' }] });
  await assignRootOwner(orgId, rep.userId, repo!.id, 'BACKEND');
  const actor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' };
  const project = await createProject(orgId, rep.userId, { name: 'p', autonomyPreset: 'L2', pmBudgetUsd: 1, repoIds: [repo!.id] });
  const projectId = project.project.id;
  await assignMember(actor, projectId, beAgent.agentId, 'BACKEND');
  await assignMember(actor, projectId, feAgent.agentId, 'FRONTEND');
  const beTask = await createTask(rep.userId, projectId, { title: 'T-1 가입 API', teamRole: 'BACKEND', kind: 'INTEGRATION', repoId: repo!.id, specId: null, dependsOn: [] });
  const feTask = await createTask(rep.userId, projectId, { title: 'T-2 가입 화면', teamRole: 'FRONTEND', kind: 'INTEGRATION', repoId: repo!.id, specId: null, dependsOn: [] });
  await startProject(actor, projectId);
  await drainTasksChanged();
  // 배정 뒤 재발급해야 토큰에 project_id가 담긴다.
  const refresh = async (refreshToken: string) =>
    ((await (await fetch(`${baseUrl}/api/agents/token/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) })).json()) as { data: { accessToken: string } }).data.accessToken;
  return {
    rep, be, fe, orgId, projectId,
    beTaskId: beTask.id, feTaskId: feTask.id,
    beAgentToken: await refresh(beAgent.refreshToken),
    feAgentToken: await refresh(feAgent.refreshToken),
  };
}

type Msg = { speaker: string; type: string; text: string; taskId: string | null };

async function feed(token: string, projectId: string, role: string, query = ''): Promise<{ messages: Msg[]; nextBefore: string | null; status: number }> {
  await drainTasksChanged();
  const res = await http('GET', `/projects/${projectId}/rooms/${role}/feed${query}`, token);
  return { status: res.status, messages: (res.data.messages ?? []) as Msg[], nextBefore: (res.data.nextBefore ?? null) as string | null };
}

describe('룸 피드 — 실행해 주세요부터 검증 결과까지', () => {
  it('BE 룸에 서버 지시·수령·실행·도구 사용·제출·검증이 순서대로 쌓인다(최신부터)', async () => {
    const w = await world();
    // 실제 순서: Executor가 실행을 시작하고 → 모델이 실행 안에서 태스크를 잡는다.
    expect((await http('POST', `/tasks/${w.beTaskId}/runs/start`, w.beAgentToken)).status).toBe(201);
    await http('POST', `/tasks/${w.beTaskId}/claim`, w.beAgentToken);
    expect(
      (await http('POST', `/tasks/${w.beTaskId}/activity`, w.beAgentToken, {
        items: [
          { kind: 'read', target: 'src/api/join.ts' },
          { kind: 'edit', target: 'src/api/join.ts' },
          { kind: 'run', target: 'npm test' },
        ],
      })).status,
    ).toBe(201);
    const submitted = await http('POST', `/tasks/${w.beTaskId}/artifacts`, w.beAgentToken, {
      commitSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      changedPaths: ['src/api/join.ts'],
    });
    expect(submitted.status).toBe(201);
    // Executor가 V2·V4를 보고해야 검증 결론이 난다(그 전의 '검증 중'은 룸에 줄을 만들지 않는다).
    const artifactId = submitted.data.id as string;
    for (const stage of ['V2', 'V4']) {
      await http('POST', `/artifacts/${artifactId}/verifications`, w.beAgentToken, { stage, result: 'SKIPPED', detail: { reason: '없음' } });
    }
    const ended = await http('POST', `/tasks/${w.beTaskId}/runs/end`, w.beAgentToken, { outcome: 'completed', committed: true, durationMs: 42_000, exitCode: 0 });
    expect(ended.data).toMatchObject({ submitted: true });

    const { messages } = await feed(w.rep.token, w.projectId, 'BACKEND');
    const lines = [...messages].reverse().map((m) => `[${m.speaker}] ${m.text}`);
    expect(lines.slice(0, 8)).toEqual([
      '[pm] 프로젝트를 시작합니다',
      '[pm] T-1 가입 API 실행해 주세요',
      '[nomos] 에이전트를 실행합니다',
      '[nomos] 태스크 수령 — T-1 가입 API · 구현을 시작합니다',
      '[agent] src/api/join.ts 읽는 중',
      '[agent] src/api/join.ts 수정',
      '[agent] npm test 실행',
      '[nomos] 제출했습니다 (커밋 a1b2c3d, 파일 1개)',
    ]);
    // 검증 결론은 한 줄만(이 태스크는 정책상 AUTO라 완료), 그 뒤에 실행 종료.
    expect(lines.slice(8)).toEqual([
      '[pm] 검증 완료 — V3 통과, V1A·V1B·V2·V4 건너뜀 → 완료되었습니다',
      '[nomos] 실행을 마쳤습니다 (42초)',
    ]);
    // 다른 역할의 태스크는 BE 룸에 나오지 않는다.
    expect(messages.some((m) => m.taskId === w.feTaskId)).toBe(false);

    // 서버의 지시는 system:dispatcher 명의로 한 번만.
    const dispatched = await testPool.query(`SELECT on_behalf_of FROM events WHERE type = 'TASK_DISPATCHED' AND payload->>'taskId' = $1`, [w.beTaskId]);
    expect(dispatched.rows).toEqual([{ on_behalf_of: 'system:dispatcher' }]);
  });

  it('제출 없이 끝나면 BLOCKED(AGENT_STOPPED)로 멈추고 사유·거부 명령이 룸에 남는다 — 재시도 횟수는 그대로, 대표가 재개하면 다시 지시', async () => {
    const w = await world();
    await http('POST', `/tasks/${w.beTaskId}/runs/start`, w.beAgentToken);
    await http('POST', `/tasks/${w.beTaskId}/claim`, w.beAgentToken);
    const ended = await http('POST', `/tasks/${w.beTaskId}/runs/end`, w.beAgentToken, {
      outcome: 'completed', committed: false, durationMs: 48_000, exitCode: 0,
      lastMessage: 'git merge 권한이 없어 통합 확인을 할 수 없습니다', deniedCommands: ['git fetch --all', 'npm --version'],
    });
    expect(ended.data).toEqual({ submitted: false, taskState: 'BLOCKED', blocked: true });
    const { rows } = await testPool.query(`SELECT state, blocked_reason, retry_count FROM tasks WHERE id = $1`, [w.beTaskId]);
    expect(rows[0]).toEqual({ state: 'BLOCKED', blocked_reason: 'AGENT_STOPPED', retry_count: 0 });

    let { messages } = await feed(w.rep.token, w.projectId, 'BACKEND');
    expect(messages.slice(0, 2).map((m) => m.text).reverse()).toEqual([
      '실행을 마쳤습니다 (48초, 제출 없음)',
      '멈췄습니다 — 제출하지 않고 끝났습니다 / 에이전트: "git merge 권한이 없어 통합 확인을 할 수 없습니다" / 거부된 명령: git fetch --all, npm --version → 대표 확인 후 재개가 필요합니다',
    ]);

    // 팀원은 재개할 수 없고, 대표가 재개하면 READY + 담당 비움 + "다시 실행해 주세요 (재개)".
    expect((await http('POST', `/tasks/${w.beTaskId}/resume`, w.be.token, {})).status).toBe(403);
    const resumed = await http('POST', `/tasks/${w.beTaskId}/resume`, w.rep.token, { note: '허용 명령을 늘렸습니다' });
    expect(resumed.data).toMatchObject({ state: 'READY', assigneeAgentId: null, blockedReason: null, retryCount: 0 });
    ({ messages } = await feed(w.rep.token, w.projectId, 'BACKEND'));
    expect(messages.slice(0, 2).map((m) => m.text).reverse()).toEqual(['대표가 재개했습니다: 허용 명령을 늘렸습니다', 'T-1 가입 API 다시 실행해 주세요 (재개)']);
    expect(await http('POST', `/tasks/${w.beTaskId}/resume`, w.rep.token, {})).toMatchObject({ status: 409, error: { code: 'TASK_NOT_STOPPED' } });
    // 다시 가져갈 수 있다.
    expect((await http('POST', `/tasks/${w.beTaskId}/claim`, w.beAgentToken)).status).toBe(200);
  });

  it('감시: 응답이 끊긴 수령은 멈춤으로 바뀐다(system:watchdog)', async () => {
    const w = await world();
    await http('POST', `/tasks/${w.beTaskId}/claim`, w.beAgentToken);
    await testPool.query(`UPDATE tasks SET claimed_at = now() - interval '2 hours' WHERE id = $1`, [w.beTaskId]); // 시간 경과를 흉내 낸다(서비스 함수 없음)
    await testPool.query(`UPDATE events SET ts = now() - interval '2 hours' WHERE payload->>'taskId' = $1`, [w.beTaskId]);
    expect(await sweepUnresponsiveClaims(60 * 60 * 1000)).toBe(1);
    const { rows } = await testPool.query(`SELECT on_behalf_of, payload->>'cause' AS cause FROM events WHERE type = 'TASK_BLOCKED'`);
    expect(rows).toEqual([{ on_behalf_of: 'system:watchdog', cause: 'unresponsive' }]);
    expect(await sweepUnresponsiveClaims(60 * 60 * 1000)).toBe(0);
  });
});

describe('룸 권한', () => {
  it('팀원은 자기 역할 룸만, 대표는 전부', async () => {
    const w = await world();
    expect((await feed(w.fe.token, w.projectId, 'FRONTEND')).status).toBe(200);
    const denied = await http('GET', `/projects/${w.projectId}/rooms/BACKEND/feed`, w.fe.token);
    expect(denied).toMatchObject({ status: 403, error: { code: 'ROOM_NOT_VISIBLE' } });
    expect((await feed(w.rep.token, w.projectId, 'FRONTEND')).status).toBe(200);

    const feRooms = await http('GET', `/projects/${w.projectId}/rooms`, w.fe.token);
    expect((feRooms.data.rooms as { role: string }[]).map((r) => r.role)).toEqual(['FRONTEND']);
    const repRooms = await http('GET', `/projects/${w.projectId}/rooms`, w.rep.token);
    expect((repRooms.data.rooms as { role: string; agent: { agentName: string } }[]).map((r) => [r.role, r.agent.agentName])).toEqual([
      ['FRONTEND', 'fe-laptop'],
      ['BACKEND', 'be-laptop'],
    ]);
  });

  it('PM의 프로젝트 단위 알림은 모든 룸에 나온다', async () => {
    const w = await world();
    for (const role of ['FRONTEND', 'BACKEND']) {
      const { messages } = await feed(w.rep.token, w.projectId, role);
      expect(messages.some((m) => m.text === '프로젝트를 시작합니다')).toBe(true);
    }
  });
});

describe('Executor 보고 규칙', () => {
  it('실행 시작은 그 태스크를 잡았거나 지금 잡을 수 있는 에이전트만, 활동·종료는 열린 실행에만', async () => {
    const w = await world();
    // 다른 역할의 태스크는 시작할 수 없다.
    expect(await http('POST', `/tasks/${w.beTaskId}/runs/start`, w.feAgentToken)).toMatchObject({ status: 409, error: { code: 'RUN_NOT_ALLOWED' } });
    await http('POST', `/tasks/${w.beTaskId}/claim`, w.beAgentToken);
    expect(await http('POST', `/tasks/${w.beTaskId}/activity`, w.beAgentToken, { items: [{ kind: 'read', target: 'a.ts' }] })).toMatchObject({
      status: 409,
      error: { code: 'RUN_NOT_OPEN' },
    });
    await http('POST', `/tasks/${w.beTaskId}/runs/start`, w.beAgentToken);
    await http('POST', `/tasks/${w.beTaskId}/runs/end`, w.beAgentToken, { outcome: 'timeout', committed: false, durationMs: 1, exitCode: null });
    expect(await http('POST', `/tasks/${w.beTaskId}/runs/end`, w.beAgentToken, { outcome: 'timeout', committed: false, durationMs: 1, exitCode: null })).toMatchObject({
      status: 409,
      error: { code: 'RUN_NOT_OPEN' },
    });
  });

  it('활동은 도구 종류와 300자 이하 대상만 받는다', async () => {
    const w = await world();
    await http('POST', `/tasks/${w.beTaskId}/claim`, w.beAgentToken);
    await http('POST', `/tasks/${w.beTaskId}/runs/start`, w.beAgentToken);
    expect((await http('POST', `/tasks/${w.beTaskId}/activity`, w.beAgentToken, { items: [{ kind: 'think', target: 'x' }] })).status).toBe(400);
    expect((await http('POST', `/tasks/${w.beTaskId}/activity`, w.beAgentToken, { items: [{ kind: 'read', target: 'x'.repeat(301) }] })).status).toBe(400);
  });
});

describe('피드 페이지 넘기기', () => {
  it('nextBefore로 이어 읽으면 빠지거나 겹치는 줄이 없다', async () => {
    const w = await world();
    await http('POST', `/tasks/${w.beTaskId}/claim`, w.beAgentToken);
    await http('POST', `/tasks/${w.beTaskId}/runs/start`, w.beAgentToken);
    await http('POST', `/tasks/${w.beTaskId}/activity`, w.beAgentToken, {
      items: Array.from({ length: 7 }, (_, i) => ({ kind: 'read', target: `src/f${i}.ts` })),
    });
    const all = (await feed(w.rep.token, w.projectId, 'BACKEND', '?limit=200')).messages.map((m) => m.text);
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await feed(w.rep.token, w.projectId, 'BACKEND', `?limit=3${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
      paged.push(...page.messages.map((m) => m.text));
      cursor = page.nextBefore;
    } while (cursor);
    expect(paged).toEqual(all);
    expect((await http('GET', `/projects/${w.projectId}/rooms/BACKEND/feed?before=nope`, w.rep.token)).status).toBe(400);
  });
});
