import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildClaudeArgs } from '../bridge/claude-args.js';

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export type RunOutcome = 'completed' | 'timeout' | 'failed';

export type RunResult = {
  outcome: RunOutcome;
  exitCode: number | null;
  durationMs: number;
  logPath: string;
};

// ⚠️ Windows에서 spawn('claude', args, { shell: true })를 쓰면 안 된다.
// shell:true는 인자를 이스케이프 없이 이어붙여서 따옴표·괄호가 든 프롬프트가 셸에 먹힌다
// (스파이크에서 도구 호출이 한 번도 안 일어났다). .cmd 셰이퍼는 shell 없이 못 돌리므로
// node로 CLI 진입점을 직접 띄운다.
export function resolveClaudeCommand(args: string[]): { command: string; commandArgs: string[] } {
  if (process.platform === 'win32' && process.env.APPDATA) {
    const cli = path.join(
      process.env.APPDATA,
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'cli-wrapper.cjs',
    );
    if (existsSync(cli)) return { command: process.execPath, commandArgs: [cli, ...args] };
  }
  return { command: 'claude', commandArgs: args };
}

export type RunInput = {
  workspaceDir: string;
  prompt: string;
  mcpConfigPath: string;
  model?: string;
  timeoutMs?: number;
  // stdout(stream-json) 한 줄씩 실시간으로. 룸 활동 보고가 쓴다. 던져도 실행은 계속된다.
  onStdoutLine?: (line: string) => void;
};

export async function runClaude(input: RunInput): Promise<RunResult> {
  const args = buildClaudeArgs({
    prompt: input.prompt,
    mcpConfigPath: input.mcpConfigPath,
    cwd: input.workspaceDir,
    ...(input.model === undefined ? {} : { model: input.model }),
  });
  const { command, commandArgs } = resolveClaudeCommand(args);
  const logPath = path.join(input.workspaceDir, '.nomos-run.log');
  const startedAt = Date.now();

  return new Promise<RunResult>((resolve) => {
    // stdin을 열어두면 claude가 파이프 입력을 몇 초간 기다린다. 쓸 일이 없으니 닫는다.
    const child = spawn(command, commandArgs, {
      cwd: input.workspaceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: string[] = [];
    const collect = (c: Buffer) => chunks.push(c.toString());
    let partial = '';
    const emitLines = (c: Buffer) => {
      if (!input.onStdoutLine) return;
      partial += c.toString();
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        try {
          input.onStdoutLine(line);
        } catch {
          // 룸 표시 실패가 실행을 멈추면 안 된다.
        }
      }
    };
    child.stdout.on('data', (c: Buffer) => {
      collect(c);
      emitLines(c);
    });
    child.stderr.on('data', collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(logPath, chunks.join(''));
      resolve({
        outcome: timedOut ? 'timeout' : code === 0 ? 'completed' : 'failed',
        exitCode: code,
        durationMs: Date.now() - startedAt,
        logPath,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      writeFileSync(logPath, `${chunks.join('')}\n[executor] spawn 실패: ${err.message}\n`);
      resolve({ outcome: 'failed', exitCode: null, durationMs: Date.now() - startedAt, logPath });
    });
  });
}
