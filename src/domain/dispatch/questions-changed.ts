// "이 역할이 상담할 질문이 생겼다"는 신호 — 대상 역할 에이전트의 Executor가 곧바로 상담 실행을 맡게 깨운다.
// tasks-changed와 같은 모양이다: 도메인은 전송 방식을 모르고, realtime/agent-stream.ts가 구독해 { type: 'questions' }로 보낸다.
//
// **커밋한 뒤에** 부른다. 무엇을 물었는지는 싣지 않는다 — Executor가 GET /agents/me/questions로 다시 읽는다(권한·모양이 API 한 곳).
// 놓쳐도 Executor의 느린 안전망 확인(1분)이 메운다.

type Listener = (projectId: string, targetRole: string) => void;

const listeners = new Set<Listener>();

export function onQuestionsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function questionsChanged(projectId: string, targetRole: string): void {
  for (const listener of listeners) {
    try {
      listener(projectId, targetRole);
    } catch {
      // 알림 실패가 원래 요청을 실패시키면 안 된다 — 질문은 이미 커밋됐다.
    }
  }
}
