import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveClaudeCommand } from './runner.js';

// executor pm-worker — 중계 모드(PM_PROVIDER=relay)에서 대표 노트북이 PM의 "모델 호출" 한 자리를 맡는다.
// 서버가 만든 작업(지침·프롬프트·출력 스키마)을 그대로 headless Claude Code에 넣고, 나온 텍스트를 그대로 돌려준다.
// 해석·검증·교정·저장은 전부 서버가 한다 — 여기서 결과를 고치거나 다시 부르지 않는다(재시도는 서버의 교정 1회뿐).
// 결제가 붙어 PM_PROVIDER=api로 바꾸면 이 명령은 필요 없다.

export type PmJob = {
  id: string;
  planId: string;
  purpose: 'draft' | 'repair';
  request: {
    model: string;
    effort: string;
    maxTokens: number;
    system: string;
    user: string;
    jsonSchema: Record<string, unknown>;
  };
};

export type PmJobResult = {
  stopReason: string | null;
  servedModel: string | null;
  text: string;
  usage: { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number };
};

// `claude -p --output-format json`의 출력 중 쓰는 칸만.
export type ClaudeJsonOutput = {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, { outputTokens?: number }>;
};

// 지침·프롬프트는 길어서(이전 초안이 붙는 수정 요청) 명령줄로 넘기지 않는다 — Windows 명령줄은 32k자에서 잘린다.
// 지침은 파일, 프롬프트는 stdin. 도구는 전부 끄고(--tools ""), 사용자 MCP·세션 기록도 쓰지 않는다.
export function buildPmClaudeArgs(job: PmJob, systemPromptFile: string): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    job.request.model,
    '--effort',
    job.request.effort,
    '--system-prompt-file',
    systemPromptFile,
    '--json-schema',
    JSON.stringify(job.request.jsonSchema),
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
  ];
}

// 출력 → 서버에 돌려줄 결과. 실패면 { error }.
export function toJobResult(out: ClaudeJsonOutput, requestedModel: string): PmJobResult | { error: string } {
  if (out.is_error) return { error: `claude reported an error (${out.subtype ?? 'unknown'}): ${(out.result ?? '').slice(0, 500)}` };
  const text =
    out.structured_output !== undefined && out.structured_output !== null
      ? JSON.stringify(out.structured_output)
      : (out.result ?? '');
  if (!text) return { error: 'claude returned no output' };
  // 실제로 응답한 모델: 출력이 가장 많은 모델(부수 호출에 작은 모델이 섞일 수 있다).
  const served =
    Object.entries(out.modelUsage ?? {}).sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0]?.[0] ?? requestedModel;
  // stop_reason은 그대로 넘긴다. Claude Code는 구조화 출력을 도구 호출로 내므로 정상 완료도 'tool_use'로 온다(실측) —
  // 서버는 refusal·max_tokens만 따로 다루므로 그대로 둬도 흐름은 같고, 기록은 실제 값이 남는다.
  return {
    stopReason: out.stop_reason ?? null,
    servedModel: served,
    text,
    usage: {
      inputTokens: out.usage?.input_tokens ?? 0,
      outputTokens: out.usage?.output_tokens ?? 0,
      cacheWriteTokens: out.usage?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: out.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

export type RunClaudeJson = (args: string[], stdin: string, cwd: string) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

const spawnClaude: RunClaudeJson = (args, stdin, cwd) => {
  const { command, commandArgs } = resolveClaudeCommand(args);
  return new Promise((resolve, reject) => {
    // shell을 쓰지 않는다 — 인자가 명령으로 해석되지 않게(runner.ts와 같은 이유).
    const child = spawn(command, commandArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(stdin);
  });
};

export async function runPmJob(job: PmJob, run: RunClaudeJson = spawnClaude): Promise<PmJobResult | { error: string }> {
  // 빈 임시 폴더에서 돈다 — 레포·CLAUDE.md를 읽지 않게. 끝나면 지운다(지침 사본이 남지 않게).
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nomos-pm-'));
  try {
    const systemFile = path.join(dir, 'system.md');
    writeFileSync(systemFile, job.request.system, 'utf8');
    const { exitCode, stdout, stderr } = await run(buildPmClaudeArgs(job, systemFile), job.request.user, dir);
    let out: ClaudeJsonOutput;
    try {
      out = JSON.parse(stdout) as ClaudeJsonOutput;
    } catch {
      return { error: `claude exited ${exitCode} without JSON output: ${(stderr || stdout).slice(0, 500)}` };
    }
    return toJobResult(out, job.request.model);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type PmWorkerClient = {
  nextPmJob(): Promise<Record<string, unknown> | null>;
  submitPmJobResult(jobId: string, result: unknown): Promise<void>;
  failPmJob(jobId: string, message: string): Promise<void>;
};

// 작업 하나를 가져와 처리한다. 처리했으면 true.
export async function handleNextPmJob(
  client: PmWorkerClient,
  log: (line: string) => void,
  run: RunClaudeJson = spawnClaude,
): Promise<boolean> {
  const job = (await client.nextPmJob()) as PmJob | null;
  if (!job) return false;
  log(`PM 작업 ${job.id} (계획 ${job.planId}, ${job.purpose}) — claude 실행 중`);
  const started = Date.now();
  let result: PmJobResult | { error: string };
  try {
    result = await runPmJob(job, run);
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  const sec = Math.round((Date.now() - started) / 1000);
  if ('error' in result) {
    log(`실패(${sec}s): ${result.error}`);
    await client.failPmJob(job.id, result.error.slice(0, 2000));
  } else {
    log(`완료(${sec}s, 출력 ${result.usage.outputTokens} 토큰) — 서버로 보냄`);
    await client.submitPmJobResult(job.id, result);
  }
  return true;
}
