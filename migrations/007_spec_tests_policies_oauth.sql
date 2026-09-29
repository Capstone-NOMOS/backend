-- Up Migration
-- 007: Phase 2 선행 테이블 중 누락분만.
--   action_catalog 13행 시드 → 004에서 이미 17행(L1~L4 + 🔒 5행)으로 교체됨. 손대지 않는다.
--   events 실험 컬럼 8개 → 001부터 있음. 손대지 않는다.

-- ① action_catalog.lock_key — project_policies가 🔒 행을 위조하지 못하게 만드는 FK 타깃.
-- locked_mode는 비잠금 행에서 NULL이고, 복합 FK는 참조 컬럼에 NULL이 하나라도 있으면
-- 검사를 통째로 건너뛴다(MATCH SIMPLE). 그러면 잠금 행을 "NULL(=비잠금)"이라 주장하는 위조가 통과한다.
-- NULL을 '-'로 접어 항상 non-NULL로 만들면 FK가 매번 실제로 검사된다.
ALTER TABLE action_catalog
  ADD COLUMN lock_key text GENERATED ALWAYS AS (coalesce(locked_mode, '-')) STORED;
CREATE UNIQUE INDEX uq_action_catalog_lock_key ON action_catalog(action_key, lock_key);

-- ② project_policies — 해석이 끝난 판정 17행.
-- 판정은 action_catalog가 아니라 이 테이블만 본다: 정책표가 나중에 바뀌어도 과거 실험의 리플레이가 재현된다.
--
-- 프로젝트 생성 시 복사 쿼리:
--   INSERT INTO project_policies (project_id, action_key, mode, lock_key)
--   SELECT $1, action_key,
--          CASE $2 WHEN 'L1' THEN mode_l1 WHEN 'L2' THEN mode_l2
--                  WHEN 'L3' THEN mode_l3 ELSE mode_l4 END,
--          lock_key
--     FROM action_catalog;
--
-- G1 이후(projects.started_at IS NOT NULL) 수정 금지는 다른 테이블 조건이라 CHECK로 못 건다 — 서비스에서 막는다.
CREATE TABLE project_policies (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action_key text NOT NULL REFERENCES action_catalog(action_key),
  mode       text NOT NULL,
  lock_key   text NOT NULL,
  PRIMARY KEY (project_id, action_key),

  CONSTRAINT project_policies_mode_chk CHECK (mode IN ('AUTO', 'PM_REVIEW', 'HUMAN', 'FORBIDDEN')),
  -- 🔒 행은 대표도 못 바꾼다. lock_key는 FK가 실제 locked_mode와 일치시키고,
  -- 그 값이 '-'가 아니면 mode가 거기에 고정된다. 비잠금 행('-')만 mode가 자유롭다.
  CONSTRAINT project_policies_locked_chk CHECK (lock_key = '-' OR mode = lock_key),
  CONSTRAINT project_policies_lock_fk FOREIGN KEY (action_key, lock_key)
    REFERENCES action_catalog(action_key, lock_key)
);

-- ③ spec_tests — V2의 시험지. "출제자(PM)와 응시자(구현 에이전트)가 다르다"의 증거물.
-- locked_at < artifacts.created_at(G1 승인 후 잠김) 검사는 artifacts 테이블이 생길 때 붙인다.
CREATE TABLE spec_tests (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id    uuid NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
  criterion  text NOT NULL,
  test_code  text NOT NULL,
  locked_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_spec_tests_spec ON spec_tests(spec_id);

-- ④ oauth_sessions — collaborator 조회용 GitHub 토큰 보관.
-- ERD의 github_token을 github_token_enc로 바꿨다: 컬럼 이름이 평문 저장을 막는 첫 번째 방어선이다.
-- 암호화 키는 KMS, 로컬 개발은 환경변수 폴백 — 복호화 유틸은 OAuth 구현 때 붙인다.
CREATE TABLE oauth_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  github_token_enc text,
  scope            text,
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_oauth_sessions_user ON oauth_sessions(user_id);

-- Down Migration
DROP TABLE IF EXISTS oauth_sessions;
DROP TABLE IF EXISTS spec_tests;
DROP TABLE IF EXISTS project_policies;
DROP INDEX IF EXISTS uq_action_catalog_lock_key;
ALTER TABLE action_catalog DROP COLUMN IF EXISTS lock_key;
