// 한 태스크의 재시도 상한. 검증 실패(FAIL)와 사람의 반려(REJECT)가 같은 retry_count를 쓴다 — 3회째면 ESCALATED.
// 원인은 이벤트에서 가른다(VERIFICATION_COMPLETED·APPROVAL_RESULT의 retryCause).
export const MAX_RETRIES = 3;

export type RetryCause = 'VERIFICATION_FAILED' | 'REJECTED';
