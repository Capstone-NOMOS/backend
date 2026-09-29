-- Up Migration
-- ④ MCP 도구 2개(claim_task / submit_artifact)가 쓰는 스키마.

-- ① tasks.team_role — 지시서의 "호출자 team_role ≠ tasks.role → 403"이 참조하는 열.
-- ERD·006에 없던 컬럼이라 새로 만든다. NULL은 "역할 제한 없음"이고 통합 태스크(kind='INTEGRATION')가 그렇다.
-- 제한을 두려면 값을 채운다 — 기본값을 주지 않는 이유는 "지정을 잊은 것"과 "일부러 열어둔 것"이 달라서다.
ALTER TABLE tasks
  ADD COLUMN team_role text,
  ADD CONSTRAINT tasks_team_role_chk CHECK (team_role IS NULL OR team_role IN ('FRONTEND', 'BACKEND'));

-- ② artifacts — 제출 시점의 판정을 사실로 고정한다.
-- triggered_actions·gate_mode를 여기 박아두는 이유: repo_paths나 정책표가 나중에 바뀌어도
-- "이 제출은 그때 무엇에 걸렸고 어떤 승인이 필요했나"가 그대로 남아야 리플레이가 성립한다.
CREATE TABLE artifacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  commit_sha        text NOT NULL,
  changed_paths     text[] NOT NULL,
  triggered_actions text[] NOT NULL DEFAULT '{}',
  gate_mode         text NOT NULL,
  attempt           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT artifacts_gate_mode_chk CHECK (gate_mode IN ('AUTO', 'PM_REVIEW', 'HUMAN', 'FORBIDDEN')),
  CONSTRAINT artifacts_attempt_chk CHECK (attempt >= 1),
  -- 빈 제출을 막는다. 바꾼 게 없으면 V3가 검사할 대상도 없다.
  CONSTRAINT artifacts_paths_chk CHECK (cardinality(changed_paths) > 0),
  -- 같은 시도 번호가 두 번 들어가면 재시도 횟수(M3)가 어긋난다.
  CONSTRAINT uq_artifacts_attempt UNIQUE (task_id, attempt)
);
CREATE INDEX idx_artifacts_task ON artifacts(task_id, created_at);

-- Down Migration
DROP TABLE IF EXISTS artifacts;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_team_role_chk;
ALTER TABLE tasks DROP COLUMN IF EXISTS team_role;
