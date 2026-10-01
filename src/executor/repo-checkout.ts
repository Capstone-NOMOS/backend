import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRepoMap, repoMapPath } from './workspace.js';

// 태스크의 레포를 이 노트북 어디서 찾을까. 사람이 경로를 적게 하지 않는다 — CLI가 받아 둔다.
//   1) ~/.nomos/repos.json에 적힌 경로가 있으면 그걸 쓴다(이미 받아 둔 레포를 쓰고 싶은 사람·시드용, 그대로 쓴다).
//   2) 없으면 ~/.nomos/repos/<조직>/<레포>에 클론해 두고 쓴다. 이 클론은 CLI가 관리하므로 태스크마다 fetch하고
//      origin/<기본 브랜치>에서 분기한다 — 다른 팀원이 합친 작업 위에서 시작해야 한다.
// 비공개 레포는 사용자의 git 자격 증명(Git Credential Manager·gh auth login)으로 받는다. 서버는 git 비밀값을 주지 않는다.

export type RepoCheckout = { path: string; managed: boolean; baseRef: (branch: string) => string };

export function managedReposRoot(): string {
  return path.join(os.homedir(), '.nomos', 'repos');
}

// owner/repo. 클론 경로(~/.nomos/repos/<owner>/<repo>)가 되므로 '.'·'..' 세그먼트는 받지 않는다(폴더 밖으로 나간다).
const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function isFullName(value: string): boolean {
  return FULL_NAME.test(value) && value.split('/').every((part) => part !== '.' && part !== '..');
}

// 서버가 준 clone_url을 그대로 git에 넘기지 않는다. 서버도 검증하지만(validateCloneUrl) 이건 사용자 노트북에서 도는 명령이다.
// https(자격 증명 없는)·로컬 절대 경로·file://만. `-`로 시작(옵션 주입)·ext::·ssh·http는 거부.
export function resolveCloneSource(fullName: string, cloneUrl: string | null): string {
  if (cloneUrl === null) {
    if (!isFullName(fullName)) throw new Error(`레포 이름이 owner/repo 형식이 아니다: ${fullName}`);
    return `https://github.com/${fullName}.git`;
  }
  const value = cloneUrl.trim();
  if (value.startsWith('-') || value.includes('::')) throw new Error(`받을 수 없는 clone 주소: ${cloneUrl}`);
  if (/^https:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password) throw new Error('clone 주소에 자격 증명이 들어 있다 — 받지 않는다');
    return value;
  }
  if (/^file:\/\//i.test(value) || path.isAbsolute(value)) return value;
  throw new Error(`받을 수 없는 clone 주소(https·로컬 경로만): ${cloneUrl}`);
}

function isGitRepo(dir: string): boolean {
  return existsSync(path.join(dir, '.git'));
}

export type EnsureRepoDeps = {
  log?: (line: string) => void;
  // 테스트가 바꿔 낀다. 기본은 터미널을 물려줘서 진행 상황과 자격 증명 창이 보이게 한다.
  git?: (args: string[], cwd: string) => void;
  root?: string;
  readMap?: () => Record<string, string>;
};

const defaultGit = (args: string[], cwd: string) => {
  execFileSync('git', args, { cwd, stdio: 'inherit' });
};

export function ensureRepo(repo: { fullName: string; cloneUrl: string | null }, deps: EnsureRepoDeps = {}): RepoCheckout {
  const log = deps.log ?? (() => {});
  const git = deps.git ?? defaultGit;

  const mapped = (deps.readMap ?? readRepoMap)()[repo.fullName];
  if (mapped) {
    if (!isGitRepo(mapped)) throw new Error(`${repoMapPath()}의 "${repo.fullName}" 경로(${mapped})가 git 레포가 아니다`);
    return { path: mapped, managed: false, baseRef: (b) => b };
  }

  if (!isFullName(repo.fullName)) throw new Error(`레포 이름이 owner/repo 형식이 아니다: ${repo.fullName}`);
  const [owner, name] = repo.fullName.split('/') as [string, string];
  const dir = path.join(deps.root ?? managedReposRoot(), owner, name);

  if (isGitRepo(dir)) {
    log(`레포 최신화: ${repo.fullName}`);
    git(['fetch', '--prune', 'origin'], dir);
  } else {
    if (existsSync(dir)) throw new Error(`${dir}가 있지만 git 레포가 아니다. 지우고 다시 실행하라`);
    const source = resolveCloneSource(repo.fullName, repo.cloneUrl);
    log(`레포 받는 중: ${repo.fullName} → ${dir}`);
    mkdirSync(path.dirname(dir), { recursive: true });
    try {
      // `--`로 주소가 옵션으로 해석되지 않게 한 겹 더 막는다(서버 mirror 검사기와 같은 방식).
      git(['clone', '--', source, dir], path.dirname(dir));
    } catch (err) {
      throw new Error(
        `${repo.fullName}을 받지 못했다. 이 노트북의 git이 그 레포에 접근할 수 있어야 한다(gh auth login 또는 Git Credential Manager). ` +
          `이미 받아 둔 레포를 쓰려면 ${repoMapPath()}에 {"${repo.fullName}": "경로"}를 적어라. (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return { path: dir, managed: true, baseRef: (b) => `origin/${b}` };
}
