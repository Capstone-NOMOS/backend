// "이 에이전트는 더 이상 쓸 수 없다"는 신호(연결 해제·조직 탈퇴, 021).
// 도메인은 웹소켓을 모른다 — 여기에 알리기만 하고, realtime/agent-stream.ts가 구독해 그 에이전트의 스트림을 끊는다.
// **커밋한 뒤에** 부른다. 놓쳐도 남은 연결은 다음 요청에서 인증이 거부한다(AGENT_DISCONNECTED).

type Listener = (agentId: string) => void;

const listeners = new Set<Listener>();

export function onAgentRevoked(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function agentRevoked(agentId: string): void {
  for (const listener of listeners) {
    try {
      listener(agentId);
    } catch {
      // 알림 실패가 해제를 되돌리면 안 된다 — 이미 커밋됐다.
    }
  }
}
