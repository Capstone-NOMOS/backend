// "기획 단계 질문이 전부 답해졌다"는 신호(033) — 기능 명세 초안(plan)이나 API 계약(contract)에 붙은 질문에 대기가 남지 않았다.
// 질문 도메인은 PM·계약을 모른다(순환 import를 만들지 않는다). pm/service.ts·contract/service.ts가 구독해 답을 붙여 초안을 다시 쓴다.
//
// **커밋한 뒤에** 부른다(tasks-changed와 같은 규칙) — 보이지 않는 상태로 다시 쓰거나, 롤백된 답으로 다시 쓰지 않게.
// 받는 쪽은 비동기다. 실패해도 답은 이미 저장됐다 — 로그로 남기고 사람이 수정 요청으로 이어 간다.

export type PlanningSubjectRef = { kind: 'plan'; planId: string } | { kind: 'contract'; contractId: string };
type Listener = (projectId: string, subject: PlanningSubjectRef) => Promise<void>;

const listeners = new Set<Listener>();
const inflight = new Set<Promise<void>>();

export function onPlanningQuestionsSettled(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function planningQuestionsSettled(projectId: string, subject: PlanningSubjectRef): void {
  for (const listener of listeners) {
    const job = listener(projectId, subject)
      .catch(() => {
        // 받는 쪽이 로그를 남긴다 — 답은 이미 커밋됐다.
      })
      .finally(() => inflight.delete(job));
    inflight.add(job);
  }
}

// 테스트용 — 다시 쓰기 요청이 끝나길 기다린다.
export async function drainPlanningQuestions(): Promise<void> {
  while (inflight.size > 0) await Promise.all([...inflight]);
}
