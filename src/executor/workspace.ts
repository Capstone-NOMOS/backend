import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 작업공간은 레포 자체와 분리한다. git worktree로 분기하므로 사용자의 기존 작업 트리를 건드리지 않는다.
// 태스크가 끝나도 남긴다 — 실패 원인은 로그가 아니라 남은 파일에서 드러나는 경우가 많다.
export function workspacesRoot(): string {
  return path.join(os.homedir(), '.nomos', 'workspaces');
}

export function workspaceDir(projectId: string, taskId: string): string {
  return path.join(workspacesRoot(), projectId, taskId);
}

// 레포 fullName → 로컬 클론 경로. Executor는 노트북에서 도는 프로그램이라
// 어느 디렉터리가 그 레포인지 알 방법이 없다. 사람이 한 번 적어준다.
export function repoMapPath(): string {
  return path.join(os.homedir(), '.nomos', 'repos.json');
}

// 없으면 빈 맵. 시드는 "적힌 것만" 쓰면 되므로 실패시키지 않는다.
export function readRepoMap(): Record<string, string> {
  const file = repoMapPath();
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>;
}

export function resolveRepoPath(fullName: string): string {
  const file = repoMapPath();
  if (!existsSync(file)) {
    throw new Error(`${file}이 없습니다. {"${fullName}": "C:/path/to/repo"} 형식으로 만들어 주세요`);
  }
  const dir = readRepoMap()[fullName];
  if (!dir) throw new Error(`${file}에 "${fullName}" 항목이 없습니다`);
  if (!existsSync(path.join(dir, '.git'))) throw new Error(`${dir}는 git 레포가 아닙니다`);
  return dir;
}

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8' }).trim();
}

function branchExists(repoPath: string, branch: string): boolean {
  try {
    // stdio를 삼킨다 — 없는 브랜치면 git이 stderr에 fatal을 찍어 로그를 더럽힌다.
    execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
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

  if (!existsSync(dir)) {
    mkdirSync(path.dirname(dir), { recursive: true });
    const args = existed
      ? ['worktree', 'add', dir, branch]
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

// executor clean — worktree를 정리한다. 남겨두는 게 기본이라 정리는 명시적 명령으로만 한다.
export function cleanWorkspaces(): { pruned: string[]; removed: string | null } {
  const pruned: string[] = [];
  const file = repoMapPath();
  if (existsSync(file)) {
    const map = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>;
    for (const [fullName, repoPath] of Object.entries(map)) {
      try {
        git(repoPath, ['worktree', 'prune']);
        pruned.push(fullName);
      } catch {
        // 레포가 사라졌거나 git이 없어도 디렉터리 삭제는 진행한다.
      }
    }
  }

  const root = workspacesRoot();
  if (!existsSync(root)) return { pruned, removed: null };
  rmSync(root, { recursive: true, force: true });
  return { pruned, removed: root };
}

export function headSha(dir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}
