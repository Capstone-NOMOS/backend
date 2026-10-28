import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nomosHome } from '../bridge/credentials.js';

// 백그라운드 실행(FE 요청 2026-10-25) — connect를 창 없이 돌려, 터미널을 켜 두지 않아도 에이전트가 살아 있게 한다.
//   connect --background  같은 인자로 connect를 분리된 자식 프로세스로 띄우고 바로 끝난다. 출력은 ~/.nomos/logs/connect.log.
//   status                돌고 있는지(pid·시작 시각·서버)와 로그 끝부분
//   stop                  끈다
// 진행 상황은 웹의 룸(도구 사용·에이전트의 말)에서 본다. 로그인할 때 자동 시작은 OS마다 방식이 달라 아직 없다(다음 단계).
// 브라우저 승인 로그인은 화면이 있어야 하므로, 저장된 자격 증명이 없으면 --code(1회용 연결 코드)와 함께만 백그라운드로 띄운다.

export type DaemonInfo = { pid: number; startedAt: string; server: string; logFile: string; args: string[] };

export function daemonFile(): string {
  return path.join(nomosHome(), 'daemon.json');
}

export function logDir(): string {
  return path.join(nomosHome(), 'logs');
}

export function readDaemon(): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(daemonFile(), 'utf-8')) as DaemonInfo;
  } catch {
    return null;
  }
}

// 그 pid의 프로세스가 살아 있는가(신호 0은 확인만 한다).
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// 이 프로세스가 백그라운드 connect 자신이면 daemon.json을 지운다 — 연결 해제로 스스로 끝날 때(cli.ts) status가 바로 "돌고 있지 않음"을 보이게.
export function clearDaemonIfSelf(): void {
  if (readDaemon()?.pid === process.pid) rmSync(daemonFile(), { force: true });
}

// 살아 있는 백그라운드 connect. 죽었는데 파일만 남았으면 지우고 null.
export function runningDaemon(): DaemonInfo | null {
  const info = readDaemon();
  if (!info) return null;
  if (isAlive(info.pid)) return info;
  rmSync(daemonFile(), { force: true });
  return null;
}

// --background를 뺀 같은 인자로 connect를 분리된 자식으로 띄운다. 이 프로세스는 바로 끝나도 자식은 계속 돈다.
export function startDaemon(input: { cliPath: string; args: string[]; server: string }): DaemonInfo {
  const existing = runningDaemon();
  if (existing) throw new Error(`이미 백그라운드에서 돌고 있다(pid ${existing.pid}, 서버 ${existing.server}). 끄려면 nomos stop`);
  mkdirSync(logDir(), { recursive: true });
  const logFile = path.join(logDir(), 'connect.log');
  const fd = openSync(logFile, 'a');
  const args = input.args.filter((a) => a !== '--background');
  const child = spawn(process.execPath, [input.cliPath, 'connect', ...args], {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: { ...process.env, NOMOS_BACKGROUND: '1' },
  });
  closeSync(fd);
  if (child.pid === undefined) throw new Error('백그라운드 프로세스를 띄우지 못했다');
  child.unref();
  const info: DaemonInfo = { pid: child.pid, startedAt: new Date().toISOString(), server: input.server, logFile, args };
  mkdirSync(nomosHome(), { recursive: true });
  writeFileSync(daemonFile(), JSON.stringify(info, null, 2), { mode: 0o600 });
  return info;
}

export function stopDaemon(): DaemonInfo | null {
  const info = runningDaemon();
  if (!info) return null;
  try {
    process.kill(info.pid);
  } catch {
    // 이미 끝났다.
  }
  rmSync(daemonFile(), { force: true });
  return info;
}

// 로그 끝부분(최대 n줄). 파일이 크면 끝 64KB만 읽는다.
export function tailLog(file: string, lines = 15): string[] {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const start = Math.max(0, size - 64 * 1024);
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf-8').split(/\r?\n/).filter(Boolean).slice(-lines);
  } finally {
    closeSync(fd);
  }
}
