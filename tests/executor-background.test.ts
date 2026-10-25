import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { daemonFile, isAlive, readDaemon, runningDaemon, startDaemon, stopDaemon, tailLog } from '../src/executor/background.js';

// CLI 백그라운드 실행(FE 요청 2026-10-25) — connect를 분리된 자식으로 띄우고, 상태를 보고, 끈다.
// 실제 connect 대신 출력만 남기고 기다리는 작은 스크립트를 띄운다.

let home: string;
let fake: string;
const previousHome = process.env.NOMOS_HOME;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'nomos-bg-'));
  process.env.NOMOS_HOME = home;
  fake = path.join(home, 'fake-cli.mjs');
  writeFileSync(fake, "console.log('started', process.argv.slice(2).join(' '), process.env.NOMOS_BACKGROUND); setInterval(() => {}, 1000);\n");
});

afterAll(() => {
  stopDaemon();
  if (previousHome === undefined) delete process.env.NOMOS_HOME;
  else process.env.NOMOS_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('백그라운드 connect', () => {
  it('--background를 뺀 같은 인자로 분리된 자식을 띄우고, 두 번은 못 띄우며, 상태·로그를 읽고 끈다', async () => {
    const info = startDaemon({ cliPath: fake, args: ['--server', 'https://example.test', '--background'], server: 'https://example.test' });
    expect(isAlive(info.pid)).toBe(true);
    expect(readDaemon()).toMatchObject({ pid: info.pid, server: 'https://example.test', args: ['--server', 'https://example.test'] });
    expect(() => startDaemon({ cliPath: fake, args: [], server: 'x' })).toThrow(/이미 백그라운드/);

    // 자식이 로그 파일에 쓴다(창이 없으니 출력은 파일로 간다).
    for (let i = 0; i < 50 && tailLog(info.logFile).length === 0; i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(tailLog(info.logFile).join('\n')).toContain('started connect --server https://example.test 1');

    expect(stopDaemon()?.pid).toBe(info.pid);
    for (let i = 0; i < 50 && isAlive(info.pid); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(isAlive(info.pid)).toBe(false);
    expect(runningDaemon()).toBeNull();
    expect(stopDaemon()).toBeNull();
  });

  it('죽은 프로세스의 기록만 남아 있으면 없는 것으로 보고 지운다', () => {
    writeFileSync(daemonFile(), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: '', server: 's', logFile: '', args: [] }));
    expect(runningDaemon()).toBeNull();
    expect(readDaemon()).toBeNull();
  });
});
