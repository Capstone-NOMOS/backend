-- Up Migration
-- Phase 2 선행 테이블. 순서: projects → project_repos / project_members → specs → plans → tasks / task_deps
-- 컬럼은 docs/erd.dbml 그대로. notes는 tasks가 실제로 CLAIM 가능해진 뒤 다음 마이그레이션에서.

-- ① projects
-- constitution: G1 승인 시점 org 헌법 사본. organizations.constitution이 바뀌어도 과거 판정 근거는 불변.
-- pm_budget_usd: PM은 NOMOS 키로 돌아 비용을 우리가 부담한다 — 그래서 NOT NULL.
-- policy_hash: autonomy_preset으로 해석한 정책 스냅샷의 해시. 프로젝트 생성 시점에 정해진다.
CREATE TABLE projects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              text NOT NULL,
  mode              text,
  autonomy_preset   text NOT NULL,
  policy_hash       text NOT NULL,
  constitution      jsonb NOT NULL DEFAULT '{}'::jsonb,
  constitution_hash text,
  deadline          date,
  budget_usd        numeric(10, 2),
  pm_budget_usd     numeric(10, 2) NOT NULL,
  status            text NOT NULL DEFAULT 'planning',
  halt_reason       text,
  halted_at         timestamptz,
  halted_by         uuid REFERENCES users(id),
  created_by        uuid NOT NULL REFERENCES users(id),
  started_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT projects_mode_chk CHECK (mode IS NULL OR mode IN ('SEQUENTIAL', 'CONTRACT_PARALLEL', 'HYBRID')),
  CONSTRAINT projects_preset_chk CHECK (autonomy_preset IN ('L1', 'L2', 'L3', 'L4')),
  CONSTRAINT projects_status_chk CHECK (status IN ('planning', 'active', 'halted', 'completed', 'aborted')),
  -- 이유 없는 정지를 DB가 거부한다. 정지 사유는 사람이 판단을 복기할 때 유일한 단서다.
  CONSTRAINT projects_halt_chk CHECK (status <> 'halted' OR halt_reason IS NOT NULL),
  CONSTRAINT projects_halt_reason_chk CHECK (halt_reason IS NULL OR halt_reason IN ('manual', 'budget', 'escalation'))
);
CREATE INDEX idx_projects_org ON projects(org_id, created_at);

-- ② project_repos / project_members
-- 활성 프로젝트끼리 repo_id 중복 금지는 앱 레벨 검증 (같은 레포를 두 프로젝트가 동시에 쓰면 소유권이 겹친다).
CREATE TABLE project_repos (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo_id    uuid NOT NULL REFERENCES repos(id),
  PRIMARY KEY (project_id, repo_id)
);

-- 역할당 에이전트 1개 — 실험 통제. team_role은 FRONTEND/BACKEND 2종 (QA 없음).
CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id   uuid NOT NULL REFERENCES agents(id),
  team_role  text NOT NULL,
  PRIMARY KEY (project_id, agent_id),

  CONSTRAINT project_members_role_chk CHECK (team_role IN ('FRONTEND', 'BACKEND'))
);
CREATE UNIQUE INDEX uq_project_members_role ON project_members(project_id, team_role);

-- ③ specs — EARS 명세서. v1→v1.1은 UPDATE가 아니라 새 행.
CREATE TABLE specs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feature_key   text NOT NULL,
  title         text NOT NULL,
  content       text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  superseded_by uuid REFERENCES specs(id),
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (project_id, feature_key, version)
);

-- ④ plans — M6를 둘로 쪼개기 위한 테이블.
-- M6a 계획 결정성: 같은 입력 3회 → dag_hash 유사도. M6b 실행 결정성: source='replay'로 같은 DAG 주입.
CREATE TABLE plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id       uuid,
  dag_snapshot jsonb NOT NULL,
  dag_hash     text NOT NULL,
  source       text NOT NULL DEFAULT 'planner',
  mode         text,
  approved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT plans_source_chk CHECK (source IN ('planner', 'replay'))
);
CREATE INDEX idx_plans_project ON plans(project_id, created_at);
CREATE INDEX idx_plans_run ON plans(run_id);

-- ⑤ tasks — events의 프로젝션. 진실은 events.
-- 8개 상태: READY | CLAIMED | IN_PROGRESS | VERIFYING | AWAITING_APPROVAL | BLOCKED | ESCALATED | DONE
-- contract_id는 contracts 테이블이 생기는 다음 마이그레이션에서 FK를 건다(지금은 컬럼만).
CREATE TABLE tasks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id            uuid REFERENCES plans(id),
  spec_id            uuid REFERENCES specs(id),
  contract_id        uuid,
  repo_id            uuid NOT NULL REFERENCES repos(id),
  kind               text NOT NULL DEFAULT 'IMPLEMENT',
  title              text NOT NULL,
  assignee_agent_id  uuid REFERENCES agents(id),
  state              text NOT NULL DEFAULT 'READY',
  blocked_reason     text,
  branch_name        text,
  retry_count        integer NOT NULL DEFAULT 0,
  ping_pong_count    integer NOT NULL DEFAULT 0,
  blocked_by_task_id uuid REFERENCES tasks(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tasks_kind_chk CHECK (kind IN ('IMPLEMENT', 'INTEGRATION', 'REWORK')),
  CONSTRAINT tasks_state_chk CHECK (state IN
    ('READY', 'CLAIMED', 'IN_PROGRESS', 'VERIFYING', 'AWAITING_APPROVAL', 'BLOCKED', 'ESCALATED', 'DONE')),
  CONSTRAINT tasks_blocked_reason_chk CHECK (blocked_reason IS NULL OR blocked_reason IN
    ('DISPUTE', 'DEPENDENCY', 'QUESTION')),
  -- BLOCKED면 사유가 반드시 있고, BLOCKED가 아니면 사유가 남아 있을 수 없다.
  -- M2(자동 해소율)의 분모가 blocked_reason='DISPUTE'라서, 사유가 비거나 남으면 킬러 지표가 오염된다.
  CONSTRAINT tasks_blocked_pair_chk CHECK ((state = 'BLOCKED') = (blocked_reason IS NOT NULL))
);
CREATE INDEX idx_tasks_project_state ON tasks(project_id, state);
CREATE INDEX idx_tasks_assignee_state ON tasks(assignee_agent_id, state);
CREATE INDEX idx_tasks_plan ON tasks(plan_id);

-- ⑥ task_deps
CREATE TABLE task_deps (
  task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on uuid NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on),

  CONSTRAINT task_deps_self_chk CHECK (task_id <> depends_on)
);

-- ⑦ events의 미완성 FK를 지금 채운다 (참조 대상 테이블이 생겼다).
ALTER TABLE events
  ADD CONSTRAINT events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id),
  ADD CONSTRAINT events_actor_agent_id_fkey FOREIGN KEY (actor_agent_id) REFERENCES agents(id);

-- Down Migration
ALTER TABLE events
  DROP CONSTRAINT events_actor_agent_id_fkey,
  DROP CONSTRAINT events_project_id_fkey;

DROP TABLE task_deps;
DROP TABLE tasks;
DROP TABLE plans;
DROP TABLE specs;
DROP TABLE project_members;
DROP TABLE project_repos;
DROP TABLE projects;
