-- Up Migration

-- 질문 재지정(038): 라우터가 정한 대상(target_role)이 그 일을 정할 사람이 아니면, 지금 대상 역할 담당이나 대표가 다른 역할로 다시 보낸다.
-- target_role은 "지금 답할 역할"로 바뀌고(답할 자격·받은 편지함·상담 실행·결정 전달이 모두 이 값을 읽는다),
-- 라우터가 처음 정한 대상은 rerouted_from에 남긴다 — 라우팅 평가(데이터셋 내보내기)는 COALESCE(rerouted_from, target_role)로
-- "라우터가 실제로 보낸 판정"을 그대로 읽는다. 재지정해도 평가 숫자가 바뀌지 않게 하기 위해서다.
-- NULL = 재지정된 적 없음. 여러 번 재지정해도 처음 판정만 남긴다(UPDATE의 COALESCE).
ALTER TABLE agent_questions ADD COLUMN rerouted_from text;
ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_rerouted_from_chk
  CHECK (rerouted_from IS NULL OR rerouted_from IN ('FRONTEND', 'BACKEND', 'PM'));

-- Down Migration

ALTER TABLE agent_questions DROP CONSTRAINT IF EXISTS agent_questions_rerouted_from_chk;
ALTER TABLE agent_questions DROP COLUMN IF EXISTS rerouted_from;
