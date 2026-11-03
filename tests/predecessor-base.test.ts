import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/config/db.js';
import { createTask } from '../src/domain/authoring/service.js';
import { createProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { insertArtifact, listPredecessorBases } from '../src/domain/task/repository.js';
import { gitMirrorInspector } from '../src/domain/verification/commit-inspector.js';
import { buildTaskPrompt } from '../src/executor/prompt.js';
import { mergePredecessors, prepareWorkspace, type PredecessorCommit } from '../src/executor/workspace.js';
import { createTestOrg } from './fixtures.js';
import { resetSchema, truncateAll } from './test-db.js';

// 선행 작업 위에서 시작하기 — 태스크 브랜치는 기본 브랜치에 합쳐지지 않는다. 운영 실험에서 "F-01이 만든 기반 위에 라우트를 더하라"는
// BE 태스크가 빈 main에서 시작해 기반 코드가 없다며 멈췄다. CLI가 선행 커밋을 합쳐서 시작하고, V3는 같은 커밋들을 비교 기준으로 쓴다.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

let work: string;
let origin: string;
let clone: string;
let mirrors: string;
let savedHome: string | undefined;
let preds: { a: PredecessorCommit; b: PredecessorCommit; conflicting: PredecessorCommit };

function commitOn(branch: string, from: string, file: string, content: string): string {
  git(origin, 'checkout', '-q', '-B', branch, from);
  writeFileSync(path.join(origin, file), content);
  git(origin, 'add', file);
  git(origin, ...ID, 'commit', '-q', '-m', `${branch}: ${file}`);
  const sha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', 'main');
  return sha;
}

beforeAll(async () => {
  await resetSchema();
  work = mkdtempSync(path.join(tmpdir(), 'nomos-preds-'));
  origin = path.join(work, 'origin');
  clone = path.join(work, 'clone');
  mirrors = path.join(work, 'mirrors');
  git(work, 'init', '-q', '-b', 'main', origin);
  writeFileSync(path.join(origin, 'README.md'), 'base\n');
  git(origin, 'add', 'README.md');
  git(origin, ...ID, 'commit', '-q', '-m', 'base');
  // 선행 A(기반 코드)와 그 위의 선행 B, 그리고 A와 같은 파일을 다르게 만든 선행(충돌용).
  const a = commitOn('task/a', 'main', 'app.py', 'def base():\n    return 1\n');
  const b = commitOn('task/b', 'task/a', 'repo.py', 'def repo():\n    return 2\n');
  const c = commitOn('task/c', 'main', 'app.py', 'def other():\n    return 3\n');
  preds = {
    a: { taskId: 'a', title: 'F-01 기반', branchName: 'task/a', commitSha: a },
    b: { taskId: 'b', title: 'F-02 저장소', branchName: 'task/b', commitSha: b },
    conflicting: { taskId: 'c', title: '충돌 선행', branchName: 'task/c', commitSha: c },
  };
  // CLI가 받아 두는 클론 — 태스크 브랜치들은 origin/* 로만 있다.
  git(work, 'clone', '-q', origin, clone);
  savedHome = process.env.NOMOS_HOME;
  process.env.NOMOS_HOME = path.join(work, 'home');
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.NOMOS_HOME;
  else process.env.NOMOS_HOME = savedHome;
  rmSync(work, { recursive: true, force: true });
  await pool.end();
});

function freshWorkspace(taskId: string) {
  return prepareWorkspace({ repoPath: clone, projectId: 'p1', taskId, branchName: `task/${taskId}`, baseBranch: 'origin/main', settings: {}, policyHash: 'h' });
}

describe('CLI — 새 태스크 브랜치에 선행 커밋을 합친다', () => {
  it('선행 둘을 오래된 것부터 합쳐 기반 코드 위에서 시작하고, 이어 가는 브랜치는 합치지 않는다', () => {
    const ws = freshWorkspace('t1');
    expect(ws.startedFresh).toBe(true);
    const merged = mergePredecessors(ws.dir, [preds.a, preds.b]);
    expect(merged.failed).toEqual([]);
    expect(merged.merged.map((m) => m.taskId)).toEqual(['a', 'b']);
    expect(readFileSync(path.join(ws.dir, 'app.py'), 'utf8')).toContain('def base');
    expect(existsSync(path.join(ws.dir, 'repo.py'))).toBe(true);
    // 같은 태스크를 다시 준비하면(재시도) 이미 있는 브랜치라 새로 딴 것이 아니다.
    expect(freshWorkspace('t1').startedFresh).toBe(false);
  });

  it('충돌하는 선행은 되돌리고 건너뛴다 — 작업 트리는 깨끗하고, 프롬프트가 "합치지 못했다"를 알린다', () => {
    const ws = freshWorkspace('t2');
    const merged = mergePredecessors(ws.dir, [preds.a, preds.conflicting]);
    expect(merged.merged.map((m) => m.taskId)).toEqual(['a']);
    expect(merged.failed).toEqual([{ predecessor: preds.conflicting, reason: '병합 충돌' }]);
    expect(git(ws.dir, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    const prompt = buildTaskPrompt(
      { task: { id: 't2', title: 'F-03', teamRole: 'BACKEND' }, repo: { fullName: 'acme/api' }, spec: null, notesBlock: '', writablePaths: [], predecessorMerge: merged },
      ws.branch,
    );
    expect(prompt).toContain('# 선행 작업 위에서 시작한다');
    expect(prompt).toContain('F-01 기반');
    expect(prompt).toContain('충돌 선행: 병합 충돌');
    expect(prompt).toContain('직접 다시 만들지 말고');
  });

  it('없는 커밋은 실패로 남긴다(지워진 선행 브랜치)', () => {
    const ws = freshWorkspace('t3');
    const missing = { ...preds.a, taskId: 'x', commitSha: 'f'.repeat(40), branchName: 'task/gone' };
    expect(mergePredecessors(ws.dir, [missing]).failed[0]?.reason).toMatch(/찾지 못했다/);
  });
});

describe('V3 — 선행 커밋을 비교 기준으로', () => {
  it('선행을 합쳐 시작한 태스크는 자기가 바꾼 파일만 변경으로 센다(기본 브랜치 기준이면 선행 파일까지 잡혀 FAIL이었다)', async () => {
    const ws = freshWorkspace('t4');
    mergePredecessors(ws.dir, [preds.a, preds.b]);
    writeFileSync(path.join(ws.dir, 'route.py'), 'def route():\n    return base()\n');
    git(ws.dir, 'add', 'route.py');
    git(ws.dir, ...ID, 'commit', '-q', '-m', 'F-03 route');
    git(ws.dir, 'push', '-q', 'origin', 'task/t4');
    const head = git(ws.dir, 'rev-parse', 'HEAD');

    const inspector = gitMirrorInspector(mirrors);
    const input = { repoId: 'r1', orgId: 'o1', cloneUrl: origin, githubRepoId: null, commitSha: head, baseBranch: 'main' };
    expect((await inspector.changedPaths(input)).sort()).toEqual(['app.py', 'repo.py', 'route.py']);
    expect(await inspector.changedPaths({ ...input, baseCommits: [preds.a.commitSha, preds.b.commitSha] })).toEqual(['route.py']);
  });

  it('선행을 합치지 않고 main에서 시작한 태스크(옛 CLI)도 자기 파일만 센다', async () => {
    git(origin, 'checkout', '-q', '-b', 'task/t5', 'main');
    writeFileSync(path.join(origin, 'route.py'), 'x\n');
    git(origin, 'add', 'route.py');
    git(origin, ...ID, 'commit', '-q', '-m', 'old cli');
    const head = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-q', 'main');
    const inspector = gitMirrorInspector(mirrors);
    const input = { repoId: 'r1', orgId: 'o1', cloneUrl: origin, githubRepoId: null, commitSha: head, baseBranch: 'main', baseCommits: [preds.a.commitSha] };
    expect(await inspector.changedPaths(input)).toEqual(['route.py']);
  });
});

describe('listPredecessorBases — 브리핑과 V3가 쓰는 한 벌', () => {
  beforeEach(() => truncateAll());

  it('같은 레포의 끝난 선행(선행의 선행까지)과 마지막 제출 커밋 — 다른 레포·안 끝난 선행은 뺀다', async () => {
    const { userId, orgId } = await createTestOrg('rep');
    const [api, web] = await connectRepos({
      orgId,
      actorUserId: userId,
      actorOrgRole: 'REPRESENTATIVE',
      repos: [{ fullName: 'acme/api', ownerRole: 'BACKEND' }, { fullName: 'acme/web', ownerRole: 'FRONTEND' }],
    });
    const { project } = await createProject(orgId, userId, { name: 'p', autonomyPreset: 'L2', pmBudgetUsd: 1, repoIds: [api!.id, web!.id] });
    const task = (title: string, repoId: string, dependsOn: string[]) =>
      createTask(userId, project.id, { title, teamRole: null, kind: 'INTEGRATION', repoId, specId: null, dependsOn });
    const a = await task('A 기반', api!.id, []);
    const fe = await task('FE 화면', web!.id, [a.id]);
    const b = await task('B 저장소', api!.id, [a.id]);
    const pending = await task('P 진행 중', api!.id, []);
    const c = await task('C 라우트', api!.id, [b.id, fe.id, pending.id]);

    // DONE으로 가는 서비스 경로는 제출·검증 전체라, 이 테스트는 선행의 상태와 제출 커밋만 직접 둔다.
    for (const t of [a, b, fe]) await pool.query(`UPDATE tasks SET state = 'DONE', branch_name = $2 WHERE id = $1`, [t.id, `task/${t.id}`]);
    const art = (taskId: string, sha: string) => insertArtifact(pool, { taskId, commitSha: sha, changedPaths: ['x'], triggeredActions: [], gateMode: 'AUTO' });
    await art(a.id, 'a1'.repeat(20));
    await art(a.id, 'a2'.repeat(20)); // 재시도 — 마지막 제출이 기준이다
    await art(b.id, 'b1'.repeat(20));
    await art(fe.id, 'f1'.repeat(20));

    expect(await listPredecessorBases(pool, c.id)).toEqual([
      { taskId: a.id, title: 'A 기반', branchName: `task/${a.id}`, commitSha: 'a2'.repeat(20) },
      { taskId: b.id, title: 'B 저장소', branchName: `task/${b.id}`, commitSha: 'b1'.repeat(20) },
    ]);
    expect(await listPredecessorBases(pool, a.id)).toEqual([]);
  });
});
