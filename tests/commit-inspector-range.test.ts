import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/config/db.js';
import { gitMirrorInspector } from '../src/domain/verification/commit-inspector.js';

// mirror 검사기가 태스크 브랜치 전체(기본 브랜치와의 분기점 ... 제출 커밋)를 보는지 실제 git으로 확인한다.
// 통합 테스트: 재시도로 커밋이 3개 쌓인 브랜치를 마지막 커밋 하나로만 봐서 앞 커밋의 파일이 "과다 신고" FAIL이 됐다.

let work: string;
let origin: string;
let mirrors: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function commit(file: string, message: string): string {
  writeFileSync(path.join(origin, file), `${message}\n`);
  git(origin, 'add', file);
  git(origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  return git(origin, 'rev-parse', 'HEAD');
}

let mainSha: string;
let branchHead: string;

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'nomos-range-'));
  origin = path.join(work, 'origin');
  mirrors = path.join(work, 'mirrors');
  git(work, 'init', '-q', '-b', 'main', origin);
  commit('README.md', 'base');
  git(origin, 'checkout', '-q', '-b', 'task/t1');
  commit('a.ts', 'attempt 1');
  commit('b.ts', 'attempt 2');
  branchHead = commit('c.ts', 'attempt 3');
  git(origin, 'checkout', '-q', 'main');
  mainSha = commit('main-only.ts', 'other work on main');
});

afterAll(async () => {
  rmSync(work, { recursive: true, force: true });
  await pool.end();
});

const input = (commitSha: string, baseBranch: string | null) => ({
  repoId: 'r1',
  orgId: 'o1',
  cloneUrl: origin,
  githubRepoId: null,
  commitSha,
  baseBranch,
});

describe('gitMirrorInspector — 태스크 브랜치 비교', () => {
  it('기본 브랜치를 주면 분기점부터 제출 커밋까지의 파일 전부(기본 브랜치에만 있는 변경은 빼고)', async () => {
    const inspector = gitMirrorInspector(mirrors);
    expect((await inspector.changedPaths(input(branchHead, 'main'))).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('기본 브랜치가 없거나 못 찾으면 커밋 하나(예전 동작)', async () => {
    const inspector = gitMirrorInspector(mirrors);
    expect(await inspector.changedPaths(input(branchHead, null))).toEqual(['c.ts']);
    expect(await inspector.changedPaths(input(branchHead, 'no-such-branch'))).toEqual(['c.ts']);
  });

  it('커밋이 이미 기본 브랜치에 들어가 있으면 커밋 하나로 본다(비교가 비지 않게)', async () => {
    const inspector = gitMirrorInspector(mirrors);
    expect(await inspector.changedPaths(input(mainSha, 'main'))).toEqual(['main-only.ts']);
  });

  it('package.json "직전" 내용은 분기점에서 읽는다', async () => {
    const inspector = gitMirrorInspector(mirrors);
    await inspector.changedPaths(input(branchHead, 'main')); // mirror 준비
    expect(await inspector.fileVersions!(input(branchHead, 'main'), 'a.ts')).toEqual({ before: null, after: 'attempt 1\n' });
  });
});
