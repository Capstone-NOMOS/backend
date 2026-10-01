-- Up Migration
-- CLI 연결을 브라우저 승인으로(OAuth Device Authorization Grant, RFC 8628). NOMOS가 인증 서버다.
-- CLI가 요청을 만들고(코드 발급) → 사용자가 로그인된 웹에서 승인 → CLI가 poll로 토큰을 받는다.
-- 연결 키 붙여넣기(POST /agents/connect)는 브라우저가 없는 환경(SSH)용으로 그대로 둔다.

CREATE TABLE agent_device_requests (
  id               uuid PRIMARY KEY,
  -- CLI가 poll에 쓰는 비밀. 평문은 저장하지 않는다(무작위 32바이트라 sha256으로 충분하고, 결정적이어야 해시로 찾는다).
  device_code_hash text NOT NULL UNIQUE,
  -- 사람이 웹에 입력·확인하는 코드. 정규화(대문자, 하이픈 제거)한 8자.
  user_code        text NOT NULL,
  agent_name       text NOT NULL,
  harness          text NOT NULL,
  skills           text[] NOT NULL DEFAULT '{}',
  max_concurrent   int  NOT NULL,
  -- 승인 화면에 보여 준다(피싱 대비 — "방금 내 터미널에서 실행한 게 아니면 거부").
  client_ip        text,
  -- EXPIRED는 저장하지 않는다 — expires_at으로 계산한다(만료시키는 작업이 따로 돌 필요가 없게).
  status           text NOT NULL DEFAULT 'PENDING',
  decided_by       uuid REFERENCES users(id),
  decided_at       timestamptz,
  -- poll 간격(초). 너무 빨리 부르면 slow_down과 함께 늘린다.
  poll_interval    int  NOT NULL DEFAULT 5,
  last_polled_at   timestamptz,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_device_requests_status_chk CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'CONSUMED')),
  CONSTRAINT agent_device_requests_user_code_chk CHECK (user_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{8}$'),
  -- 결정(승인·거부)에는 결정한 사람과 시각이 함께 있어야 한다.
  CONSTRAINT agent_device_requests_decided_chk CHECK ((status = 'PENDING') = (decided_by IS NULL AND decided_at IS NULL))
);

-- 살아 있는 요청끼리만 userCode가 겹치지 않으면 된다. 충돌하면 코드를 다시 뽑는다.
CREATE UNIQUE INDEX agent_device_requests_live_user_code
  ON agent_device_requests (user_code) WHERE status IN ('PENDING', 'APPROVED');

-- Down Migration
DROP TABLE IF EXISTS agent_device_requests;
