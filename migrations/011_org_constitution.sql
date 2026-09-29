-- Up Migration
-- organizations.constitution — ERD에는 001부터 있었지만 실제 테이블에는 없던 컬럼이다.
-- 프로젝트 생성이 이 값을 스냅샷으로 복사해야 해서 이제 필요해졌다.
--
-- 조직의 최신본이고, 프로젝트는 생성 시점 사본(projects.constitution)을 따로 들고 간다.
-- 그래야 조직 헌법이 나중에 바뀌어도 과거 판정의 근거를 복원할 수 있다.
ALTER TABLE organizations
  ADD COLUMN constitution jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Down Migration
ALTER TABLE organizations DROP COLUMN IF EXISTS constitution;
