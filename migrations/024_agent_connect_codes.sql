-- Up Migration

-- 1회용 연결 코드(대표 결정 2026-10-23). 웹에 로그인한 사람이 "에이전트 연결" 명령을 받을 때 서버가 만들고,
-- CLI가 `connect --code`로 내면 그 사람의 에이전트 자격 증명이 나간다.
--
-- 왜 필요한가: 노트북에 예전 계정의 자격 증명(~/.nomos/credentials)이 남아 있으면 connect가 그걸 조용히 재사용해,
-- 새 계정으로 가입해도 예전 계정의 에이전트로 붙었다(통합 테스트). 코드는 "이 명령은 이 계정용"을 실어 나른다.
-- 연결 키(기한 없는 비밀값)를 명령에 싣지 않는 이유: 셸 기록·화면 공유에 남으면 누구나 그 계정의 에이전트를 만든다.
-- 코드는 10분·1회용이고 해시로만 저장한다.

CREATE TABLE agent_connect_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  code_hash   text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  agent_id    uuid REFERENCES agents(id),
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- 쓰인 코드는 어느 에이전트가 됐는지 남는다. 반쪽 상태는 없다.
  CONSTRAINT agent_connect_codes_used_chk CHECK ((used_at IS NULL) = (agent_id IS NULL))
);

CREATE INDEX idx_agent_connect_codes_user ON agent_connect_codes (user_id, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS agent_connect_codes;
