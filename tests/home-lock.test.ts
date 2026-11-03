import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCredentials, writeCredentials } from '../src/bridge/credentials.js';
import { acquireHomeLock, homeLockPath, readHomeLock } from '../src/executor/home-lock.js';

// 한 NOMOS_HOME = 한 에이전트 프로세스. 운영 실험에서 혼자 FE·BE·대표 에이전트를 NOMOS_HOME 없이 띄워 같은 자격 증명 파일을 덮어쓰고,
// 반쯤 쓰인 파일을 읽다 "Unexpected end of JSON input"으로 죽었다.

let home: string;
let saved: string | undefined;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'nomos-lock-'));
  saved = process.env.NOMOS_HOME;
  process.env.NOMOS_HOME = home;
});

afterAll(() => {
  if (saved === undefined) delete process.env.NOMOS_HOME;
  else process.env.NOMOS_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe('home-lock', () => {
  it('살아 있는 다른 프로세스가 쓰는 폴더는 거부하고, NOMOS_HOME을 나누라고 안내한다', () => {
    writeFileSync(homeLockPath(), JSON.stringify({ pid: process.ppid, command: 'connect', startedAt: 'x' }));
    expect(() => acquireHomeLock('connect')).toThrow(/NOMOS_HOME/);
  });

  it('주인이 죽었으면 넘겨받고, 같은 프로세스가 다시 잡는 것(connect → start)은 통과', () => {
    writeFileSync(homeLockPath(), JSON.stringify({ pid: 2_147_483_000, command: 'connect', startedAt: 'x' }));
    acquireHomeLock('connect');
    expect(readHomeLock()?.pid).toBe(process.pid);
    expect(() => acquireHomeLock('start')).not.toThrow();
  });
});

describe('자격 증명 쓰기', () => {
  it('임시 파일에 쓰고 바꿔 넣는다 — 남는 임시 파일이 없고 읽으면 온전하다', () => {
    const creds = { baseUrl: 'https://x', accessToken: 'a', refreshToken: 'r', agentId: 'g' };
    writeCredentials(creds);
    writeCredentials({ ...creds, accessToken: 'b' });
    expect(readCredentials()).toMatchObject({ accessToken: 'b' });
    expect(JSON.parse(readFileSync(path.join(home, 'credentials'), 'utf8')).accessToken).toBe('b');
    expect(readFileSync(path.join(home, 'credentials'), 'utf8')).not.toContain('tmp');
  });
});
