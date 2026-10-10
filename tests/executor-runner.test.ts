import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeEnv, runClaude, SESSION_ENV_KEYS } from '../src/executor/runner.js';

// Executor가 claude를 띄우는 방식 — 띄운 쪽 Claude Code 세션과 묶지 않고, 출력이 끊기면 끝까지 기다리지 않는다.
describe('claude에 넘기는 환경변수', () => {
  it('띄운 쪽 Claude Code 세션 변수는 빼고(대소문자 무시), 인증·설정 변수와 PATH는 그대로 둔다', () => {
    const env = claudeEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 's',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
      claude_code_messaging_token: 't',
      CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
      CLAUDE_EFFORT: 'high',
      CLAUDE_CODE_OAUTH_TOKEN: 'keep',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe',
      Path: 'C:/bin',
    });
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'keep', CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe', Path: 'C:/bin' });
    expect(SESSION_ENV_KEYS).toContain('CLAUDE_CODE_MESSAGING_TOKEN');
  });
});

describe('출력 없는 시간 감지', () => {
  const node = (script: string) => ({ command: process.execPath, commandArgs: ['-e', script] });
  const base = () => ({ workspaceDir: mkdtempSync(path.join(tmpdir(), 'nomos-runner-')), prompt: 'p', mcpConfigPath: 'm.json' });

  it('출력이 끊기면 전체 시간 제한을 기다리지 않고 stalled로 끊고, 실행 기록에 그 사실을 남긴다', async () => {
    const started = Date.now();
    const result = await runClaude({ ...base(), idleMs: 300, command: node("console.log('{\"type\":\"system\"}'); setTimeout(() => {}, 20000)") });
    expect(result.outcome).toBe('stalled');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(readFileSync(result.logPath, 'utf8')).toContain('모델 출력이 없어 실행을 끊었다');
  });

  it('출력이 이어지면 무출력 한도보다 오래 돌아도 끊지 않는다', async () => {
    const result = await runClaude({
      ...base(),
      idleMs: 400,
      command: node("let n = 0; const t = setInterval(() => { console.log(n); if (++n === 12) { clearInterval(t); } }, 100)"),
    });
    expect(result.outcome).toBe('completed');
    expect(result.durationMs).toBeGreaterThan(400);
  });

  it('띄운 프로세스에는 세션 변수가 넘어가지 않는다', async () => {
    process.env.CLAUDE_CODE_MESSAGING_TOKEN = 'leak';
    try {
      const result = await runClaude({ ...base(), command: node("console.log('token=' + (process.env.CLAUDE_CODE_MESSAGING_TOKEN ?? 'none'))") });
      expect(readFileSync(result.logPath, 'utf8')).toContain('token=none');
    } finally {
      delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;
    }
  });
});
