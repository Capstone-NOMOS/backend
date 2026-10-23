-- Up Migration

-- 질문 라우팅 평가 기록(발표 지표용, 대표 결정 2026-10-23). 서비스 동작에는 쓰지 않는다.
--
-- 실제 운영 질문마다 "누구에게 보냈나"를 라우터별로 남겨, 같은 질문에서 라우터들을 비교한다:
--   primary  실제로 질문을 보낸 라우터(대체됐으면 대체한 규칙 라우터)
--   shadow   보내지는 않고 같은 입력으로 함께 돌려 본 라우터(QUESTION_SHADOW_ROUTERS — LLM·Decision AI·규칙)
-- 정답 담당자(gold_target)는 사람이 나중에 붙인다(POST /questions/:id/gold). 그 뒤 GET /projects/:id/routing-report가
-- 라우터별 최초 수신자-정답 일치율·분류 지연·요청당 비용을 낸다. 조건 A(기존 다인 개발 = 질문한 사람에게)는 SELF로 계산한다.
-- 상태 변화가 아니라 측정값이라 events가 아닌 별도 표다(agent_activity와 같은 이유). 정답 라벨은 사람의 행동이라 이벤트도 남긴다.

CREATE TABLE question_routing_runs (
  id           bigserial PRIMARY KEY,
  question_id  uuid NOT NULL REFERENCES agent_questions(id),
  router       text NOT NULL,
  mode         text NOT NULL,
  target       text,
  confidence   double precision,
  latency_ms   integer NOT NULL,
  cost_usd     numeric(12, 6),
  error        text,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT question_routing_runs_mode_chk CHECK (mode IN ('primary', 'shadow')),
  CONSTRAINT question_routing_runs_target_chk CHECK (target IS NULL OR target IN ('FRONTEND', 'BACKEND', 'PM', 'SELF')),
  -- 판정이 없으면 실패 사유가 있다.
  CONSTRAINT question_routing_runs_result_chk CHECK ((target IS NULL) = (error IS NOT NULL))
);

CREATE INDEX idx_question_routing_runs_question ON question_routing_runs (question_id);

ALTER TABLE agent_questions
  ADD COLUMN gold_target     text,
  ADD COLUMN gold_labeled_by uuid REFERENCES users(id),
  ADD COLUMN gold_labeled_at timestamptz,
  ADD COLUMN gold_note       text,
  ADD CONSTRAINT agent_questions_gold_chk
    CHECK ((gold_target IS NULL) = (gold_labeled_by IS NULL AND gold_labeled_at IS NULL)
           AND (gold_target IS NULL OR gold_target IN ('FRONTEND', 'BACKEND', 'PM', 'SELF')));

-- Down Migration

ALTER TABLE agent_questions
  DROP CONSTRAINT IF EXISTS agent_questions_gold_chk,
  DROP COLUMN IF EXISTS gold_note,
  DROP COLUMN IF EXISTS gold_labeled_at,
  DROP COLUMN IF EXISTS gold_labeled_by,
  DROP COLUMN IF EXISTS gold_target;
DROP TABLE IF EXISTS question_routing_runs;
