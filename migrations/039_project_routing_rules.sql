-- Up Migration

-- 팀별 질문 라우팅 규칙(039). 질문 정답은 팀의 합의라 팀마다 다르다 — "화면 문구는 PM이 정한다"는 팀도, "FE가 정한다"는 팀도 있다.
-- 대표가 역할마다(PM·FRONTEND·BACKEND) 그리고 역할에 딸리지 않은 공통 원칙(COMMON)을 문장으로 적으면, 질문이 올 때
-- 라우터 입력(RoutingInput.teamRules)에 들어가 세 라우터(Claude·OpenAI·Jev)가 같은 문장을 받는다.
-- NULL = 규칙 없음(예전과 같은 프롬프트). 키는 앱이 거른다(COMMON·PM·FRONTEND·BACKEND, 값은 문자열) — DB는 객체인지만 본다.
-- 시작(G1) 뒤에도 바꿀 수 있다: 권한·정책이 아니라 질문을 누구에게 먼저 보낼지의 판단 기준이고, 판정 기록(routed_by)에 규칙 해시가 붙어 규칙 전·후가 섞이지 않는다.
ALTER TABLE projects ADD COLUMN routing_rules jsonb;
ALTER TABLE projects ADD CONSTRAINT projects_routing_rules_chk CHECK (routing_rules IS NULL OR jsonb_typeof(routing_rules) = 'object');

-- Down Migration
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_routing_rules_chk;
ALTER TABLE projects DROP COLUMN IF EXISTS routing_rules;
