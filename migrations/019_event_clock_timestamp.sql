-- Up Migration

-- 이벤트·활동 시각을 트랜잭션 시작 시각(now())이 아니라 **행을 넣은 순간**(clock_timestamp())으로 찍는다.
--
-- now()는 BEGIN 시각이다. READ COMMITTED에서는 문장마다 그때까지 커밋된 상태를 보므로, 먼저 BEGIN한 트랜잭션이
-- 뒤에 커밋된 변화를 읽고 그 결과로 이벤트를 남기면 원인보다 **과거 시각**을 받는다. 실제로 "실행해 주세요"(TASK_DISPATCHED —
-- 시작된 프로젝트를 보고 계산한다)가 "프로젝트를 시작합니다"(PROJECT_STARTED)보다 앞에 정렬되어 룸 피드 테스트가 가끔 깨졌다.
-- clock_timestamp()면 다른 트랜잭션의 커밋을 보고 넣은 행은 항상 그 커밋보다 뒤 시각이다. 같은 트랜잭션 안의 행도 넣은 순서대로 시각이 갈린다.
--
-- 이미 쌓인 행은 고치지 않는다(events는 append-only).

ALTER TABLE events ALTER COLUMN ts SET DEFAULT clock_timestamp();
ALTER TABLE agent_activity ALTER COLUMN ts SET DEFAULT clock_timestamp();

-- Down Migration

ALTER TABLE agent_activity ALTER COLUMN ts SET DEFAULT now();
ALTER TABLE events ALTER COLUMN ts SET DEFAULT now();
