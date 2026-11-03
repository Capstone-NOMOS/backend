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
  // 이번에 기본 브랜치에서 새로 딴 태스크 브랜치인가(이어 가는 브랜치가 아니다) — 선행 작업을 합치는 건 이때뿐이다.
  startedFresh: boolean;
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
  let startedFresh = false;

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
    startedFresh = args.at(-1) === input.baseBranch;
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

  return { dir, branch, createdBranch: !existed, startedFresh, settingsPath };
}

// 선행 작업(서버 브리핑의 predecessors — 같은 레포의 끝난 선행 태스크의 마지막 제출 커밋). 태스크 브랜치는 기본 브랜치에 합쳐지지 않으므로
// 이걸 합치지 않으면 "선행이 만든 기반 위에 덧붙이라"는 태스크가 빈 기본 브랜치에서 시작해 막힌다(운영 실험: BE가 기반 코드가 없다며 멈췄다).
export type PredecessorCommit = { taskId: string; title: string; branchName: string | null; commitSha: string };
export type PredecessorMerge = { merged: PredecessorCommit[]; failed: { predecessor: PredecessorCommit; reason: string }[] };

const SHA = /^[0-9a-f]{7,64}$/i;
const BRANCH = /^[A-Za-z0-9._/-]+$/;

// 새로 딴 태스크 브랜치에 선행 커밋을 오래된 것부터 합친다(앞서면 빨리 감기, 아니면 병합 커밋). 모델이 아니라 Executor가 한다 —
// 모델의 git은 merge·cherry-pick이 막혀 있다. 커밋이 없으면 선행 브랜치를 받아 온다. 충돌이나 실패는 되돌리고 건너뛴다 —
// 실행을 막으면 태스크가 READY로 남아 같은 실패를 되풀이하므로, 프롬프트에 "합치지 못했다"를 적고 모델이 멈출지 판단하게 한다.
// 서버의 V3는 같은 커밋들을 비교 기준으로 써서 선행의 파일을 이 태스크의 변경으로 세지 않는다.
export function mergePredecessors(dir: string, predecessors: readonly PredecessorCommit[]): PredecessorMerge {
  const result: PredecessorMerge = { merged: [], failed: [] };
  for (const p of predecessors) {
    if (!SHA.test(p.commitSha)) {
      result.failed.push({ predecessor: p, reason: '커밋 형식이 아니다' });
      continue;
    }
    if (!refExists(dir, `${p.commitSha}^{commit}`) && p.branchName && BRANCH.test(p.branchName) && !p.branchName.startsWith('-')) {
      try {
        execFileSync('git', ['fetch', '--quiet', 'origin', `refs/heads/${p.branchName}`], { cwd: dir, stdio: 'ignore' });
      } catch {
        // origin이 없거나(로컬 레포) 브랜치가 지워졌다 — 아래에서 커밋이 없다고 기록한다.
      }
    }
    if (!refExists(dir, `${p.commitSha}^{commit}`)) {
      result.failed.push({ predecessor: p, reason: `커밋 ${p.commitSha.slice(0, 12)}을 찾지 못했다(선행 브랜치 ${p.branchName ?? '?'}가 push되지 않았거나 지워졌다)` });
      continue;
    }
    try {
      execFileSync('git', ['merge', '--no-edit', '-m', `nomos: 선행 태스크 합침 — ${p.title.slice(0, 120)}`, p.commitSha], { cwd: dir, stdio: 'pipe' });
      result.merged.push(p);
    } catch (err) {
      try {
        execFileSync('git', ['merge', '--abort'], { cwd: dir, stdio: 'ignore' });
      } catch {
        // 병합이 시작되지도 않았다(신원 미설정 등) — 되돌릴 것이 없다.
      }
      // 충돌 안내(CONFLICT ...)는 stdout으로, 그 밖의 실패는 stderr로 나온다.
      const stderr = `${String((err as { stdout?: unknown }).stdout ?? '')}\n${String((err as { stderr?: unknown }).stderr ?? '')}`.trim();
      result.failed.push({ predecessor: p, reason: /conflict/i.test(stderr) ? '병합 충돌' : `병합 실패: ${stderr.split('\n')[0]?.slice(0, 200) ?? ''}` });
    }
  }
  return result;
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
