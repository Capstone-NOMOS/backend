-- Up Migration

-- 받은 편지함의 알림(대표 결정 2026-10-29). 알림은 따로 쌓지 않고 events에서 계산한다(events가 정본, P5) —
-- 사람마다 남는 것은 "이 이벤트 id까지 읽었다"는 커서 하나뿐이다. 커서는 앞으로만 간다(서비스가 GREATEST로 쓴다).
-- 읽음은 상태 변화가 아니라 화면 상태라 events에 남기지 않는다(노트 읽기와 같은 이유 — events가 조회 로그가 된다).
ALTER TABLE users ADD COLUMN notifications_read_event_id bigint;

-- 알림이 되는 이벤트만 담는 부분 인덱스 — 조직의 최근 알림을 id 역순으로 훑는다(domain/inbox/notifications.ts의 NOTIFICATION_EVENT_TYPES와 같아야 한다).
CREATE INDEX idx_events_notifications ON events (org_id, id)
  WHERE type IN ('APPROVAL_RESULT', 'VERIFICATION_COMPLETED', 'TASK_COMPLETED_MANUALLY', 'QUESTION_ANSWERED', 'QUESTION_DRAFTED', 'QUESTION_ASKED');

-- Down Migration

DROP INDEX IF EXISTS idx_events_notifications;
ALTER TABLE users DROP COLUMN IF EXISTS notifications_read_event_id;
