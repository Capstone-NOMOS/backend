-- Up Migration

-- ① users — 로컬 계정. 가입 직후에는 조직도 GitHub 계정도 없다.
ALTER TABLE users
  ADD COLUMN login_id         text,
  ADD COLUMN password_hash    text,
  ADD COLUMN nickname         text,
  ADD COLUMN connect_key_hash text;

-- org_id는 NULL -> 값으로 한 번만 바뀐다(단일 조직). 다른 조직으로 옮기는 경로는 만들지 않는다.
ALTER TABLE users
  ALTER COLUMN github_id    DROP NOT NULL,
  ALTER COLUMN github_login DROP NOT NULL,
  ALTER COLUMN org_id       DROP NOT NULL,
  ALTER COLUMN org_role     SET DEFAULT 'MEMBER';

CREATE UNIQUE INDEX uq_users_login_id ON users(login_id)
  WHERE login_id IS NOT NULL;
CREATE UNIQUE INDEX uq_users_connect_key ON users(connect_key_hash)
  WHERE connect_key_hash IS NOT NULL;

-- 001의 UNIQUE (org_id, github_id)는 인덱스가 아니라 테이블 제약이라 DROP INDEX로는 지워지지 않는다.
ALTER TABLE users DROP CONSTRAINT users_org_id_github_id_key;
CREATE UNIQUE INDEX uq_users_org_github ON users(org_id, github_id)
  WHERE org_id IS NOT NULL AND github_id IS NOT NULL;

-- ② events — 조직에 들기 전의 행동(가입, 연결 키 교체, CLI 연결)도 기록해야 한다(P5).
ALTER TABLE events ALTER COLUMN org_id DROP NOT NULL;

-- ③ agents / agent_tokens. projects에 의존하지 않으므로 지금 만든다.
CREATE TABLE agents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id         uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name           text NOT NULL,
  harness        text NOT NULL,
  skills         text[] NOT NULL DEFAULT '{}',
  max_concurrent integer NOT NULL DEFAULT 2,
  status         text NOT NULL DEFAULT 'pending',
  settings_hash  text,
  last_seen_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agents_status_chk CHECK (status IN ('pending','online','offline'))
);
-- org_id가 NULL일 수 있으므로 (org_id, name)이 아니라 (user_id, name)으로 유일성을 건다.
CREATE UNIQUE INDEX uq_agents_user_name ON agents(user_id, name);

-- access token은 JWT라 저장하지 않는다. refresh token만 해시로 저장.
CREATE TABLE agent_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  kind       text NOT NULL DEFAULT 'refresh',
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_tokens_agent ON agent_tokens(agent_id, kind);

-- ④ repos — 통합 방식이 "레포별 dev 배포 -> 상대가 실제 호출"로 바뀌었다.
-- github_repo_id는 001에 이미 있다.
ALTER TABLE repos
  ADD COLUMN dev_branch   text NOT NULL DEFAULT 'dev',
  ADD COLUMN dev_base_url text;

-- ⑤ invites — 초대할 때 역할을 지정한다. project_id는 projects가 생기는 Phase 2에서.
ALTER TABLE invites ADD COLUMN team_role text;
ALTER TABLE invites ADD CONSTRAINT invites_role_chk
  CHECK (team_role IS NULL OR team_role IN ('FRONTEND','BACKEND'));

-- ⑥ repo_paths — QA 역할 삭제. 001의 CHECK가 QA를 허용하므로 추가가 아니라 교체한다.
UPDATE repo_paths SET owner_role = NULL WHERE owner_role = 'QA';
ALTER TABLE repo_paths DROP CONSTRAINT repo_paths_owner_role_check;
ALTER TABLE repo_paths ADD CONSTRAINT repo_paths_owner_role_chk
  CHECK (owner_role IS NULL OR owner_role IN ('FRONTEND','BACKEND'));

-- events 실험 컬럼 8개와 (run_id, arm, type) 인덱스는 001에 이미 있다(idx_events_run).

-- Down Migration
-- 조직 없는 사용자나 이벤트가 있으면 NOT NULL 복원에서 의도적으로 실패한다.
-- 계정을 조용히 지우는 것보다 멈추는 편이 낫다.

ALTER TABLE repo_paths DROP CONSTRAINT repo_paths_owner_role_chk;
ALTER TABLE repo_paths ADD CONSTRAINT repo_paths_owner_role_check
  CHECK (owner_role IN ('FRONTEND','BACKEND','QA'));

ALTER TABLE invites DROP CONSTRAINT invites_role_chk;
ALTER TABLE invites DROP COLUMN team_role;

ALTER TABLE repos DROP COLUMN dev_base_url, DROP COLUMN dev_branch;

DROP TABLE agent_tokens;
DROP TABLE agents;

ALTER TABLE events ALTER COLUMN org_id SET NOT NULL;

DROP INDEX uq_users_org_github;
ALTER TABLE users ADD CONSTRAINT users_org_id_github_id_key UNIQUE (org_id, github_id);
DROP INDEX uq_users_connect_key;
DROP INDEX uq_users_login_id;

ALTER TABLE users
  ALTER COLUMN org_role     DROP DEFAULT,
  ALTER COLUMN org_id       SET NOT NULL,
  ALTER COLUMN github_login SET NOT NULL,
  ALTER COLUMN github_id    SET NOT NULL;

ALTER TABLE users
  DROP COLUMN connect_key_hash,
  DROP COLUMN nickname,
  DROP COLUMN password_hash,
  DROP COLUMN login_id;
