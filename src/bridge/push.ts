import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// submit_artifact가 서버에 제출하기 **전에** 태스크 브랜치를 push한다.
//
// 이유: 배포 서버의 V3는 GitHub 커밋 API로 diff를 읽는다. 커밋이 팀원 노트북에만 있으면 GitHub는 404를
// 주고, 그건 "없는 커밋 = FAIL"로 적혀 retry_count가 오른다 — 에이전트 잘못이 아닌데 재시도를 잃는다.
//
// push는 모델이 아니라 이 도구가 한다. 모델에게 push 도구를 주면 아무 브랜치에나 쓸 수 있고,
// 그게 GitHub MCP를 막아둔 이유(--strict-mcp-config)를 그대로 무너뜨린다. 그래서 규칙을 여기 고정한다:
//   - 서버에 기록된 태스크 브랜치(tasks.branch_name)에만 push한다
//   - main·dev·레포의 default_branch·dev_branch로는 절대 push하지 않는다
//   - force push 하지 않는다 (앞선 커밋과 어긋나면 거부당하고 그대로 실패로 돌려준다)
//   - 원격(origin)이 없는 로컬 데모 레포는 건너뛴다 — 서버가 mirror 모드로 로컬 경로에서 직접 읽는다
// 실패하면 서버에 제출하지 않는다. 호출부가 모델에게 오류를 돌려준다.

export class PushRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushRefused';
  }
}

export type PushOutcome = { pushed: true; branch: string } | { pushed: false; reason: 'no-remote' };

// 이름으로 막는 브랜치. 레포별 default_branch·dev_branch는 호출부가 더한다.
const ALWAYS_PROTECTED = ['main', 'dev'];
const REMOTE = 'origin';
const PUSH_TIMEOUT_MS = 60_000;

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

// 헤드리스에서 자격 증명을 묻는 프롬프트가 뜨면 도구 호출이 끝없이 멈춘다. 묻지 말고 실패하게 한다.
const defaultGit: GitRunner = async (cwd, args) => {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    timeout: PUSH_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
};

// 원격 URL에 토큰이 박혀 있으면(https://user:token@host) git 에러 메시지에 그대로 실릴 수 있다.
// 모델에게 돌려주기 전에 지운다.
function redact(text: string): string {
  return text.replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@');
}

function failure(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  const raw = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : err instanceof Error ? err.message : String(err);
  return redact(raw.trim().split('\n').slice(-3).join(' / '));
}

export async function pushTaskBranch(input: {
  workspaceDir: string;
  commitSha: string;
  taskBranch: string | null;
  protectedBranches: string[];
  git?: GitRunner;
}): Promise<PushOutcome> {
  const git = input.git ?? defaultGit;
  const ws = input.workspaceDir;

  try {
    await git(ws, ['remote', 'get-url', REMOTE]);
  } catch {
    return { pushed: false, reason: 'no-remote' };
  }

  const branch = input.taskBranch;
  if (!branch) {
    throw new PushRefused('태스크 브랜치가 서버에 기록되지 않았다 — Executor가 작업공간을 만들 때 보고한다');
  }
  try {
    await git(ws, ['check-ref-format', '--branch', branch]);
  } catch {
    throw new PushRefused(`브랜치 이름이 올바르지 않다: ${branch}`);
  }

  // 대소문자만 다른 이름으로 우회하지 못하게 한다(Windows·macOS에서는 같은 브랜치로 취급될 수 있다).
  const protectedSet = new Set([...ALWAYS_PROTECTED, ...input.protectedBranches].map((b) => b.toLowerCase()));
  if (protectedSet.has(branch.toLowerCase())) {
    throw new PushRefused(`${branch}에는 push하지 않는다 — 태스크 브랜치에서 작업해야 한다`);
  }

  let head: string;
  try {
    head = await git(ws, ['symbolic-ref', '--short', 'HEAD']);
  } catch {
    throw new PushRefused('작업공간이 브랜치 위에 있지 않다(detached HEAD)');
  }
  if (head !== branch) {
    throw new PushRefused(`작업공간이 태스크 브랜치(${branch})가 아니라 ${head}에 있다`);
  }

  // 제출하려는 커밋이 태스크 브랜치에 들어 있어야 push 뒤에 서버가 찾을 수 있다.
  try {
    await git(ws, ['merge-base', '--is-ancestor', input.commitSha, `refs/heads/${branch}`]);
  } catch {
    throw new PushRefused(`커밋 ${input.commitSha}이 태스크 브랜치(${branch})에 없다`);
  }

  // 명시적 refspec. '+' 접두사가 없으므로 force가 아니다 — 원격과 어긋나면 git이 거부한다.
  try {
    await git(ws, ['push', '--porcelain', REMOTE, `refs/heads/${branch}:refs/heads/${branch}`]);
  } catch (err) {
    throw new PushRefused(`push 실패: ${failure(err)}`);
  }
  return { pushed: true, branch };
}
