import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
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
import { connectRepos, updateRepoSettings } from '../src/domain/repo/service.js';
import { gitMirrorInspector, setCommitInspector } from '../src/domain/verification/commit-inspector.js';
import { assignRootOwner } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// dep:add는 경로가 아니라 package.json의 의존성 diff로 판정한다(운영 테스트 4-7: FE가 새 package.json에 의존성을 넣었는데 AUTO로 통과했다).
// 실제 git 레포와 mirror 검사기로 커밋 전후 내용을 읽는다.

let server: Server;
let baseUrl: string;
let tmp: string;
let repoDir: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
}

function commit(files: Record<string, string>, message: string): string {
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(repoDir, name), content);
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

beforeAll(async () => {
  await resetSchema();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await truncateAll();
  tmp = mkdtempSync(path.join(os.tmpdir(), 'nomos-dep-'));
  repoDir = path.join(tmp, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
  commit({ 'README.md': '# x\n' }, 'init');
  setCommitInspector(gitMirrorInspector(path.join(tmp, 'mirrors')));
});

afterAll(async () => {
  setCommitInspector(gitMirrorInspector());
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function http(method: string, p: string, token: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown> } };
}

async function world() {
  const signupAs = async (loginId: string) => {
    const { userId, connectKey } = await signup({ loginId, password: 'correct-horse-battery', nickname: loginId });
    return { userId, connectKey, token: (await login({ loginId, password: 'correct-horse-battery' })).accessToken };
  };
  const rep = await signupAs('rep');
  const { orgId } = await createOrganization(rep.userId, 'Acme');
  const fe = await signupAs('fe-dev');
  const { token } = await createInvite(orgId, rep.userId);
  await acceptInvite(token, fe.userId);
  const agent = await connectAgent({ connectKey: fe.connectKey, agentName: 'fe-laptop', harness: 'claude-code', skills: [], maxConcurrent: 2 });
  const [repo] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/web' }] });
  await assignRootOwner(orgId, rep.userId, repo!.id, 'FRONTEND');
  await updateRepoSettings(orgId, rep.userId, repo!.id, { cloneUrl: repoDir });
  const actor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' };
  const { project } = await createProject(orgId, rep.userId, { name: 'p', autonomyPreset: 'L2', pmBudgetUsd: 1, repoIds: [repo!.id] });
  await assignMember(actor, project.id, agent.agentId, 'FRONTEND');
  const tasks = [];
  for (const title of ['T-1 화면 뼈대', 'T-2 스크립트 정리']) {
    tasks.push(await createTask(rep.userId, project.id, { title, teamRole: 'FRONTEND', kind: 'INTEGRATION', repoId: repo!.id, specId: null, dependsOn: [] }));
  }
  await startProject(actor, project.id);
  await drainTasksChanged();
  const refreshed = await fetch(`${baseUrl}/api/agents/token/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: agent.refreshToken }),
  });
  const agentToken = ((await refreshed.json()) as { data: { accessToken: string } }).data.accessToken;
  return { projectId: project.id, agentToken, tasks };
}

async function submit(agentToken: string, taskId: string, sha: string, changedPaths: string[]) {
  await http('POST', `/tasks/${taskId}/claim`, agentToken);
  const submitted = await http('POST', `/tasks/${taskId}/artifacts`, agentToken, { commitSha: sha, changedPaths });
  expect(submitted.status).toBe(201);
  const artifactId = (submitted.body.data as { id: string }).id;
  for (const stage of ['V2', 'V4']) {
    await http('POST', `/artifacts/${artifactId}/verifications`, agentToken, { stage, result: 'SKIPPED', detail: { reason: '없음' } });
  }
  const { rows } = await testPool.query(
    `SELECT t.state, a.gate_mode, a.triggered_actions FROM tasks t JOIN artifacts a ON a.task_id = t.id WHERE a.id = $1`,
    [artifactId],
  );
  return rows[0] as { state: string; gate_mode: string; triggered_actions: string[] };
}

describe('dep:add — package.json 의존성 diff', () => {
  it('새 package.json에 의존성이 있으면 dep:add로 판정이 올라간다(L2: PM_REVIEW → 승인 대기)', async () => {
    const w = await world();
    const sha = commit({ 'package.json': JSON.stringify({ name: 'web', dependencies: { react: '^19.0.0', vite: '^6.0.0' } }) }, 'scaffold');
    const result = await submit(w.agentToken, w.tasks[0]!.id, sha, ['package.json']);
    expect(result).toMatchObject({ state: 'AWAITING_APPROVAL', gate_mode: 'PM_REVIEW' });
    expect(result.triggered_actions).toContain('dep:add');

    const { rows } = await testPool.query(`SELECT payload FROM events WHERE type = 'ACTION_DETECTED'`);
    expect(rows[0].payload).toMatchObject({
      actionKey: 'dep:add',
      paths: ['package.json'],
      unreadable: [],
      gateModeBefore: 'AUTO',
      gateModeAfter: 'PM_REVIEW',
    });
    expect(rows[0].payload.changes.map((c: { name: string; from: string | null }) => `${c.name}:${c.from}`)).toEqual(['react:null', 'vite:null']);
    // 승인 카드의 스냅샷에도 dep:add가 들어 있다.
    const card = await testPool.query(`SELECT payload->'triggeredActions' AS actions FROM approvals WHERE gate = 'ACTION'`);
    expect(card.rows[0].actions).toContain('dep:add');
  });

  it('scripts만 고친 변경은 dep:add가 아니다(경로 규칙으로 잡지 않는 이유)', async () => {
    const w = await world();
    commit({ 'package.json': JSON.stringify({ name: 'web', scripts: { dev: 'vite' }, dependencies: { react: '^19.0.0' } }) }, 'base');
    const sha = commit({ 'package.json': JSON.stringify({ name: 'web', scripts: { dev: 'vite', test: 'vitest' }, dependencies: { react: '^19.0.0' } }) }, 'scripts');
    const result = await submit(w.agentToken, w.tasks[1]!.id, sha, ['package.json']);
    expect(result).toMatchObject({ state: 'DONE', gate_mode: 'AUTO' });
    expect(result.triggered_actions).not.toContain('dep:add');
    expect((await testPool.query(`SELECT 1 FROM events WHERE type = 'ACTION_DETECTED'`)).rowCount).toBe(0);
  });

  it('내용을 읽을 수 없는 검사기면 dep:add로 본다(fail closed)', async () => {
    const w = await world();
    const sha = commit({ 'package.json': '{}' }, 'empty manifest');
    setCommitInspector({ kind: 'fake', async changedPaths() { return ['package.json']; } }); // fileVersions 없음
    const result = await submit(w.agentToken, w.tasks[0]!.id, sha, ['package.json']);
    expect(result).toMatchObject({ state: 'AWAITING_APPROVAL', gate_mode: 'PM_REVIEW' });
    const { rows } = await testPool.query(`SELECT payload->'unreadable' AS unreadable FROM events WHERE type = 'ACTION_DETECTED'`);
    expect(rows[0].unreadable).toEqual(['package.json']);
  });
});
