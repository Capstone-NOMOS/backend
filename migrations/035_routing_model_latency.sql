-- Up Migration

-- 질문 라우팅의 "판정 시간"(대표 결정 2026-11-03) — 라우터 비교(Claude · OpenAI · Jev)를 공정하게 하려고 지연을 둘로 나눈다.
--   latency_ms       질문이 서버에서 라우터를 부른 순간부터 판정이 돌아올 때까지(에이전트가 실제로 기다린 시간 — 중계면 대기열·노트북 CLI 기동이 섞인다)
--   model_latency_ms 판정자에게 요청이 도달해 답이 나오기까지(모델 API 호출 시간). API 라우터(openai·jev)는 서버가 잰 API 호출 시간,
--                    중계 라우터(llm relay)는 노트북의 Claude Code가 보고한 duration_api_ms. 모르면 NULL(옛 CLI·실패) — 지어내지 않는다.
-- 측정 위치(서버/노트북)가 달라 네트워크 경로·연결 재사용의 차이는 남는다 — 같은 위치 비교는 오프라인 평가(scripts/eval-question-router.ts)가 한다.
ALTER TABLE question_routing_runs ADD COLUMN model_latency_ms integer;
ALTER TABLE question_routing_runs ADD CONSTRAINT question_routing_runs_model_latency_chk
  CHECK (model_latency_ms IS NULL OR (model_latency_ms >= 0 AND target IS NOT NULL));

-- Down Migration
ALTER TABLE question_routing_runs DROP CONSTRAINT question_routing_runs_model_latency_chk;
ALTER TABLE question_routing_runs DROP COLUMN model_latency_ms;
