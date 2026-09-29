-- Up Migration
-- 불변식 agents.org_id = users.org_id를 DB가 강제한다.
-- 지금까지는 코드(assignAgentsToOrg·upsertAgent)만 지키고 있었고, 테스트 픽스처가 이를 어겨도
-- 아무도 막지 않았다. 틀린 픽스처는 이제 INSERT에서 죽는다.
--
-- (user_id, org_id) 복합 FK를 그냥 걸면 구멍이 남는다: org_id가 NULL이면 MATCH SIMPLE이
-- 검사를 통째로 건너뛰므로, "조직이 있는 사용자의 조직 없는 에이전트"가 그대로 통과한다.
-- 그게 정확히 이번에 발견된 픽스처 버그의 모양이다.
-- 007의 lock_key와 같은 방식으로 NULL을 '-'로 접어 항상 검사되게 만든다.
ALTER TABLE users
  ADD COLUMN org_key text GENERATED ALWAYS AS (coalesce(org_id::text, '-')) STORED;

-- FK가 참조할 대상. id가 PK라 (id, org_key)는 사실상 id 하나로 유일하지만,
-- FK를 걸려면 참조 열 조합에 유니크 제약이 있어야 한다.
CREATE UNIQUE INDEX uq_users_id_org_key ON users(id, org_key);

ALTER TABLE agents
  ADD COLUMN org_key text GENERATED ALWAYS AS (coalesce(org_id::text, '-')) STORED;

-- DEFERRABLE INITIALLY DEFERRED인 이유: 조직 가입은 users.org_id를 채우고 이어서
-- agents.org_id를 채우는 두 문장이다. 즉시 검사하면 첫 문장에서 기존 에이전트 행이
-- 사라진 옛 키를 참조하게 되어 실패한다. 커밋 시점에 검사하면 둘 다 끝난 뒤를 본다.
-- (organizations.created_by가 같은 이유로 DEFERRABLE인 선례가 있다.)
ALTER TABLE agents
  ADD CONSTRAINT agents_user_org_fk FOREIGN KEY (user_id, org_key)
    REFERENCES users(id, org_key) DEFERRABLE INITIALLY DEFERRED;

-- Down Migration
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_user_org_fk;
ALTER TABLE agents DROP COLUMN IF EXISTS org_key;
DROP INDEX IF EXISTS uq_users_id_org_key;
ALTER TABLE users DROP COLUMN IF EXISTS org_key;
