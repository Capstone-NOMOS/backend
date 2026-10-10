import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildClaudeArgs } from '../bridge/claude-args.js';

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
// 모델 출력(stream-json)이 이만큼 없으면 응답이 끊긴 것으로 보고 끊는다. 30분을 다 기다리지 않고, 사유도 "오래 일함"과 구분된다.
// 실측: 도구 결과를 받은 뒤 다음 모델 응답이 오지 않은 채 20분 넘게 멈춘 실행이 있었다(같은 조건 재실행은 정상).
// 정상적인 무출력 구간보다 길어야 한다 — 질문 답 대기(실행 안 3분)·시험 실행(Bash 기본 2분, 최대 10분)·긴 생각.
export const DEFAULT_IDLE_MS = 15 * 60 * 1000;

export type RunOutcome = 'completed' | 'timeout' | 'stalled' | 'failed';

// Executor가 띄우는 claude에 넘기지 않는 환경변수 — 띄운 쪽 Claude Code 세션과 묶는 값들이다.
// Claude Code 안에서(예: "nomos connect 실행해 줘") CLI를 띄우면 이 값이 그대로 넘어가 태스크 실행이 그 대화 세션의
// 하위 세션이 된다(진입점이 claude-vscode로 기록되고, 부모 세션의 토큰 잔량 알림이 모델 맥락에 끼어들었다 — 실측).
// 인증·설정용 변수(CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_GIT_BASH_PATH, CLAUDE_CODE_USE_BEDROCK 등)는 건드리지 않는다.
export const SESSION_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_ENABLE_TASKS',
  'CLAUDE_CODE_EMIT_STARTUP_TIMING',
  'CLAUDE_CODE_QUESTION_PREVIEW_FORMAT',
] as const;

export function claudeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if ((SESSION_ENV_KEYS as readonly string[]).includes(key.toUpperCase())) delete env[key];
  }
  return env;
}

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

// Windows는 환경변수 이름이 대소문자를 가리지 않아 Path로 들어 있는 경우가 많다 — 있는 이름을 그대로 쓴다.
export function withPathPrepended(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...env, [key]: env[key] ? `${dir}${path.delimiter}${env[key]}` : dir };
}

export type RunInput = {
  workspaceDir: string;
  prompt: string;
  mcpConfigPath: string;
  model?: string;
  timeoutMs?: number;
  idleMs?: number;
  questionRelay?: boolean;
  // stdout(stream-json) 한 줄씩 실시간으로. 룸 활동 보고가 쓴다. 던져도 실행은 계속된다.
  onStdoutLine?: (line: string) => void;
  // PATH 앞에 붙일 폴더(작업공간의 파이썬 가상환경) — 모델의 `python -m pytest`가 미리 설치한 의존성을 쓰게.
  pathPrepend?: string | null;
  // 테스트용 — claude 대신 띄울 명령
  command?: { command: string; commandArgs: string[] };
};

export async function runClaude(input: RunInput): Promise<RunResult> {
  const args = buildClaudeArgs({
    prompt: input.prompt,
    mcpConfigPath: input.mcpConfigPath,
    cwd: input.workspaceDir,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.questionRelay === undefined ? {} : { questionRelay: input.questionRelay }),
  });
  const { command, commandArgs } = input.command ?? resolveClaudeCommand(args);
  const logPath = path.join(input.workspaceDir, '.nomos-run.log');
  const startedAt = Date.now();

  return new Promise<RunResult>((resolve) => {
    // stdin을 열어두면 claude가 파이프 입력을 몇 초간 기다린다. 쓸 일이 없으니 닫는다.
    const child = spawn(command, commandArgs, {
      cwd: input.workspaceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: input.pathPrepend ? withPathPrepended(claudeEnv(), input.pathPrepend) : claudeEnv(),
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
    let lastOutputAt = Date.now();
    child.stdout.on('data', (c: Buffer) => {
      lastOutputAt = Date.now();
      collect(c);
      emitLines(c);
    });
    child.stderr.on('data', collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // 출력 없는 시간 감지. 마지막 출력 시각만 보므로 도구가 오래 돌아도 그 사이 다른 출력이 있으면 끊지 않는다.
    const idleMs = input.idleMs ?? DEFAULT_IDLE_MS;
    let stalled = false;
    const idleCheck = setInterval(() => {
      if (Date.now() - lastOutputAt >= idleMs) {
        stalled = true;
        child.kill();
      }
    }, Math.min(30_000, Math.max(50, Math.floor(idleMs / 4))));

    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(idleCheck);
      writeFileSync(logPath, stalled ? `${chunks.join('')}
[executor] ${Math.round(idleMs / 60_000)}분 동안 모델 출력이 없어 실행을 끊었다
` : chunks.join(''));
      resolve({
        outcome: stalled ? 'stalled' : timedOut ? 'timeout' : code === 0 ? 'completed' : 'failed',
        exitCode: code,
        durationMs: Date.now() - startedAt,
        logPath,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(idleCheck);
      writeFileSync(logPath, `${chunks.join('')}\n[executor] spawn 실패: ${err.message}\n`);
      resolve({ outcome: 'failed', exitCode: null, durationMs: Date.now() - startedAt, logPath });
    });
  });
}
