import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export function credentialsDir(): string {
  return path.join(os.homedir(), '.nomos');
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
  writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
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
