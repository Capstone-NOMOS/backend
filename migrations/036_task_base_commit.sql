-- Up Migration

-- 태스크의 시작 기준점(대표 결정 2026-11-03) — 같은 레포의 끝난 선행 태스크가 있으면 서버가 "기본 브랜치 최신 + 선행 커밋들"을 합친 커밋을 만들어
-- nomos/base/<태스크 id> 브랜치에 두고 여기에 적는다(domain/task/task-base.ts). Executor는 거기서 분기하고, V3는 그 커밋 하나와 제출 커밋을 비교한다.
-- 선행 커밋마다 비교해 교집합을 보던 방식(#86)은 두 선행이 같은 파일(라우터 등록 파일 등)을 바꾸면 이 태스크가 안 건드려도 변경으로 잡혔다.
-- 서버가 만든 커밋이라 노트북이 보낸 값을 믿지 않는다. NULL = 선행이 없거나, 만들지 못했다(충돌·GitHub 실패 — 예전 방식으로 돈다).
-- 한 번 적으면 바꾸지 않는다(선행은 시작 전에 끝나 있고 태스크 의존은 만든 뒤 바뀌지 않는다).
ALTER TABLE tasks ADD COLUMN base_commit text;
ALTER TABLE tasks ADD CONSTRAINT tasks_base_commit_chk CHECK (base_commit IS NULL OR base_commit ~ '^[0-9a-f]{40}$');

-- Down Migration
ALTER TABLE tasks DROP CONSTRAINT tasks_base_commit_chk;
ALTER TABLE tasks DROP COLUMN base_commit;
