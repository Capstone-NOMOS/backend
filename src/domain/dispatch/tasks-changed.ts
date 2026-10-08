import { logger } from '../../config/logger.js';

// "이 프로젝트에서 지금 가져갈 수 있는 태스크가 바뀌었을 수 있다"는 신호.
// 도메인은 전송 방식(웹소켓)을 모른다 — 여기에 알리기만 하고, realtime/agent-stream.ts가 구독해 에이전트에게 보낸다.
//
// **커밋한 뒤에** 부른다. 트랜잭션 안에서 부르면 아직 보이지 않는 상태로 스냅샷을 계산하거나, 롤백된 변경을 알린다.
// 무엇이 바뀌었는지는 싣지 않는다 — 받는 쪽이 매번 스냅샷을 다시 계산하므로 신호를 놓치거나 겹쳐도 결과가 같다.

type Listener = (projectId: string) => void | Promise<void>;

const listeners = new Set<Listener>();
// 아직 끝나지 않은 리스너 호출. 테스트가 정리(TRUNCATE) 전에 기다린다 — 운영 코드는 기다리지 않는다.
const inflight = new Set<Promise<void>>();

export function onTasksChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function tasksChanged(projectId: string): void {
  for (const listener of listeners) {
    // 알림 실패가 원래 요청을 실패시키면 안 된다 — 상태는 이미 커밋됐다. 놓친 알림은 에이전트의 안전망 폴링이 메운다.
    const p: Promise<void> = Promise.resolve()
      .then(() => listener(projectId))
      .catch((err: unknown) => logger.warn('tasks-changed listener failed', { projectId, error: String(err) }))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }
}

// 지금 돌고 있는 리스너가 전부 끝날 때까지 기다린다(그 사이에 새로 불린 것까지).
export async function drainTasksChanged(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}
