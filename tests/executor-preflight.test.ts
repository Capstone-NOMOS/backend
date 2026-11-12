import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkTools } from '../src/executor/preflight.js';

// connect 사전 점검 — git 사용자 정보가 없으면 시작하지 않는다(모델은 git config를 못 하고, 없으면 커밋 없이 멈춘다).
// 전역·시스템 설정을 임시 파일로 바꿔 끼워 이 PC의 git 설정과 상관없이 본다.

const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
let dir: string | null = null;

afterEach(() => {
  if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved.global;
  if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function useGlobalConfig(text: string): void {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nomos-preflight-'));
  const file = path.join(dir, 'gitconfig');
  writeFileSync(file, text);
  process.env.GIT_CONFIG_GLOBAL = file;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
}

const identity = () => checkTools().filter((t) => t.name.startsWith('git user.'));

describe('connect 사전 점검 — git 사용자 정보', () => {
  it('없으면 실패로 보고 설정 명령을 안내한다', () => {
    useGlobalConfig('');
    const checks = identity();
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ['git user.name', false],
      ['git user.email', false],
    ]);
    expect(checks[1]!.hint).toContain('git config --global user.email');
  });

  it('있으면 통과한다', () => {
    useGlobalConfig('[user]\n\tname = Nomos Tester\n\temail = tester@example.com\n');
    expect(identity().map((c) => [c.name, c.ok, c.detail])).toEqual([
      ['git user.name', true, 'Nomos Tester'],
      ['git user.email', true, 'tester@example.com'],
    ]);
  });
});
