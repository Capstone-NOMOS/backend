-- Up Migration

-- 완료 태스크를 기본 브랜치에 합치기(실험 모드 전용, 대표 결정 2026-11-12) — 하나의 큰 앱을 기능마다 쌓아 키우는 무인 실험용.
-- 태스크 브랜치는 기본 브랜치에 합쳐지지 않아서(G3도 합치지 않는다) 다음 요구사항의 태스크가 앞 기능의 코드를 보지 못하고 빈 레포에서 시작했다.
-- 켜면 실험 모드 자동 진행이 DONE이 된 태스크의 마지막 제출 커밋을 기본 브랜치에 합친다(domain/task/default-merge.ts, 결과는 TASK_MERGED_TO_DEFAULT).
-- 회차를 반복하는 실험에서는 끈다 — 회차마다 같은 출발점이어야 하는데 앞 회차 코드가 main에 남는다. 그래서 기본값은 꺼짐이고, 실험 모드에서만 켤 수 있다.
-- 시작(G1) 전에만 바꾼다(질문 모드와 같다).
ALTER TABLE projects ADD COLUMN auto_merge boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD CONSTRAINT projects_auto_merge_chk CHECK (NOT auto_merge OR question_mode = 'experiment');

-- Down Migration
ALTER TABLE projects DROP CONSTRAINT projects_auto_merge_chk;
ALTER TABLE projects DROP COLUMN auto_merge;
