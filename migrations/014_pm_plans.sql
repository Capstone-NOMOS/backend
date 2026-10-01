-- Up Migration
-- 내장 PM의 계획 초안. 006의 plans를 넓힌다 — 대표의 지시 → PM 초안(pending → ready|failed) → 대표가 적용(applied).
-- PM 호출은 수십 초~수 분이라 비동기로 돈다. 상태는 서버가 소유하고(P1) 클라이언트는 폴링한다.

-- 초안이 나오기 전(pending)과 실패(failed)에는 초안이 없다.
ALTER TABLE plans
  ALTER COLUMN dag_snapshot DROP NOT NULL,
  ALTER COLUMN dag_hash DROP NOT NULL,
  -- 기존 행은 없다(006 이후 plans를 만드는 코드가 없었다). 기본값은 새 행용이다.
  ADD COLUMN status        text NOT NULL DEFAULT 'pending',
  ADD COLUMN instruction   text,
  ADD COLUMN feedback      text,
  ADD COLUMN parent_plan_id uuid REFERENCES plans(id),
  -- 수정 체인의 맨 처음 계획. 한 체인에서 하나만 적용되도록 유일 인덱스를 건다(옛 초안 적용 방지).
  ADD COLUMN root_plan_id  uuid REFERENCES plans(id),
  ADD COLUMN requested_by  uuid REFERENCES users(id),
  -- 실패 사유는 상태에 섞지 않고 여기 둔다. 상태를 검사하는 코드가 단순해진다.
  ADD COLUMN error_reason  text,
  ADD COLUMN error_detail  jsonb,
  -- 진행 중인 PM 호출의 최대 비용(호출 직전에 기록, 끝나면 비운다). 재시작·시간 제한으로 끊긴 호출은
  -- 실제 사용량을 알 수 없으므로 이 값을 쓴 것으로 정산한다 — 예산 검사가 느슨해지지 않게.
  ADD COLUMN inflight_max_cost_usd numeric(10,6),
  -- M6a용 구조(명세 키·태스크의 레포·역할·종류·선행 관계를 정렬한 것). dag_hash는 이것의 해시다.
  ADD COLUMN structure     jsonb,
  -- 적용 시각. approved_at은 "G1 승인 = 잠김"이라 G1이 생길 때까지 비워 둔다 — 적용은 G1이 아니다.
  ADD COLUMN applied_at    timestamptz,
  ADD CONSTRAINT plans_status_chk CHECK (status IN ('pending', 'ready', 'failed', 'applied')),
  ADD CONSTRAINT plans_error_chk CHECK ((status = 'failed') = (error_reason IS NOT NULL)),
  ADD CONSTRAINT plans_error_reason_chk CHECK (error_reason IS NULL OR error_reason IN
    ('refused', 'truncated', 'timeout', 'invalid', 'restart', 'budget', 'api_error')),
  -- 초안이 있어야 검토·적용할 수 있다.
  ADD CONSTRAINT plans_draft_chk CHECK (status NOT IN ('ready', 'applied') OR (dag_snapshot IS NOT NULL AND dag_hash IS NOT NULL)),
  ADD CONSTRAINT plans_applied_chk CHECK ((status = 'applied') = (applied_at IS NOT NULL));

-- 프로젝트당 진행 중인 요청은 하나. 서비스가 프로젝트 행을 잠그고 확인하지만, 마지막 방어선은 DB다.
CREATE UNIQUE INDEX uq_plans_pending ON plans(project_id) WHERE status = 'pending';
-- 한 수정 체인에서 적용은 한 번. 두 번 누르기·옛 초안 적용을 DB가 막는다.
CREATE UNIQUE INDEX uq_plans_applied_root ON plans(root_plan_id) WHERE status = 'applied';

-- Down Migration
DROP INDEX IF EXISTS uq_plans_applied_root;
DROP INDEX IF EXISTS uq_plans_pending;
ALTER TABLE plans
  DROP CONSTRAINT IF EXISTS plans_applied_chk,
  DROP CONSTRAINT IF EXISTS plans_draft_chk,
  DROP CONSTRAINT IF EXISTS plans_error_reason_chk,
  DROP CONSTRAINT IF EXISTS plans_error_chk,
  DROP CONSTRAINT IF EXISTS plans_status_chk,
  DROP COLUMN IF EXISTS applied_at,
  DROP COLUMN IF EXISTS structure,
  DROP COLUMN IF EXISTS inflight_max_cost_usd,
  DROP COLUMN IF EXISTS error_detail,
  DROP COLUMN IF EXISTS error_reason,
  DROP COLUMN IF EXISTS requested_by,
  DROP COLUMN IF EXISTS root_plan_id,
  DROP COLUMN IF EXISTS parent_plan_id,
  DROP COLUMN IF EXISTS feedback,
  DROP COLUMN IF EXISTS instruction,
  DROP COLUMN IF EXISTS status;
ALTER TABLE plans
  ALTER COLUMN dag_hash SET NOT NULL,
  ALTER COLUMN dag_snapshot SET NOT NULL;
