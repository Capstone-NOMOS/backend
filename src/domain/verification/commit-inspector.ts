import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pool } from '../../config/db.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { githubInspector } from './github-inspector.js';
import { CommitNotFoundError, InspectionSkipped, type CommitInspector } from './inspection.js';

export { CommitNotFoundError, InspectionSkipped, type CommitInspector, type InspectInput } from './inspection.js';

const run = promisify(execFile);

// 커밋이 **실제로** 무엇을 건드렸는지 읽는다.
//
// 이 인터페이스가 있는 이유는 V3의 전제 때문이다. 제출자가 신고한 changed_paths를 그대로 믿고
// 검사하면, 신고에서 빼버린 파일은 아무 검사도 받지 않는다 — 그러면 경로 검사는 정직한 실수만
// 잡고 의도적인 우회는 못 잡는다. 그래서 diff의 출처는 제출자가 아니어야 한다.
//
// 구현체는 둘이다. COMMIT_INSPECTOR로 고르고 기본값은 없다.
//   mirror   서버가 레포를 bare mirror로 들고 fetch한다 (로컬 개발 — clone_url이 로컬 경로)
//   github   GitHub 커밋 API로 파일 목록만 읽는다 (배포 — 코드 내용은 받지도 저장하지도 않는다)
// 호출부(verification/service.ts)는 어느 쪽인지 모른다.

// 서버가 bare mirror를 두는 곳. 시드가 옛 mirror를 지울 때도 이 함수를 쓴다 —
// 경로 계산이 두 벌이 되면 한쪽만 고쳐져 아무도 안 지우는 고아가 남는다.
export function mirrorRoot(): string {
  return process.env.GIT_MIRROR_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.nomos', 'server-mirrors');
}

// bare mirror를 레포마다 하나씩 들고 fetch로 갱신한다. 작업 트리를 만들지 않으므로
// 동시에 여러 커밋을 검사해도 서로 간섭하지 않는다 (checkout이 없다).
export function gitMirrorInspector(root: string = mirrorRoot()): CommitInspector {
  return {
    kind: 'git-mirror',
    async changedPaths({ repoId, cloneUrl, commitSha }) {
      if (cloneUrl === null) {
        throw new InspectionSkipped('repos.clone_url 미설정 — 커밋 diff를 읽을 수 없다');
      }
      const dir = path.join(root, `${repoId}.git`);

      if (!existsSync(dir)) {
        await mkdir(path.dirname(dir), { recursive: true });
        // '--' 뒤에 둔다. clone_url은 validateCloneUrl이 이미 거르지만(-로 시작 금지), 옵션 주입을 한 겹 더 막는다.
        await run('git', ['clone', '--mirror', '--', cloneUrl, dir]);
      } else {
        // clone_url은 PATCH /repos/:repoId로 바뀔 수 있다. 기존 mirror는 옛 주소를 들고 있으므로 매번 맞춘다 —
        // 안 그러면 바뀐 뒤에도 옛 원격에서 받아 와 새 커밋을 "없는 커밋(FAIL)"으로 판정한다.
        await run('git', ['--git-dir', dir, 'remote', 'set-url', 'origin', '--', cloneUrl]);
        // mirror의 갱신은 fetch가 아니라 remote update다. refspec이 이미 mirror용으로 박혀 있다.
        try {
          await run('git', ['--git-dir', dir, 'remote', 'update', '--prune']);
        } catch (err) {
          // 갱신 실패는 치명적이지 않다 — 찾는 커밋이 이미 있으면 그대로 진행한다.
          logger.warn('mirror 갱신 실패, 기존 오브젝트로 진행', { repoId, err: String(err) });
        }
      }

      let stdout: string;
      try {
        // --root: 첫 커밋(부모 없음)도 diff가 나오게 한다. 없으면 빈 결과가 나와
        // "아무것도 안 바꿨다"로 잘못 읽힌다.
        ({ stdout } = await run('git', [
          '--git-dir',
          dir,
          'diff-tree',
          '--no-commit-id',
          '--name-only',
          '--root',
          '-r',
          commitSha,
        ]));
      } catch (err) {
        throw new CommitNotFoundError(commitSha, err);
      }

      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    },
  };
}

// 호출부가 매번 구현체를 고르지 않도록 선택을 한 곳에 둔다.
// 처음 쓸 때 만든다 — import 시점에 만들면 테스트가 바꿔 끼우기 전에 github 구현체가 DB를 붙잡는다.
let inspector: CommitInspector | null = null;

export function getCommitInspector(): CommitInspector {
  inspector ??= env.COMMIT_INSPECTOR === 'github' ? githubInspector({ db: pool }) : gitMirrorInspector();
  return inspector;
}

// 테스트가 실제 git·GitHub 없이 돌 수 있게 한다. 운영 코드에서는 부르지 않는다.
export function setCommitInspector(next: CommitInspector): void {
  inspector = next;
}
