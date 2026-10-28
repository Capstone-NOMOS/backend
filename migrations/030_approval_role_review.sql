-- Up Migration

-- ACTION 승인을 두 단계로 나눈다(대표 결정 2026-10-28). 역할 담당(그 역할의 사람)이 먼저 보고(role_review), 통과하면 대표가 최종 승인한다(final).
-- 대표는 개발자가 아니라 diff·마이그레이션을 판단하기 어렵고, 역할 담당은 자기 에이전트가 만든 것을 가장 잘 안다 —
-- 그래도 최종 결정은 대표에게 남긴다(1차 검토만으로 DONE이 되지 않는다).
--   stage            role_review | final. 기존 카드와 G1·G2·G3는 전부 final(대표가 결정 — 지금까지와 같다).
--   reviewer_user_id role_review 카드를 볼 역할 담당(project_members.user_id의 그 순간 값). final은 NULL(대표가 본다).
-- 대기 카드는 여전히 태스크당 하나다(uq_approvals_pending_subject) — 1차 승인은 role_review 카드를 닫고 같은 트랜잭션에서 final 카드를 새로 만든다.

ALTER TABLE approvals ADD COLUMN stage text NOT NULL DEFAULT 'final';
ALTER TABLE approvals ADD COLUMN reviewer_user_id uuid REFERENCES users(id);

ALTER TABLE approvals ADD CONSTRAINT approvals_stage_chk CHECK (stage IN ('role_review', 'final'));
-- role_review ⇔ 검토자가 있다. final에는 검토자가 없다(대표가 본다).
ALTER TABLE approvals ADD CONSTRAINT approvals_reviewer_chk CHECK ((stage = 'role_review') = (reviewer_user_id IS NOT NULL));
-- 1차 검토는 ACTION에만 있다. G1·G2·G3는 대표만 결정한다.
ALTER TABLE approvals ADD CONSTRAINT approvals_role_review_gate_chk CHECK (stage = 'final' OR gate = 'ACTION');

-- 팀원의 "검토 요청"(GET /me/approvals).
CREATE INDEX idx_approvals_pending_reviewer ON approvals (reviewer_user_id) WHERE decision IS NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_approvals_pending_reviewer;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_role_review_gate_chk;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_reviewer_chk;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_stage_chk;
ALTER TABLE approvals DROP COLUMN IF EXISTS reviewer_user_id;
ALTER TABLE approvals DROP COLUMN IF EXISTS stage;
