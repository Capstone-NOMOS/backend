import { afterEach, describe, expect, it, vi } from 'vitest';

// Windows에서 자식 프로세스가 끝난 직후 폴더가 잠겨 rmSync가 EBUSY를 던지는 상황을 흉내 낸다.
const fsState = vi.hoisted(() => ({ failRm: false, rmCalls: [] as unknown[][] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const rmSync = (...args: Parameters<typeof actual.rmSync>) => {
    fsState.rmCalls.push(args);
    if (fsState.failRm) throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' });
    return actual.rmSync(...args);
  };
  return { ...actual, default: { ...actual, rmSync }, rmSync };
});

const { removeQuietly } = await import('../src/executor/cleanup.js');
const { runPmJob } = await import('../src/executor/pm-worker.js');

afterEach(() => {
  fsState.failRm = false;
  fsState.rmCalls.length = 0;
});

const JOB = {
  id: 'job-1',
  planId: 'plan-1',
  purpose: 'draft' as const,
  request: { model: 'claude-sonnet-5-5', effort: 'high', maxTokens: 1000, system: 'sys', user: 'user', jsonSchema: {} },
};

describe('뒷정리 삭제', () => {
  it('잠금을 재시도 옵션으로 넘긴다', () => {
    removeQuietly('C:/nowhere/nomos-x', () => undefined);
    expect(fsState.rmCalls[0]?.[1]).toMatchObject({ recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('그래도 못 지우면 던지지 않고 경고만 남긴다', () => {
    fsState.failRm = true;
    const warnings: string[] = [];
    expect(removeQuietly('C:/nowhere/nomos-x', (l) => void warnings.push(l))).toBe(false);
    expect(warnings[0]).toContain('EBUSY');
  });
});

describe('pm-worker — 정리 실패가 결과를 덮지 않는다', () => {
  it('Claude가 정상 결과를 냈으면 임시 폴더를 못 지워도 결과를 그대로 돌려준다', async () => {
    fsState.failRm = true;
    let tempDir = '';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await runPmJob(JOB, async (_args, _stdin, cwd) => {
        tempDir = cwd;
        return {
        exitCode: 0,
        stdout: JSON.stringify({ structured_output: { specs: [] }, stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } }),
        stderr: '',
        };
      });
      expect(result).toMatchObject({ text: JSON.stringify({ specs: [] }), usage: { inputTokens: 10, outputTokens: 20 } });
      expect(stderr.mock.calls.some(([line]) => String(line).includes('EBUSY'))).toBe(true);
    } finally {
      stderr.mockRestore();
      fsState.failRm = false;
      if (tempDir) removeQuietly(tempDir); // 시험이 남긴 임시 폴더는 실제로 지운다
    }
  });
});
