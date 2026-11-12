import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { resolveClaudeCommand } from './runner.js';

// connect 시작 전에 노트북에 필요한 도구가 있는지 본다. 없으면 첫 태스크에서야 실패가 드러난다.

export type ToolCheck = { name: string; ok: boolean; detail: string; hint: string };

function versionOf(command: string, args: string[], cwd?: string): { ok: boolean; detail: string } {
  // shell을 쓰지 않는다(runner.ts와 같은 이유). 실행 파일이 없으면 error가 채워진다.
  const r = spawnSync(command, args, { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) });
  if (r.error || r.status !== 0) return { ok: false, detail: r.error?.message ?? (r.stderr || `exit ${r.status}`).trim() };
  return { ok: true, detail: r.stdout.trim().split('\n')[0] ?? '' };
}

// 모델은 git commit만 할 수 있고 git config는 막혀 있다 — 사용자 정보가 없으면 코드를 다 쓰고도 "Author identity unknown"으로 커밋하지 못해
// 제출 없이 멈춘다(새 PC 운영 실험: FE·BE 태스크가 전부 그렇게 멈췄다). 첫 태스크까지 가지 않고 여기서 막는다.
function gitIdentity(key: 'user.name' | 'user.email'): ToolCheck {
  // 레포 밖에서 읽는다 — 에이전트가 커밋하는 곳은 CLI가 새로 클론한 레포(~/.nomos/repos)라 로컬 설정이 없고, 실행한 폴더의 레포 설정은 거기에 가지 않는다.
  const r = versionOf('git', ['config', '--get', key], os.tmpdir());
  return {
    name: `git ${key}`,
    ok: r.ok && r.detail !== '',
    detail: r.ok && r.detail !== '' ? r.detail : '설정돼 있지 않다',
    hint: `git config --global ${key} ${key === 'user.name' ? '"이름"' : '"메일 주소"'} 로 설정하세요 — 에이전트가 커밋할 때 쓴다`,
  };
}

export function checkTools(): ToolCheck[] {
  const git = versionOf('git', ['--version']);
  const claudeCmd = resolveClaudeCommand(['--version']);
  const claude = versionOf(claudeCmd.command, claudeCmd.commandArgs);
  return [
    { name: 'git', ...git, hint: 'https://git-scm.com 에서 설치하세요' },
    ...(git.ok ? [gitIdentity('user.name'), gitIdentity('user.email')] : []),
    {
      name: 'claude',
      ...claude,
      hint: 'Claude Code를 설치하고(npm install -g @anthropic-ai/claude-code) 터미널에서 claude를 한 번 실행해 로그인하세요',
    },
  ];
}
