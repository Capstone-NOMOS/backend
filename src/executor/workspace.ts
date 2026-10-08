import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { nomosHome } from '../bridge/credentials.js';
import path from 'node:path';

// 작업공간은 레포 자체와 분리한다. git worktree로 분기하므로 사용자의 기존 작업 트리를 건드리지 않는다.
// 태스크가 끝나도 남긴다 — 실패 원인은 로그가 아니라 남은 파일에서 드러나는 경우가 많다.
export function workspacesRoot(): string {
  return path.join(nomosHome(), 'workspaces');
}

export function workspaceDir(projectId: string, taskId: string): string {
  return path.join(workspacesRoot(), projectId, taskId);
}

// 레포 fullName → 이미 받아 둔 로컬 경로(선택). 없으면 CLI가 ~/.nomos/repos/에 받는다(repo-checkout.ts).
export function repoMapPath(): string {
  return path.join(nomosHome(), 'repos.json');
}

// 없으면 빈 맵. 시드는 "적힌 것만" 쓰면 되므로 실패시키지 않는다.
export function readRepoMap(): Record<string, string> {
  const file = repoMapPath();
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>;
}

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' }).trim();
}

function branchExists(repoPath: string, branch: string): boolean {
  return refExists(repoPath, `refs/heads/${branch}`);
}

function refExists(repoPath: string, ref: string): boolean {
  try {
    // stdio를 삼킨다 — 없는 브랜치면 git이 stderr에 fatal을 찍어 로그를 더럽힌다.
    execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
      cwd: repoPath,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export type PreparedWorkspace = {
  dir: string;
  branch: string;
  createdBranch: boolean;
  settingsPath: string;
};

export type PrepareInput = {
  repoPath: string;
  projectId: string;
  taskId: string;
  branchName: string | null;
  baseBranch: string;
  settings: unknown;
  policyHash: string;
};

// .claude/settings.json이 **로컬 방어선**이다. 서버의 제출 시점 검증과 두 겹을 이룬다.
// 생성에 쓴 policy_hash를 같이 남겨 둔다 — 나중에 agents.settings_hash 대조에 쓴다.
export function prepareWorkspace(input: PrepareInput): PreparedWorkspace {
  const dir = workspaceDir(input.projectId, input.taskId);
  const branch = input.branchName ?? `task/${input.taskId}`;
  const existed = branchExists(input.repoPath, branch);

  excludeNomosFiles(input.repoPath);

  if (!existsSync(dir)) {
    mkdirSync(path.dirname(dir), { recursive: true });
    // 재시도(검증 실패·반려)는 같은 태스크 브랜치에서 **이어서** 고친다. 이 노트북에 브랜치가 없어도(다른 노트북에서 했거나 새로 받은 클론)
    // origin에 있으면 거기서 이어 간다 — 기본 브랜치에서 새로 따면 이전 작업이 안 보이고, 제출 때 push가 갈라진 이력으로 거부된다.
    const remote = `refs/remotes/origin/${branch}`;
    const args = existed
      ? ['worktree', 'add', dir, branch]
      : refExists(input.repoPath, remote)
        ? ['worktree', 'add', '-b', branch, dir, `origin/${branch}`]
        : ['worktree', 'add', '-b', branch, dir, input.baseBranch];
    git(input.repoPath, args);
  }

  const claudeDir = path.join(dir, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.json');
  writeFileSync(settingsPath, `${JSON.stringify(input.settings, null, 2)}\n`);
  writeFileSync(
    path.join(claudeDir, '.nomos-policy.json'),
    `${JSON.stringify({ policyHash: input.policyHash, taskId: input.taskId, generatedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  return { dir, branch, createdBranch: !existed, settingsPath };
}

// Executor가 작업공간에 쓰는 파일(MCP 설정·실행 로그·브리핑 노트·정책 표시·settings.json)이 모델의 `git add`에 섞이지 않게 한다.
// 커밋에 섞이면 신고 경로와 실제 diff가 어긋나 V3가 FAIL을 낸다. info/exclude는 레포 공통이라 모든 worktree에 걸린다.
// node_modules·.nomos-venv는 Executor가 미리 설치한 의존성(setup.ts) — 레포에 .gitignore가 없어도 커밋에 섞이지 않게.
export const NOMOS_LOCAL_FILES = [
  '/.nomos-mcp.json',
  '/.nomos-run.log',
  '/.nomos-briefing.json',
  '/.claude/.nomos-policy.json',
  '/.claude/settings.json',
  '/node_modules/',
  '/.nomos-venv/',
];

export function excludeNomosFiles(repoPath: string): void {
  try {
    const commonDir = path.resolve(repoPath, git(repoPath, ['rev-parse', '--git-common-dir']));
    const file = path.join(commonDir, 'info', 'exclude');
    mkdirSync(path.dirname(file), { recursive: true });
    const current = existsSync(file) ? readFileSync(file, 'utf-8') : '';
    const lines = new Set(current.split(/\r?\n/));
    const missing = NOMOS_LOCAL_FILES.filter((p) => !lines.has(p));
    if (missing.length === 0) return;
    const prefix = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    writeFileSync(file, `${current}${prefix}# NOMOS Executor가 작업공간에 쓰는 파일\n${missing.join('\n')}\n`);
  } catch {
    // 못 써도 작업은 진행한다 — 섞이면 V3가 잡는다.
  }
}

// executor clean — worktree를 정리한다. 남겨두는 게 기본이라 정리는 명시적 명령으로만 한다.
export function cleanWorkspaces(): { pruned: string[]; removed: string | null } {
  const pruned: string[] = [];
  // repos.json에 적힌 레포 + CLI가 받아 둔 레포(~/.nomos/repos/<조직>/<레포>).
  const repos: Record<string, string> = { ...readRepoMap() };
  const managed = path.join(nomosHome(), 'repos');
  if (existsSync(managed)) {
    for (const owner of readdirSync(managed)) {
      const ownerDir = path.join(managed, owner);
      if (!statSync(ownerDir).isDirectory()) continue;
      for (const name of readdirSync(ownerDir)) repos[`${owner}/${name}`] ??= path.join(ownerDir, name);
    }
  }
  for (const [fullName, repoPath] of Object.entries(repos)) {
    try {
      git(repoPath, ['worktree', 'prune']);
      pruned.push(fullName);
    } catch {
      // 레포가 사라졌거나 git이 없어도 디렉터리 삭제는 진행한다.
    }
  }

  const root = workspacesRoot();
  if (!existsSync(root)) return { pruned, removed: null };
  // 사람이 직접 부르는 명령이라 못 지우면 오류를 그대로 보인다(삼키면 지웠다고 거짓 보고한다). 잠금만 재시도로 넘긴다.
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return { pruned, removed: root };
}

export function headSha(dir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}
