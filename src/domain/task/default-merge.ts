import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../../config/env.js';
import { mirrorRoot, syncMirror } from '../verification/commit-inspector.js';
import { githubRepoCall, IDENTITY, SHA40, type FetchLike } from './task-base.js';

const run = promisify(execFile);

// 완료 태스크를 기본 브랜치에 합친다(037) — 실험 모드 + projects.auto_merge 프로젝트에서만 자동 진행(experiment/autopilot.ts)이 부른다.
//
// 태스크 브랜치는 기본 브랜치에 합쳐지지 않아서 다음 요구사항의 태스크가 앞 기능의 코드를 보지 못했다(선행으로 묶인 태스크만 시작 기준점(036)으로 받는다).
// 기능을 쌓아 큰 앱을 키우는 실험은 끝난 태스크를 main에 합쳐야 성립한다. 새 태스크는 Executor가 origin/<기본 브랜치>에서 분기하므로 합친 코드 위에서 시작한다.
// V3는 그대로다 — 태스크 브랜치와 기본 브랜치의 분기점부터 보므로, 그 사이 main이 앞으로 가도 이 태스크의 변경만 센다.
//
// 구현은 시작 기준점과 같이 둘이다(COMMIT_INSPECTOR를 따른다):
//   github   대표 토큰으로 merges API(base = 기본 브랜치, head = 제출 커밋). 201 합침 · 204 이미 들어 있음 · 409 충돌
//   mirror   서버 mirror에서 merge-tree·commit-tree로 합치고 clone_url의 기본 브랜치에 push(force 없음 — 그 사이 움직였으면 실패하고 다음에 다시)
// 충돌은 결과로 돌려준다(다시 해도 같다 — 이벤트로 남기고 다시 시도하지 않는다). 그 밖의 실패(권한·네트워크)는 던진다 — 다음 신호·주기 정리에서 다시 본다.

export type DefaultMergeInput = {
  taskId: string;
  title: string;
  orgId: string;
  repoId: string;
  fullName: string;
  cloneUrl: string | null;
  defaultBranch: string;
  commitSha: string;
};

export type DefaultMergeResult = { result: 'merged'; mergeCommit: string } | { result: 'already' } | { result: 'conflict' };

export type DefaultMerger = {
  readonly kind: string;
  merge(input: DefaultMergeInput): Promise<DefaultMergeResult>;
};

const message = (input: DefaultMergeInput) => `nomos: 완료 태스크 합침 — ${input.title.slice(0, 120)}`;

export function githubDefaultMerger(options: { fetchImpl?: FetchLike; apiBase?: string } = {}): DefaultMerger {
  return {
    kind: 'github',
    async merge(input) {
      if (!SHA40.test(input.commitSha)) throw new Error(`커밋 형식이 아니다: ${input.commitSha.slice(0, 80)}`);
      const call = await githubRepoCall(input.orgId, input.fullName, options);
      const res = await call('POST', '/merges', { base: input.defaultBranch, head: input.commitSha, commit_message: message(input) });
      if (res.status === 409) return { result: 'conflict' };
      if (res.status === 204) return { result: 'already' };
      if (!res.ok) throw new Error(`기본 브랜치에 합치지 못했다(GitHub ${res.status})`);
      const sha = ((await res.json()) as { sha?: string }).sha ?? '';
      if (!SHA40.test(sha)) throw new Error('병합 커밋을 알 수 없다');
      return { result: 'merged', mergeCommit: sha };
    },
  };
}

export function mirrorDefaultMerger(root: string = mirrorRoot()): DefaultMerger {
  return {
    kind: 'git-mirror',
    async merge(input) {
      if (input.cloneUrl === null) throw new Error('repos.clone_url 미설정');
      if (!SHA40.test(input.commitSha)) throw new Error(`커밋 형식이 아니다: ${input.commitSha.slice(0, 80)}`);
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
      const head = await git(['rev-parse', '--verify', `refs/heads/${input.defaultBranch}^{commit}`]);
      if (await isAncestor(input.commitSha, head)) return { result: 'already' };
      let next: string;
      if (await isAncestor(head, input.commitSha)) {
        next = input.commitSha;
      } else {
        let tree: string;
        try {
          tree = (await git(['merge-tree', '--write-tree', head, input.commitSha])).split('\n')[0]!;
        } catch {
          return { result: 'conflict' };
        }
        next = await git(['commit-tree', tree, '-p', head, '-p', input.commitSha, '-m', message(input)]);
      }
      // force 없이 — 레포의 기본 브랜치가 그 사이 움직였으면 거부되고(던진다) 다음에 새 머리로 다시 합친다.
      await git(['push', '--quiet', '--', input.cloneUrl, `${next}:refs/heads/${input.defaultBranch}`]);
      return { result: 'merged', mergeCommit: next };
    },
  };
}

let merger: DefaultMerger | null = null;

export function getDefaultMerger(): DefaultMerger {
  merger ??= env.COMMIT_INSPECTOR === 'github' ? githubDefaultMerger() : mirrorDefaultMerger();
  return merger;
}

// 테스트용. 운영 코드에서는 부르지 않는다.
export function setDefaultMerger(next: DefaultMerger | null): void {
  merger = next;
}
