import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// git의 경고(빈 레포 클론 등)가 테스트 출력에 섞이지 않게 stderr는 삼킨다. 실패는 종료 코드로 드러난다.
const QUIET = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
import { PushRefused, pushTaskBranch } from '../src/bridge/push.js';

// 실제 git으로 확인한다. push 규칙은 "git이 실제로 무엇을 하는가"가 전부라 흉내 내면 검증 대상이 사라진다.
// 각 테스트가 임시 디렉터리에 bare 원격(remote.git)과 작업 클론(work)을 새로 만든다.

const TASK = 'task/T-042-join-api';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], QUIET).trim();
}

function commit(cwd: string, file: string, content: string): string {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', `edit ${file}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

// main에 커밋 하나를 올린 원격과, 태스크 브랜치에 커밋 하나를 더 얹은 작업 클론.
function setup(): { root: string; remote: string; work: string; sha: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'nomos-push-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', '--bare', remote], QUIET);
  execFileSync('git', ['clone', '-q', remote, work], QUIET);
  git(work, 'checkout', '-q', '-b', 'main');
  commit(work, 'README.md', 'hello');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', TASK);
  const sha = commit(work, 'join.ts', 'export {}');
  return { root, remote, work, sha };
}

const remoteHead = (remote: string, branch: string): string | null => {
  try {
    return execFileSync('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`], QUIET).trim();
  } catch {
    return null;
  }
};

async function refused(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PushRefused);
  return (err as PushRefused).message;
}

describe('submit_artifact의 push', () => {
  it('서버에 기록된 태스크 브랜치를 push하고, 원격에 그 커밋이 올라간다', async () => {
    const { work, remote, sha } = setup();

    const outcome = await pushTaskBranch({ workspaceDir: work, commitSha: sha, taskBranch: TASK, protectedBranches: [] });

    expect(outcome).toEqual({ pushed: true, branch: TASK });
    expect(remoteHead(remote, TASK)).toBe(sha);
  });

  it('main·dev·default_branch·dev_branch로는 push하지 않는다 — 대소문자를 바꿔도 막힌다', async () => {
    const { work, remote, sha } = setup();
    git(work, 'checkout', '-q', '-b', 'develop');

    for (const [taskBranch, protectedBranches] of [
      ['main', []],
      ['dev', []],
      ['Main', []],
      ['develop', ['main', 'develop']], // 레포의 dev_branch가 develop인 경우
      ['trunk', ['trunk', 'dev']], // 레포의 default_branch가 trunk인 경우
    ] as const) {
      const message = await refused(
        pushTaskBranch({ workspaceDir: work, commitSha: sha, taskBranch, protectedBranches: [...protectedBranches] }),
      );
      expect(message).toContain('push하지 않는다');
    }
    expect(remoteHead(remote, 'develop')).toBeNull();
  });

  it('서버에 브랜치가 기록되지 않았으면 push하지 않는다', async () => {
    const { work, sha } = setup();
    expect(await refused(pushTaskBranch({ workspaceDir: work, commitSha: sha, taskBranch: null, protectedBranches: [] }))).toContain(
      '기록되지 않았다',
    );
  });

  it('작업공간이 태스크 브랜치에 있지 않으면 push하지 않는다', async () => {
    const { work, remote, sha } = setup();
    git(work, 'checkout', '-q', 'main');

    expect(await refused(pushTaskBranch({ workspaceDir: work, commitSha: sha, taskBranch: TASK, protectedBranches: [] }))).toContain(
      'main에 있다',
    );
    expect(remoteHead(remote, TASK)).toBeNull();
  });

  it('제출하려는 커밋이 태스크 브랜치에 없으면 push하지 않는다', async () => {
    const { work, sha } = setup();
    git(work, 'checkout', '-q', 'main');
    const elsewhere = commit(work, 'other.ts', 'x');
    git(work, 'checkout', '-q', TASK);

    expect(
      await refused(pushTaskBranch({ workspaceDir: work, commitSha: elsewhere, taskBranch: TASK, protectedBranches: [] })),
    ).toContain('태스크 브랜치');
    // 원래 커밋은 여전히 정상적으로 push된다 — 거부가 작업공간을 망가뜨리지 않았다.
    await expect(pushTaskBranch({ workspaceDir: work, commitSha: sha, taskBranch: TASK, protectedBranches: [] })).resolves.toMatchObject({
      pushed: true,
    });
  });

  it('원격이 앞서 나가 있으면 force로 덮지 않고 실패한다', async () => {
    const { root, work, remote, sha } = setup();
    await pushTaskBranch({ workspaceDir: work, commitSha: sha, taskBranch: TASK, protectedBranches: [] });

    // 다른 곳에서 같은 태스크 브랜치에 커밋을 올린다.
    const other = path.join(root, 'other');
    execFileSync('git', ['clone', '-q', '-b', TASK, remote, other], QUIET);
    const theirs = commit(other, 'theirs.ts', 'x');
    git(other, 'push', '-q', 'origin', TASK);

    // 로컬은 원격을 모른 채 새 커밋을 얹었다 — fast-forward가 아니다.
    git(work, 'reset', '-q', '--hard', sha);
    const mine = commit(work, 'mine.ts', 'y');

    expect(await refused(pushTaskBranch({ workspaceDir: work, commitSha: mine, taskBranch: TASK, protectedBranches: [] }))).toContain(
      'push 실패',
    );
    expect(remoteHead(remote, TASK)).toBe(theirs); // 원격은 그대로다
  });

  it('원격(origin)이 없는 로컬 데모 레포는 push를 건너뛴다 — mirror 모드', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nomos-push-local-'));
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', root], QUIET);
    git(root, 'checkout', '-q', '-b', TASK);
    const sha = commit(root, 'a.ts', 'x');

    await expect(pushTaskBranch({ workspaceDir: root, commitSha: sha, taskBranch: TASK, protectedBranches: [] })).resolves.toEqual({
      pushed: false,
      reason: 'no-remote',
    });
  });

  it('git 에러 메시지에 원격 URL의 자격 증명이 있으면 지우고 돌려준다', async () => {
    const { work, sha } = setup();
    git(work, 'remote', 'set-url', 'origin', 'https://someone:ghp_secret_value@127.0.0.1:1/x.git');

    const message = await refused(pushTaskBranch({ workspaceDir: work, commitSha: sha, taskBranch: TASK, protectedBranches: [] }));
    expect(message).not.toContain('ghp_secret_value');
  });
});
