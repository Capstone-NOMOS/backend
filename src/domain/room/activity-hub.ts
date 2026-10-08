// 에이전트 활동이 기록됐다는 신호. 활동은 events가 아니라서(016의 NOTIFY 트리거를 타지 않는다) 화면 스트림에 따로 알린다.
// 도메인은 전송 방식을 모른다 — realtime/user-stream.ts가 구독해 그 프로젝트를 구독한 화면에 'room' 토픽을 보낸다.
// 메모리 안의 구독이라 서버 1대 전제다(presence와 같다). 커밋한 뒤에 부른다.

type Listener = (orgId: string, projectId: string) => void;

const listeners = new Set<Listener>();

export function onActivityRecorded(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function activityRecorded(orgId: string, projectId: string): void {
  for (const listener of listeners) listener(orgId, projectId);
}
