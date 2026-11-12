import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pool } from '../../config/db.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { findRepresentativeGithubToken } from '../oauth/repository.js';
import { findRepoById } from '../repo/repository.js';
import { decryptSecret } from '../../utils/secret-box.js';
import { mirrorRoot, syncMirror } from '../verification/commit-inspector.js';
import { findTaskBaseCommit, listPredecessorBases, setTaskBaseCommit, type PredecessorBase } from './repository.js';

const run = promisify(execFile);

// 태스크의 시작 기준점(036) — 같은 레포의 끝난 선행 태스크가 있으면 서버가 "기본 브랜치 최신 + 선행 커밋들"을 합친 커밋을 만든다.
//
// 태스크 브랜치는 기본 브랜치에 합쳐지지 않으므로 선행이 만든 코드 위에서 시작하려면 누군가 합쳐야 한다. 노트북(Executor)이 합치면(#86)
// V3는 그 결과를 알 수 없어 선행 커밋마다 비교해 교집합을 봤는데, 두 선행이 같은 파일(라우터 등록 파일 등)을 바꾸면 이 태스크가 안 건드려도
// 변경으로 잡혀 FAIL이었다. 서버가 합친 커밋을 만들어 두면 V3는 **그 커밋 하나와 제출 커밋**을 그대로 비교한다 — 추정이 없고,
// 서버가 만든 커밋이라 노트북이 보낸 값을 믿지 않는다. 선행끼리 충돌하면 에이전트를 돌리기 전에 여기서 드러난다.
//
// 구현은 둘이다(COMMIT_INSPECTOR를 따른다 — 읽는 곳과 쓰는 곳이 같아야 V3가 그 커밋을 본다):
//   github   대표의 GitHub 토큰으로 nomos/base/<태스크 id> 브랜치를 만들고 merges API로 선행을 합친다(운영 — 이미지에 git이 없다)
//   mirror   서버의 bare mirror에서 merge-tree·commit-tree로 합치고 clone_url(로컬 레포)에 그 브랜치를 push한다(로컬 개발)
// 만들지 못하면(충돌·권한·네트워크) null — 예전처럼 Executor가 합치고 V3는 교집합으로 본다. 실패가 태스크를 막지 않는다.

export const BASE_BRANCH_PREFIX = 'nomos/base/';

export function taskBaseBranch(taskId: string): string {
  return `${BASE_BRANCH_PREFIX}${taskId}`;
}

export type BaseBuildInput = {
  taskId: string;
  orgId: string;
  repoId: string;
  fullName: string;
  cloneUrl: string | null;
  defaultBranch: string;
  predecessors: PredecessorBase[];
};

// 합친 커밋, 또는 합치지 못한 선행(충돌). 그 밖의 실패(권한·네트워크·레포 설정)는 던진다.
export type BaseBuildResult = { commitSha: string } | { conflict: PredecessorBase };

export type BaseBuilder = {
  readonly kind: string;
  build(input: BaseBuildInput): Promise<BaseBuildResult>;
};

export const SHA40 = /^[0-9a-f]{40}$/;
const message = (p: PredecessorBase) => `nomos: 선행 태스크 합침 — ${p.title.slice(0, 120)}`;

// ── github ────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type GithubRepoCall = (method: string, path: string, body?: unknown) => Promise<Response>;

// 대표의 GitHub 토큰으로 /repos/{fullName}{path}를 부르는 함수 — 시작 기준점(036)과 기본 브랜치 병합(037, default-merge.ts)이 같이 쓴다.
export async function githubRepoCall(orgId: string, fullName: string, options: { fetchImpl?: FetchLike; apiBase?: string } = {}): Promise<GithubRepoCall> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const api = options.apiBase ?? 'https://api.github.com';
  const sealed = await findRepresentativeGithubToken(pool, orgId);
  if (sealed === null) throw new Error('GitHub 미연결 — 대표가 GitHub 계정을 연결하지 않았다');
  const token = await decryptSecret(sealed);
  return async (method, path, body) =>
    fetchImpl(`${api}/repos/${fullName.split('/').map(encodeURIComponent).join('/')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nomos-server',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
}

export function githubBaseBuilder(options: { fetchImpl?: FetchLike; apiBase?: string } = {}): BaseBuilder {
  return {
    kind: 'github',
    async build(input) {
      const call = await githubRepoCall(input.orgId, input.fullName, options);
      const branch = taskBaseBranch(input.taskId);

      const head = await call('GET', `/git/ref/heads/${input.defaultBranch.split('/').map(encodeURIComponent).join('/')}`);
      if (!head.ok) throw new Error(`기본 브랜치를 읽지 못했다(GitHub ${head.status})`);
      let sha = ((await head.json()) as { object?: { sha?: string } }).object?.sha ?? '';
      if (!SHA40.test(sha)) throw new Error('기본 브랜치 커밋을 알 수 없다');

      // 같은 태스크로 다시 만들면(브리핑 동시 요청) 기본 브랜치 머리로 되돌리고 다시 합친다 — 결과는 같다.
      const created = await call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
      if (created.status === 422) {
        const reset = await call('PATCH', `/git/refs/heads/${branch}`, { sha, force: true });
        if (!reset.ok) throw new Error(`기준점 브랜치를 맞추지 못했다(GitHub ${reset.status})`);
      } else if (!created.ok) {
        throw new Error(`기준점 브랜치를 만들지 못했다(GitHub ${created.status})`);
      }

      for (const p of input.predecessors) {
        const merged = await call('POST', '/merges', { base: branch, head: p.commitSha, commit_message: message(p) });
        if (merged.status === 409) return { conflict: p };
        if (merged.status === 204) continue; // 이미 들어 있다
        if (!merged.ok) throw new Error(`선행 ${p.commitSha.slice(0, 12)}을 합치지 못했다(GitHub ${merged.status})`);
        sha = ((await merged.json()) as { sha?: string }).sha ?? '';
        if (!SHA40.test(sha)) throw new Error('병합 커밋을 알 수 없다');
      }
      return { commitSha: sha };
    },
  };
}

// ── mirror(로컬 개발) ─────────────────────────────────────────────────────

export const IDENTITY = { GIT_AUTHOR_NAME: 'nomos', GIT_AUTHOR_EMAIL: 'nomos@localhost', GIT_COMMITTER_NAME: 'nomos', GIT_COMMITTER_EMAIL: 'nomos@localhost' };

export function mirrorBaseBuilder(root: string = mirrorRoot()): BaseBuilder {
  return {
    kind: 'git-mirror',
    async build(input) {
      if (input.cloneUrl === null) throw new Error('repos.clone_url 미설정');
      const dir = await syncMirror(root, input.repoId, input.cloneUrl);
      const git = async (args: string[]) => (await run('git', ['--git-dir', dir, ...args], { env: { ...process.env, ...IDENTITY } })).stdout.trim();
      const isAncestor = async (a: string, b: string) => {
        try {
          await git(['merge-base', '--is-ancestor', a, b]);
          return true;
        } catch {
          return false;
        }
      };
      let sha = await git(['rev-parse', '--verify', `refs/heads/${input.defaultBranch}^{commit}`]);
      for (const p of input.predecessors) {
        if (!SHA40.test(p.commitSha)) throw new Error(`선행 커밋 형식이 아니다: ${p.commitSha.slice(0, 80)}`);
        if (await isAncestor(p.commitSha, sha)) continue;
        if (await isAncestor(sha, p.commitSha)) {
          sha = p.commitSha;
          continue;
        }
        let tree: string;
        try {
          // 작업 트리 없이 합친다(git 2.38+). 충돌이면 종료 코드 1.
          tree = (await git(['merge-tree', '--write-tree', sha, p.commitSha])).split('\n')[0]!;
        } catch {
          return { conflict: p };
        }
        sha = await git(['commit-tree', tree, '-p', sha, '-p', p.commitSha, '-m', message(p)]);
      }
      // Executor가 받을 수 있게 레포(clone_url)에 브랜치로 둔다. mirror는 다음 갱신 때 이 브랜치를 함께 받는다.
      await git(['push', '--quiet', '--force', '--', input.cloneUrl, `${sha}:refs/heads/${taskBaseBranch(input.taskId)}`]);
      return { commitSha: sha };
    },
  };
}

let builder: BaseBuilder | null = null;

export function getBaseBuilder(): BaseBuilder {
  builder ??= env.COMMIT_INSPECTOR === 'github' ? githubBaseBuilder() : mirrorBaseBuilder();
  return builder;
}

// 테스트용. 운영 코드에서는 부르지 않는다.
export function setBaseBuilder(next: BaseBuilder | null): void {
  builder = next;
}

export type TaskBase = { branchName: string; commitSha: string };

// 브리핑이 부른다(트랜잭션 밖 — GitHub·git을 탄다). 이미 있으면 그대로, 선행이 없으면 null, 만들지 못하면 null(로그만).
export async function ensureTaskBase(task: { id: string; repoId: string }): Promise<TaskBase | null> {
  const existing = await findTaskBaseCommit(pool, task.id);
  if (existing) return { branchName: taskBaseBranch(task.id), commitSha: existing };
  const predecessors = await listPredecessorBases(pool, task.id);
  if (predecessors.length === 0) return null;
  const repo = await findRepoById(pool, task.repoId);
  if (!repo) return null;
  try {
    const result = await getBaseBuilder().build({
      taskId: task.id,
      orgId: repo.orgId,
      repoId: repo.id,
      fullName: repo.fullName,
      cloneUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch,
      predecessors,
    });
    if ('conflict' in result) {
      logger.warn('선행 태스크끼리 충돌해 시작 기준점을 만들지 못했다 — Executor가 합치며 모델에게 알린다', {
        taskId: task.id,
        conflictWith: result.conflict.taskId,
      });
      return null;
    }
    return { branchName: taskBaseBranch(task.id), commitSha: await setTaskBaseCommit(pool, task.id, result.commitSha) };
  } catch (err) {
    logger.warn('시작 기준점을 만들지 못했다 — Executor가 선행을 합치는 예전 방식으로 돈다', { taskId: task.id, err: String(err) });
    return null;
  }
}
