import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nomosHome } from '../bridge/credentials.js';

// 한 NOMOS_HOME = 한 에이전트 프로세스. 같은 폴더를 두 프로세스가 쓰면 자격 증명(토큰)을 서로 덮어쓰고, 반쯤 쓰인 파일을 읽다 죽고,
// 같은 레포를 동시에 받다 실패한다(운영 실험: 혼자 FE·BE·대표 에이전트를 NOMOS_HOME 없이 띄웠다). 문서 경고 대신 두 번째 프로세스를 막는다.
// 같은 프로세스가 다시 잡는 것(connect → start)은 통과. 주인이 죽었으면(pid 없음) 넘겨받는다.

export type HomeLock = { pid: number; command: string; startedAt: string };

export function homeLockPath(): string {
  return path.join(nomosHome(), 'agent.lock');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // 권한이 없을 뿐 살아 있다.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readHomeLock(): HomeLock | null {
  try {
    return JSON.parse(readFileSync(homeLockPath(), 'utf-8')) as HomeLock;
  } catch {
    return null;
  }
}

// 잡지 못하면 이유를 담아 던진다. 끝날 때 자동으로 놓는다.
export function acquireHomeLock(command: string): void {
  const file = homeLockPath();
  const held = existsSync(file) ? readHomeLock() : null;
  if (held && held.pid !== process.pid && alive(held.pid)) {
    throw new Error(
      `이 폴더(${nomosHome()})는 다른 nomos 프로세스(pid ${held.pid}, ${held.command}, ${held.startedAt}부터)가 쓰고 있다. ` +
        '한 노트북에서 에이전트를 여럿 돌리려면 창마다 NOMOS_HOME을 다르게 지정한다 — cmd: set NOMOS_HOME=%USERPROFILE%\.nomos-fe / PowerShell: $env:NOMOS_HOME="$HOME\.nomos-fe"',
    );
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() } satisfies HomeLock)}\n`);
  process.once('exit', () => {
    if (readHomeLock()?.pid === process.pid) rmSync(file, { force: true });
  });
}
