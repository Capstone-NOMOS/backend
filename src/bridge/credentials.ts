import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 에이전트 자격 증명은 여기 한 곳에만 둔다.
// 이전에는 MCP 설정 파일(.nomos-mcp.json)의 env에 평문으로 박혀 있었는데, 그 파일은
// Claude Code에 넘기는 설정이라 성격이 다르고, 재발급된 토큰을 되돌려 쓸 곳도 없었다.
// 그래서 매 실행이 401 한 번을 먹고 시작했다.
export type Credentials = {
  baseUrl: string;
  accessToken: string;
  refreshToken: string;
  agentId: string;
};

// NOMOS의 로컬 상태(자격 증명·작업공간·레포)를 두는 곳. 기본 ~/.nomos.
// NOMOS_HOME으로 바꾸면 한 PC에서 에이전트를 둘 이상 돌릴 수 있다 — 홈 자체를 바꾸면 Claude Code 로그인까지 따라 바뀌어 안 된다.
export function nomosHome(): string {
  return process.env.NOMOS_HOME ?? path.join(os.homedir(), '.nomos');
}

export function credentialsDir(): string {
  return nomosHome();
}

export function credentialsPath(): string {
  return path.join(credentialsDir(), 'credentials');
}

export function readCredentials(): Credentials | null {
  const file = credentialsPath();
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<Credentials>;
  if (!parsed.baseUrl || !parsed.accessToken || !parsed.refreshToken || !parsed.agentId) {
    throw new Error(`${file}에 baseUrl·accessToken·refreshToken·agentId가 모두 있어야 합니다`);
  }
  return parsed as Credentials;
}

// 0600으로 쓴다. Windows에서는 chmod가 사실상 무시되지만, 같은 코드가 리눅스 배포에서도 돌아야 한다.
export function writeCredentials(credentials: Credentials): void {
  mkdirSync(credentialsDir(), { recursive: true, mode: 0o700 });
  const file = credentialsPath();
  // 임시 파일에 다 쓴 뒤 이름을 바꾼다 — 읽는 쪽이 반쯤 쓰인 파일을 보지 않게(토큰 재발급마다 쓴다).
  // 같은 NOMOS_HOME을 두 프로세스가 쓰다 "Unexpected end of JSON input"으로 죽은 일이 있었다(운영 실험) — 공유 자체는 executor/home-lock.ts가 막는다.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch {
    // Windows에서 다른 프로세스가 그 순간 파일을 열고 있으면 바꾸기가 거부될 수 있다 — 직접 쓴다.
    writeFileSync(file, readFileSync(tmp), { mode: 0o600 });
    rmSync(tmp, { force: true });
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows에서는 실패할 수 있다. 파일 내용이 더 중요하므로 막지 않는다.
  }
}

// 재발급된 access token을 파일에 되돌려 쓴다. 이게 없으면 다음 실행이 또 401로 시작한다.
export function updateAccessToken(accessToken: string): void {
  const current = readCredentials();
  if (!current) return;
  writeCredentials({ ...current, accessToken });
}
