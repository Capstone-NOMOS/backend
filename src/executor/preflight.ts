import { spawnSync } from 'node:child_process';
import { resolveClaudeCommand } from './runner.js';

// connect 시작 전에 노트북에 필요한 도구가 있는지 본다. 없으면 첫 태스크에서야 실패가 드러난다.

export type ToolCheck = { name: string; ok: boolean; detail: string; hint: string };

function versionOf(command: string, args: string[]): { ok: boolean; detail: string } {
  // shell을 쓰지 않는다(runner.ts와 같은 이유). 실행 파일이 없으면 error가 채워진다.
  const r = spawnSync(command, args, { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return { ok: false, detail: r.error?.message ?? (r.stderr || `exit ${r.status}`).trim() };
  return { ok: true, detail: r.stdout.trim().split('\n')[0] ?? '' };
}

export function checkTools(): ToolCheck[] {
  const git = versionOf('git', ['--version']);
  const claudeCmd = resolveClaudeCommand(['--version']);
  const claude = versionOf(claudeCmd.command, claudeCmd.commandArgs);
  return [
    { name: 'git', ...git, hint: 'https://git-scm.com 에서 설치하세요' },
    {
      name: 'claude',
      ...claude,
      hint: 'Claude Code를 설치하고(npm install -g @anthropic-ai/claude-code) 터미널에서 claude를 한 번 실행해 로그인하세요',
    },
  ];
}
