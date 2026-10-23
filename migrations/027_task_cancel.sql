-- Up Migration

-- 사람이 조정하는 출구(대표 결정 2026-10-24) — 재실행으로 풀리지 않는 태스크를 사람이 닫는다.
--   CANCELLED  잘못 나눈·필요 없어진 태스크를 대표가 취소한다. 지우지 않고 기록으로 남는다.
--              "끝난 것"으로 센다: 통합 확인(G3)의 "모든 태스크 완료"와 뒤 태스크의 선행 조건에서 DONE과 같이 본다.
-- 사람이 직접 완료한 태스크는 DONE이다(새 상태가 아니다) — 이벤트 TASK_COMPLETED_MANUALLY로 가른다.

ALTER TABLE tasks DROP CONSTRAINT tasks_state_chk;
ALTER TABLE tasks ADD CONSTRAINT tasks_state_chk CHECK (state IN
  ('READY', 'CLAIMED', 'IN_PROGRESS', 'VERIFYING', 'AWAITING_APPROVAL', 'BLOCKED', 'ESCALATED', 'DONE', 'CANCELLED'));

-- Down Migration

ALTER TABLE tasks DROP CONSTRAINT tasks_state_chk;
ALTER TABLE tasks ADD CONSTRAINT tasks_state_chk CHECK (state IN
  ('READY', 'CLAIMED', 'IN_PROGRESS', 'VERIFYING', 'AWAITING_APPROVAL', 'BLOCKED', 'ESCALATED', 'DONE'));
