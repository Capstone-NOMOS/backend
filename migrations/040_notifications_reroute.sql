-- Up Migration

-- 받은 편지함 알림에 질문 재지정(038 QUESTION_REROUTED)을 더한다 — 넘겨받은 역할 담당이 "처리할 일"에서만 보고 알림·토스트를 받지 못했다(FE 요청).
-- 부분 인덱스는 알림 대상 타입(inbox/repository.ts의 NOTIFICATION_EVENT_TYPES)과 같아야 한다.
DROP INDEX IF EXISTS idx_events_notifications;
CREATE INDEX idx_events_notifications ON events (org_id, id)
  WHERE type IN ('APPROVAL_RESULT', 'VERIFICATION_COMPLETED', 'TASK_COMPLETED_MANUALLY', 'QUESTION_ANSWERED', 'QUESTION_DRAFTED', 'QUESTION_ASKED', 'QUESTION_REROUTED');

-- Down Migration

DROP INDEX IF EXISTS idx_events_notifications;
CREATE INDEX idx_events_notifications ON events (org_id, id)
  WHERE type IN ('APPROVAL_RESULT', 'VERIFICATION_COMPLETED', 'TASK_COMPLETED_MANUALLY', 'QUESTION_ANSWERED', 'QUESTION_DRAFTED', 'QUESTION_ASKED');
