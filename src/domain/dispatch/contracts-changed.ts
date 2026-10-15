// "BE가 쓸 계약 작업이 생겼다"는 신호(023) — BE 노트북의 Executor를 깨워 계약 초안을 쓰게 한다.
// questions-changed와 같은 모양이다: 도메인은 웹소켓을 모르고 realtime/agent-stream.ts가 { type: 'contracts', targetRole } 으로 보낸다.
// **커밋한 뒤에** 부른다. 내용은 싣지 않는다(GET /agents/me/contract-jobs로 다시 읽는다). 놓쳐도 Executor의 1분 안전망이 메운다.

type Listener = (projectId: string, targetRole: string) => void;

const listeners = new Set<Listener>();

export function onContractsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function contractsChanged(projectId: string, targetRole = 'BACKEND'): void {
  for (const listener of listeners) {
    try {
      listener(projectId, targetRole);
    } catch {
      // 알림 실패가 원래 요청을 되돌리면 안 된다 — 이미 커밋됐다.
    }
  }
}
