-- Up Migration

-- 질문 라우팅 입력 저장(질문 라우팅 실험 — docs/experiment-question-routing.md "맥락 저장과 재사용").
-- 질문이 라우팅될 때 라우터가 본 입력(RoutingInputSnapshot — src/domain/question/router.ts, 서버 전용 context는 뺀다)을 그대로 남긴다.
-- 명세·계약은 나중에 바뀌므로 다시 조립하면 그때의 맥락이 아니다 — 운영에서 나온 실제 질문을 같은 입력으로 몇 번이든 다시 비교하려면
-- 질문 INSERT와 같은 순간의 값을 저장해야 한다. 비밀값은 없다(명세·계약 요약·질문만). 이 컬럼이 생기기 전의 질문은 NULL.
ALTER TABLE agent_questions ADD COLUMN routing_input jsonb;

-- Down Migration

ALTER TABLE agent_questions DROP COLUMN IF EXISTS routing_input;
