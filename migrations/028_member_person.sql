-- Up Migration

-- 프로젝트 역할 담당은 **사람**이다(대표 결정 2026-10-25, FE 요청 A). 에이전트는 그 사람이 역할에 붙이는 도구다.
-- 지금까지는 "사람의 소속 = 에이전트 배정"이라, 에이전트 연결을 해제하면 사람도 프로젝트에서 빠져 질문 답·계약 확정·기록 보기를 못 했고
-- 다시 연결해도 대표가 다시 배정해야 했다.
--   - user_id   역할 담당(사람). 가시성·답할 자격·계약 확정은 이 칸으로 판정한다.
--   - agent_id  그 사람이 붙인 에이전트. 연결 해제하면 NULL("에이전트 연결 필요")이고, 같은 사람이 다시 연결하면 다시 붙는다.
--   - 에이전트의 주인은 반드시 그 역할 담당이다(복합 FK).

ALTER TABLE project_members ADD COLUMN user_id uuid REFERENCES users(id);
UPDATE project_members m SET user_id = a.user_id FROM agents a WHERE a.id = m.agent_id;
ALTER TABLE project_members ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE project_members DROP CONSTRAINT project_members_pkey;
ALTER TABLE project_members ALTER COLUMN agent_id DROP NOT NULL;
-- 역할당 담당 하나(uq_project_members_role, 그대로), 한 에이전트는 한 역할에만.
CREATE UNIQUE INDEX uq_project_members_agent ON project_members (project_id, agent_id) WHERE agent_id IS NOT NULL;

CREATE UNIQUE INDEX uq_agents_id_user ON agents (id, user_id);
ALTER TABLE project_members ADD CONSTRAINT project_members_agent_owner_fk
  FOREIGN KEY (agent_id, user_id) REFERENCES agents (id, user_id);

CREATE INDEX idx_project_members_user ON project_members (user_id);

-- 에이전트만 주고 넣으면 그 주인을 담당으로 채운다(에이전트 배정으로 담당이 생기는 기존 경로·픽스처). 둘 다 주면 FK가 짝을 본다.
CREATE FUNCTION project_members_fill_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS NULL AND NEW.agent_id IS NOT NULL THEN
    SELECT user_id INTO NEW.user_id FROM agents WHERE id = NEW.agent_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_members_fill_user BEFORE INSERT ON project_members
  FOR EACH ROW EXECUTE FUNCTION project_members_fill_user();

-- Down Migration

DROP TRIGGER IF EXISTS project_members_fill_user ON project_members;
DROP FUNCTION IF EXISTS project_members_fill_user();

DELETE FROM project_members WHERE agent_id IS NULL;
DROP INDEX IF EXISTS idx_project_members_user;
ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_agent_owner_fk;
DROP INDEX IF EXISTS uq_agents_id_user;
DROP INDEX IF EXISTS uq_project_members_agent;
ALTER TABLE project_members ALTER COLUMN agent_id SET NOT NULL;
ALTER TABLE project_members ADD PRIMARY KEY (project_id, agent_id);
ALTER TABLE project_members DROP COLUMN user_id;
