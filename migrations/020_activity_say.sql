-- Up Migration

-- 룸을 Claude Code 화면처럼 — 에이전트의 말(say)·도구 결과의 성공 여부·수정 줄 수를 활동에 더한다(대표 결정, 017의 "도구와 대상만"을 넓힘).
-- 여전히 받지 않는 것: 파일 내용·diff·명령 결과(출력). 줄 수는 숫자만 받는다.
--   say    — 모델이 실행 중에 한 말(작업공간 경로는 Executor가 지운다). 한 줄 최대 500자.
--   ok     — 도구 결과가 오류였는가(Claude Code의 is_error). 결과를 못 받았으면 NULL.
--   lines_added·lines_removed — 수정·작성의 줄 수(Edit의 old/new, Write의 내용). 모르면 NULL.

ALTER TABLE agent_activity DROP CONSTRAINT agent_activity_kind_chk;
ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_kind_chk
  CHECK (kind IN ('read', 'edit', 'write', 'run', 'search', 'other', 'say'));

ALTER TABLE agent_activity DROP CONSTRAINT agent_activity_target_chk;
ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_target_chk
  CHECK (char_length(target) BETWEEN 1 AND (CASE WHEN kind = 'say' THEN 500 ELSE 300 END));

ALTER TABLE agent_activity ADD COLUMN ok boolean;
ALTER TABLE agent_activity ADD COLUMN lines_added integer;
ALTER TABLE agent_activity ADD COLUMN lines_removed integer;
ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_lines_chk
  CHECK ((lines_added IS NULL OR lines_added >= 0) AND (lines_removed IS NULL OR lines_removed >= 0));

-- Down Migration

ALTER TABLE agent_activity DROP CONSTRAINT agent_activity_lines_chk;
ALTER TABLE agent_activity DROP COLUMN lines_removed;
ALTER TABLE agent_activity DROP COLUMN lines_added;
ALTER TABLE agent_activity DROP COLUMN ok;
DELETE FROM agent_activity WHERE kind = 'say';
ALTER TABLE agent_activity DROP CONSTRAINT agent_activity_target_chk;
ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_target_chk CHECK (char_length(target) BETWEEN 1 AND 300);
ALTER TABLE agent_activity DROP CONSTRAINT agent_activity_kind_chk;
ALTER TABLE agent_activity ADD CONSTRAINT agent_activity_kind_chk CHECK (kind IN ('read', 'edit', 'write', 'run', 'search', 'other'));
