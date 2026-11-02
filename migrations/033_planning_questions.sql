-- Up Migration

-- 기획 단계 질문과 실험 모드(대표 결정 2026-11-02).
--
-- 통합 테스트에서 PM이 기능 명세를, BE 에이전트가 API 계약을 쓸 때 혼자 정하면 안 되는 것을 임의로 정했다. 질문 기회가 구현 단계에만 있었다.
-- 그래서 기획 단계(기능 명세 초안·API 계약 초안)에서도 모르는 것을 가정하지 않고 질문으로 내고, 같은 라우터로 FE·BE·PM에게 보낸다.
--   stage        implementation(태스크 구현 중 — 지금까지의 질문) · feature_spec(PM이 기능 명세 초안을 쓰다가) · contract(BE가 API 계약 초안을 쓰다가)
--   plan_id      feature_spec 질문이 나온 계획(기능 명세 초안)
--   contract_id  contract 질문이 나온 계약
-- 기획 단계에는 태스크가 없다 — task_id를 비울 수 있게 하고, 단계마다 무엇이 있어야 하는지는 CHECK로 묶는다.
-- 기능 명세 질문은 PM이 묻는다(asker_role PM, 에이전트 행 없음 — 명의 system:pm). 계약 질문은 BE 에이전트가 묻는다.

ALTER TABLE agent_questions
  ADD COLUMN stage text NOT NULL DEFAULT 'implementation',
  ADD COLUMN plan_id uuid REFERENCES plans(id),
  ADD COLUMN contract_id uuid REFERENCES contracts(id),
  ALTER COLUMN task_id DROP NOT NULL,
  ALTER COLUMN asked_by_agent DROP NOT NULL;

ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_stage_chk CHECK (
  (stage = 'implementation' AND task_id IS NOT NULL AND asked_by_agent IS NOT NULL AND plan_id IS NULL AND contract_id IS NULL)
  OR (stage = 'feature_spec' AND plan_id IS NOT NULL AND task_id IS NULL AND asked_by_agent IS NULL AND contract_id IS NULL AND asker_role = 'PM')
  OR (stage = 'contract' AND contract_id IS NOT NULL AND task_id IS NULL AND asked_by_agent IS NOT NULL AND plan_id IS NULL AND asker_role = 'BACKEND')
);

ALTER TABLE agent_questions DROP CONSTRAINT agent_questions_roles_chk;
ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_roles_chk
  CHECK (asker_role IN ('FRONTEND', 'BACKEND', 'PM') AND target_role IN ('FRONTEND', 'BACKEND', 'PM'));

-- 실험 모드의 자동 답(첫 번째 선택지). 사람이 아니라 답한 사람이 없다 — answered이지만 answered_by는 비운다.
-- 정답 라벨(gold)과는 다르다: 자동 답은 실험을 끝까지 진행시키려는 것이지 정답이 아니다.
ALTER TABLE agent_questions DROP CONSTRAINT agent_questions_source_chk;
ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_source_chk
  CHECK (answer_source IS NULL OR answer_source IN ('agent', 'human', 'agent_confirmed', 'human_override', 'auto_first_option'));
ALTER TABLE agent_questions DROP CONSTRAINT agent_questions_answered_by_chk;
ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_answered_by_chk
  CHECK ((answered_by IS NOT NULL) = (status = 'answered' AND answer_source IS DISTINCT FROM 'auto_first_option'));
ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_auto_answer_chk
  CHECK (answer_source IS DISTINCT FROM 'auto_first_option' OR status = 'answered');

CREATE INDEX idx_agent_questions_plan ON agent_questions (plan_id) WHERE plan_id IS NOT NULL;
CREATE INDEX idx_agent_questions_contract ON agent_questions (contract_id) WHERE contract_id IS NOT NULL;

-- 질문 모드 — normal(기본) · experiment(질문 데이터를 모으는 실험: 상한 없음, 라우팅 기록 뒤 첫 선택지로 자동 답, 상담·PM 답 초안 생략).
-- 질문 중계가 꺼져 있으면 실험 모드는 의미가 없다 — 둘을 함께 묶는다.
ALTER TABLE projects ADD COLUMN question_mode text NOT NULL DEFAULT 'normal';
ALTER TABLE projects ADD CONSTRAINT projects_question_mode_chk
  CHECK (question_mode IN ('normal', 'experiment') AND (question_mode = 'normal' OR question_relay));

-- 수정 체인에서 왜 다시 썼나 — feedback(대표의 수정 요청, PM_MAX_REVISIONS에 센다) · answers(질문의 답을 붙여 다시 씀, 따로 센다).
ALTER TABLE plans ADD COLUMN revision_cause text;
UPDATE plans SET revision_cause = 'feedback' WHERE parent_plan_id IS NOT NULL;
ALTER TABLE plans ADD CONSTRAINT plans_revision_cause_chk
  CHECK ((parent_plan_id IS NULL) = (revision_cause IS NULL) AND (revision_cause IS NULL OR revision_cause IN ('feedback', 'answers')));

-- 계약이 질문의 답으로 다시 쓰인 횟수 — attempt(작성 회차)에 함께 들어가지만 BE 담당의 수정 요청 한도(CONTRACT_MAX_REVISIONS)에서는 뺀다.
ALTER TABLE contracts ADD COLUMN question_rounds integer NOT NULL DEFAULT 0;
ALTER TABLE contracts ADD CONSTRAINT contracts_question_rounds_chk CHECK (question_rounds >= 0 AND question_rounds < attempt);

-- Down Migration

ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_question_rounds_chk;
ALTER TABLE contracts DROP COLUMN IF EXISTS question_rounds;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_revision_cause_chk;
ALTER TABLE plans DROP COLUMN IF EXISTS revision_cause;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_question_mode_chk;
ALTER TABLE projects DROP COLUMN IF EXISTS question_mode;
DROP INDEX IF EXISTS idx_agent_questions_contract;
DROP INDEX IF EXISTS idx_agent_questions_plan;
DELETE FROM question_routing_runs WHERE question_id IN (SELECT id FROM agent_questions WHERE stage <> 'implementation');
DELETE FROM agent_questions WHERE stage <> 'implementation';
UPDATE agent_questions SET status = 'expired', answers = NULL, answer_source = NULL, answered_at = NULL WHERE answer_source = 'auto_first_option';
ALTER TABLE agent_questions DROP CONSTRAINT IF EXISTS agent_questions_auto_answer_chk;
ALTER TABLE agent_questions DROP CONSTRAINT agent_questions_answered_by_chk;
ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_answered_by_chk CHECK ((status = 'answered') = (answered_by IS NOT NULL));
ALTER TABLE agent_questions DROP CONSTRAINT agent_questions_source_chk;
ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_source_chk
  CHECK (answer_source IS NULL OR answer_source IN ('agent', 'human', 'agent_confirmed', 'human_override'));
ALTER TABLE agent_questions DROP CONSTRAINT agent_questions_roles_chk;
ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_roles_chk
  CHECK (asker_role IN ('FRONTEND', 'BACKEND') AND target_role IN ('FRONTEND', 'BACKEND', 'PM'));
ALTER TABLE agent_questions DROP CONSTRAINT IF EXISTS agent_questions_stage_chk;
ALTER TABLE agent_questions
  ALTER COLUMN asked_by_agent SET NOT NULL,
  ALTER COLUMN task_id SET NOT NULL,
  DROP COLUMN IF EXISTS contract_id,
  DROP COLUMN IF EXISTS plan_id,
  DROP COLUMN IF EXISTS stage;
