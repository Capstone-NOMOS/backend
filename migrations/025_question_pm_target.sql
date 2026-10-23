-- Up Migration

-- 질문 대상에 PM(대표가 운용하는 PM 에이전트 = 대표)을 더한다(대표 결정 2026-10-23).
-- 라우터가 FE·BE·PM 중 답을 정할 권한이 있는 쪽을 고른다. 요구사항·정책·제품 결정은 PM이고, 대표 노트북의 PM 에이전트가
-- 기능 명세·확정한 계약을 읽고 답 초안을 쓴 뒤 대표가 확정한다.
--   - PM 초안은 에이전트 행이 없을 수 있다(API 모드면 서버가 쓴다) — drafted_by_agent는 PM 질문에서만 비워도 된다.
--   - PM 질문은 초안이 곧 답(agent_answered)이 되지 않는다. 제품 결정은 대표가 확정한다.

ALTER TABLE agent_questions DROP CONSTRAINT agent_questions_roles_chk;
ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_roles_chk
  CHECK (asker_role IN ('FRONTEND', 'BACKEND') AND target_role IN ('FRONTEND', 'BACKEND', 'PM'));

ALTER TABLE agent_questions DROP CONSTRAINT agent_questions_draft_chk;
ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_draft_chk
  CHECK ((draft IS NULL) = (drafted_at IS NULL) AND (draft IS NULL OR drafted_by_agent IS NOT NULL OR target_role = 'PM'));

ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_pm_human_chk
  CHECK (target_role <> 'PM' OR status <> 'agent_answered');

-- Down Migration

ALTER TABLE agent_questions DROP CONSTRAINT IF EXISTS agent_questions_pm_human_chk;
ALTER TABLE agent_questions DROP CONSTRAINT agent_questions_draft_chk;
ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_draft_chk
  CHECK ((draft IS NULL) = (drafted_by_agent IS NULL AND drafted_at IS NULL));
ALTER TABLE agent_questions DROP CONSTRAINT agent_questions_roles_chk;
ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_roles_chk
  CHECK (asker_role IN ('FRONTEND', 'BACKEND') AND target_role IN ('FRONTEND', 'BACKEND'));
