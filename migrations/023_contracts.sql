-- Up Migration

-- 새 계획 흐름 2단계 — API 계약(대표 결정 2026-10-15).
-- API가 필요한 기능(specs.needs_api)마다 계약 하나. BE 노트북의 에이전트가 BE 코드를 읽고 초안(OpenAPI 조각 + 사람이 읽는 요약)을 쓰고,
-- BE 개발자가 확정하거나 고쳐 달라고 한다. 확정된 계약은 FE·BE 태스크 브리핑에 들어가고 나중에 V1A(계약 대조)가 이걸로 대조한다.
--
--   status   pending(작성 대기 — BE 노트북이 가져가 쓴다) → draft(초안, BE 개발자 확인 대기) → approved(확정, 잠김)
--            수정 요청이면 draft → pending(attempt+1). 노트북이 두 번 다 형식을 못 맞추면 failed — 다시 요청하면 pending.
--   schema_yaml  OpenAPI 조각(paths·components). 서버가 형식을 검사한 뒤에만 들어간다(domain/contract/validate.ts).
--   기능 명세 하나에 계약 하나(uq_contracts_spec) — 고친 이력은 events(CONTRACT_*)에 남는다.

CREATE TABLE contracts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id),
  spec_id          uuid NOT NULL REFERENCES specs(id),
  status           text NOT NULL DEFAULT 'pending',
  attempt          integer NOT NULL DEFAULT 1,
  feedback         text,
  schema_yaml      text,
  summary          text,
  open_questions   jsonb NOT NULL DEFAULT '[]',
  drafted_by_agent uuid REFERENCES agents(id),
  drafted_at       timestamptz,
  approved_by      uuid REFERENCES users(id),
  approved_at      timestamptz,
  error_reason     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contracts_status_chk CHECK (status IN ('pending', 'draft', 'approved', 'failed')),
  CONSTRAINT contracts_draft_chk CHECK (status NOT IN ('draft', 'approved') OR (schema_yaml IS NOT NULL AND summary IS NOT NULL)),
  CONSTRAINT contracts_approved_chk CHECK ((status = 'approved') = (approved_at IS NOT NULL AND approved_by IS NOT NULL)),
  CONSTRAINT contracts_failed_chk CHECK ((status = 'failed') = (error_reason IS NOT NULL)),
  CONSTRAINT contracts_attempt_chk CHECK (attempt >= 1)
);
CREATE UNIQUE INDEX uq_contracts_spec ON contracts(spec_id);
CREATE INDEX idx_contracts_project ON contracts(project_id, status);

-- 006에서 컬럼만 만들어 둔 tasks.contract_id에 외래 키를 붙인다(이제 contracts가 있다).
ALTER TABLE tasks ADD CONSTRAINT tasks_contract_fk FOREIGN KEY (contract_id) REFERENCES contracts(id);

-- Down Migration

ALTER TABLE tasks DROP CONSTRAINT tasks_contract_fk;
DROP TABLE contracts;
