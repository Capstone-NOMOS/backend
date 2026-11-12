import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mirrorDefaultMerger, type DefaultMergeInput } from '../src/domain/task/default-merge.js';

// 완료 태스크를 기본 브랜치에 합치기(037) — mirror 구현을 실제 git으로 본다(운영 github 구현은 같은 결과를 merges API로 낸다).
// 레포는 bare다 — 서버가 push하는 곳(clone_url)이고, 작업 트리가 있는 레포의 체크아웃된 브랜치에는 push가 거부된다.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

let work: string;
let origin: string;
let dev: string;
let mirrors: string;

// 개발자 클론에서 main으로부터 브랜치를 따서 파일을 쓰고 push한다(에이전트의 태스크 브랜치 흉내).
function taskCommit(branch: string, file: string, content: string): string {
  git(dev, 'fetch', '-q', 'origin');
  git(dev, 'checkout', '-q', '-B', branch, 'origin/main');
  writeFileSync(path.join(dev, file), content);
  git(dev, 'add', file);
  git(dev, ...ID, 'commit', '-q', '-m', branch);
  git(dev, 'push', '-q', '-f', 'origin', branch);
  return git(dev, 'rev-parse', 'HEAD');
}

const input = (taskId: string, commitSha: string): DefaultMergeInput => ({
  taskId, title: `태스크 ${taskId}`, orgId: 'o1', repoId: 'r1', fullName: 'acme/api', cloneUrl: origin, defaultBranch: 'main', commitSha,
});

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'nomos-merge-'));
  origin = path.join(work, 'origin.git');
  dev = path.join(work, 'dev');
  mirrors = path.join(work, 'mirrors');
  git(work, 'init', '-q', '--bare', '-b', 'main', origin);
  git(work, 'clone', '-q', origin, dev);
  git(dev, 'checkout', '-q', '-b', 'main');
  writeFileSync(path.join(dev, 'app.py'), 'line 1\nline 2\nline 3\nline 4\nline 5\n');
  git(dev, 'add', 'app.py');
  git(dev, ...ID, 'commit', '-q', '-m', 'base');
  git(dev, 'push', '-q', 'origin', 'main');
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('mirrorDefaultMerger', () => {
  it('끝난 태스크를 끝난 순서대로 main에 합친다 — 먼저 끝난 것은 빨리 감기, 나란히 끝난 것은 병합 커밋 · 이미 들어 있으면 already', async () => {
    const a = taskCommit('task/a', 'list.py', 'list\n');
    const b = taskCommit('task/b', 'detail.py', 'detail\n'); // a와 같은 main에서 땄다(나란히 진행)
    const merger = mirrorDefaultMerger(mirrors);

    expect(await merger.merge(input('a', a))).toEqual({ result: 'merged', mergeCommit: a });
    const second = await merger.merge(input('b', b));
    expect(second.result).toBe('merged');
    const main = git(origin, 'rev-parse', 'main');
    if (second.result === 'merged') expect(second.mergeCommit).toBe(main);
    expect(git(origin, 'ls-tree', '--name-only', 'main').split('\n').sort()).toEqual(['app.py', 'detail.py', 'list.py']);

    expect(await merger.merge(input('a', a))).toEqual({ result: 'already' });
    expect(git(origin, 'rev-parse', 'main')).toBe(main);
  });

  it('main과 충돌하면 conflict를 돌려주고 main을 건드리지 않는다', async () => {
    const x = taskCommit('task/x', 'app.py', 'line 1\nX\nline 3\nline 4\nline 5\n');
    const y = taskCommit('task/y', 'app.py', 'line 1\nY\nline 3\nline 4\nline 5\n');
    const merger = mirrorDefaultMerger(mirrors);
    expect((await merger.merge(input('x', x))).result).toBe('merged');
    const main = git(origin, 'rev-parse', 'main');
    expect(await merger.merge(input('y', y))).toEqual({ result: 'conflict' });
    expect(git(origin, 'rev-parse', 'main')).toBe(main);
  });
});
