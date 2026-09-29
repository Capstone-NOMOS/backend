-- Up Migration
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- action_catalog: 행동 카탈로그. repo_paths.action_key가 이 테이블을 참조하므로 먼저 생성한다.
CREATE TABLE action_catalog (
  action_key   text PRIMARY KEY,
  label        text NOT NULL,
  rung         integer NOT NULL,
  locked_mode  text CHECK (locked_mode IN ('AUTO', 'HUMAN', 'FORBIDDEN'))
);

-- organizations: created_by는 아직 존재하지 않는 users 행을 가리킬 수 있어야 하므로
-- FK를 여기서 걸지 않고 users 테이블 생성 후 DEFERRABLE로 추가한다 (순환 참조 처리).
CREATE TABLE organizations (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- users: 한 조직에만 속한다 (org_id NOT NULL, 다중 조직 지원은 범위 밖).
CREATE TABLE users (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id),
  github_id   bigint NOT NULL,
  github_login text NOT NULL,
  name        text,
  org_role    text NOT NULL CHECK (org_role IN ('REPRESENTATIVE', 'MEMBER')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, github_id)
);

-- 조직당 대표는 1명. 부분 유니크 인덱스로 강제한다 (DBML로 표현 불가).
CREATE UNIQUE INDEX uq_representative ON users(org_id) WHERE org_role = 'REPRESENTATIVE';

-- organizations.created_by -> users.id. 같은 트랜잭션에서 organizations, users를 함께
-- INSERT하므로 커밋 시점까지 FK 검사를 미룬다.
ALTER TABLE organizations
  ADD CONSTRAINT fk_org_created_by FOREIGN KEY (created_by) REFERENCES users(id)
  DEFERRABLE INITIALLY DEFERRED;

-- repos: 조직에 연결된 GitHub 레포.
CREATE TABLE repos (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id),
  full_name       text NOT NULL,
  github_repo_id  bigint,
  default_branch  text NOT NULL DEFAULT 'main',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, full_name)
);

-- repo_paths: 레포 내 경로별 소유권/접근 규칙. action_key는 action_catalog를 참조.
CREATE TABLE repo_paths (
  id           uuid PRIMARY KEY,
  repo_id      uuid NOT NULL REFERENCES repos(id),
  path_pattern text NOT NULL,
  owner_role   text CHECK (owner_role IN ('FRONTEND', 'BACKEND', 'QA')),
  access       text NOT NULL CHECK (access IN ('write', 'read', 'denied')),
  action_key   text REFERENCES action_catalog(action_key),
  priority     integer NOT NULL,
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('seed', 'scan', 'manual')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_id, path_pattern)
);

-- invites: 대표가 발급하는 초대 링크. 토큰은 애플리케이션에서 생성한 랜덤 문자열.
CREATE TABLE invites (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id),
  token       text NOT NULL UNIQUE,
  created_by  uuid NOT NULL REFERENCES users(id),
  expires_at  timestamptz NOT NULL,
  used_by     uuid REFERENCES users(id),
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- events: 유일한 진실(P5). append-only. on_behalf_of는 NOT NULL (P3).
-- id가 bigserial인 이유: 재연결 시 "마지막으로 받은 번호 다음부터"를 요청하려면 단조 증가하는
-- 순번이어야 한다. uuid로 만들면 나중에 순번으로 바꿀 수 없다.
CREATE TABLE events (
  id               bigserial PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES organizations(id),
  project_id       uuid,
  type             text NOT NULL,
  actor_agent_id   uuid,
  on_behalf_of     text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key  text UNIQUE,

  -- 실험(M5′/M6) 컬럼. Phase 1에서는 아무도 쓰지 않지만 컬럼은 지금 있어야 한다.
  -- 나중에 추가하면 그때까지 쌓인 이벤트가 전부 NULL이라 회차 비교가 불가능해진다.
  run_id           uuid,
  arm              text,
  injected_fault   text,
  policy_hash      text,
  token_cost       numeric(10, 6),
  latency_ms       integer,
  path_violation   boolean,
  owner_role       text,

  ts               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_org ON events(org_id, id);
CREATE INDEX idx_events_run ON events(run_id, arm, type);
CREATE INDEX idx_events_project_ts ON events(project_id, ts);

-- Down Migration
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS invites;
DROP TABLE IF EXISTS repo_paths;
DROP TABLE IF EXISTS repos;
ALTER TABLE IF EXISTS organizations DROP CONSTRAINT IF EXISTS fk_org_created_by;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS organizations;
DROP TABLE IF EXISTS action_catalog;
