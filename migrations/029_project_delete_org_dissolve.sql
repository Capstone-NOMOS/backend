-- Up Migration

-- 프로젝트 삭제와 조직 해산(대표 결정 2026-10-28). 행은 지우지 않는다 — events·태스크·노트·질문이 가리킨다(P5).
-- "삭제"·"해산"은 표시를 남기고 어디서도 보이지 않게 하는 것이다(021의 해제·삭제와 같은 방식).
--   projects.deleted_at        지운 프로젝트. 목록·상세·하위 API에서 없는 것으로 본다(findProjectById가 거른다).
--                              진행 중이면 같은 트랜잭션에서 먼저 중단한다 — 그래서 지운 프로젝트는 끝난 상태(completed·aborted)뿐이다.
--   organizations.dissolved_at 해산한 조직. 멤버(대표 포함)는 모두 조직에서 빠지고, 그 조직 id로 오는 API는 404다.

ALTER TABLE projects ADD COLUMN deleted_at timestamptz;
ALTER TABLE projects ADD CONSTRAINT projects_deleted_closed_chk
  CHECK (deleted_at IS NULL OR status IN ('completed', 'aborted'));

ALTER TABLE organizations ADD COLUMN dissolved_at timestamptz;

-- Down Migration

ALTER TABLE organizations DROP COLUMN dissolved_at;
ALTER TABLE projects DROP CONSTRAINT projects_deleted_closed_chk;
ALTER TABLE projects DROP COLUMN deleted_at;
