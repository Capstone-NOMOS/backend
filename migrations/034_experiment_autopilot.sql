-- Up Migration

-- 무인 실험(대표 결정 2026-11-02) — 실험 모드(question_mode = experiment) 프로젝트는 사람 없이 끝까지 돈다.
-- 사람이 누르던 결정(초안 확정·계약 확정·승인)과 실패 뒤 다시 시키기를 서버가 system:experiment 명의로 대신한다(domain/experiment).
-- 기본 모드(normal)에는 아무것도 바뀌지 않는다 — 새 값은 실험 모드의 자동 경로만 쓴다.
--
-- plans.revision_cause에 retry — 실험 모드에서 실패한 PM 초안을 같은 요청(같은 지시·같은 답)으로 다시 낸 판.
--   대표의 수정 요청(feedback, PM_MAX_REVISIONS)과 질문의 답(answers, 답 회차)과 따로 센다(EXPERIMENT_PLAN_RETRIES).
ALTER TABLE plans DROP CONSTRAINT plans_revision_cause_chk;
ALTER TABLE plans ADD CONSTRAINT plans_revision_cause_chk
  CHECK ((parent_plan_id IS NULL) = (revision_cause IS NULL) AND (revision_cause IS NULL OR revision_cause IN ('feedback', 'answers', 'retry')));

-- contracts.experiment_retries — 실험 모드에서 실패한 계약 초안을 자동으로 다시 시킨 횟수(EXPERIMENT_CONTRACT_RETRIES).
--   attempt에 함께 들어가지만 BE 담당의 수정 요청 한도(CONTRACT_MAX_REVISIONS)에서는 뺀다 — question_rounds와 같은 이유.
ALTER TABLE contracts ADD COLUMN experiment_retries integer NOT NULL DEFAULT 0;
ALTER TABLE contracts DROP CONSTRAINT contracts_question_rounds_chk;
ALTER TABLE contracts ADD CONSTRAINT contracts_question_rounds_chk
  CHECK (question_rounds >= 0 AND experiment_retries >= 0 AND question_rounds + experiment_retries < attempt);

-- Down Migration

ALTER TABLE contracts DROP CONSTRAINT contracts_question_rounds_chk;
ALTER TABLE contracts ADD CONSTRAINT contracts_question_rounds_chk CHECK (question_rounds >= 0 AND question_rounds < attempt);
ALTER TABLE contracts DROP COLUMN IF EXISTS experiment_retries;
UPDATE plans SET revision_cause = 'feedback' WHERE revision_cause = 'retry';
ALTER TABLE plans DROP CONSTRAINT plans_revision_cause_chk;
ALTER TABLE plans ADD CONSTRAINT plans_revision_cause_chk
  CHECK ((parent_plan_id IS NULL) = (revision_cause IS NULL) AND (revision_cause IS NULL OR revision_cause IN ('feedback', 'answers')));
