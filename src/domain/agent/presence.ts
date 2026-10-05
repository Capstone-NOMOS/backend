// 에이전트 접속 상태 — 화면의 "온라인" 표시용. DB에 쓰지 않는다(요청마다 UPDATE하면 쓰기만 늘고, 지난 접속 시각은 이벤트로도 충분하다).
//
// online = 태스크 스트림(웹소켓)이 열려 있다 — CLI `start`/`connect`가 태스크를 기다리는 중이다 —
//          또는 최근 ONLINE_WINDOW_MS 안에 인증된 요청이 있었다(끊겼을 때의 폴링·pm-worker·MCP 도구 호출).
// 메모리라 서버 1대 전제이고, 재시작하면 에이전트가 다시 연결하거나 요청할 때까지 offline이다(웹소켓은 몇 초 안에 다시 붙는다).

export const ONLINE_WINDOW_MS = 60_000;

const openStreams = new Map<string, number>();
const lastSeen = new Map<string, Date>();

export function markAgentSeen(agentId: string, at: Date = new Date()): void {
  lastSeen.set(agentId, at);
}

export function streamOpened(agentId: string): void {
  openStreams.set(agentId, (openStreams.get(agentId) ?? 0) + 1);
  markAgentSeen(agentId);
}

export function streamClosed(agentId: string): void {
  const n = (openStreams.get(agentId) ?? 1) - 1;
  if (n <= 0) openStreams.delete(agentId);
  else openStreams.set(agentId, n);
  markAgentSeen(agentId);
}

export function presenceOf(agentId: string, now: number = Date.now()): { online: boolean; lastSeenAt: string | null } {
  const seen = lastSeen.get(agentId) ?? null;
  const online = (openStreams.get(agentId) ?? 0) > 0 || (seen !== null && now - seen.getTime() <= ONLINE_WINDOW_MS);
  return { online, lastSeenAt: seen ? seen.toISOString() : null };
}

// 테스트용
export function clearPresence(): void {
  openStreams.clear();
  lastSeen.clear();
}
