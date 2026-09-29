import type { Queryable } from '../config/db.js';

// Swagger UI의 example에 채워 넣을 실제 id들. 시드를 다시 돌리면 값이 바뀌므로
// 파일에 고정하지 않고 /docs/openapi.json을 서빙할 때마다 읽는다.
export type ExampleIds = {
  ORG_ID: string | null;
  PROJECT_ID: string | null;
  REPO_API: string | null;
  PATH_ID: string | null;
  TASK_BE: string | null;
  POLICY_HASH: string | null;
  AGENT_BE: string | null;
  INVITE_TOKEN: string | null;
};

// 한 번의 왕복으로 끝낸다. 시드가 만드는 상태를 기준으로 고르고,
// 없으면 NULL을 돌려준다 (호출부가 자리표를 그대로 남긴다).
//
// 태스크는 READY를 먼저 고른다 — 수동 테스트 중에 CLAIM해 버렸어도 example이 비지 않게
// 같은 역할의 아무 태스크로 내려간다.
const SQL = `
WITH org AS (SELECT id FROM organizations ORDER BY created_at LIMIT 1),
     proj AS (
       SELECT p.id FROM projects p JOIN org ON org.id = p.org_id
        WHERE p.status <> 'aborted' ORDER BY p.created_at DESC LIMIT 1
     ),
     task AS (
       SELECT t.id, t.repo_id FROM tasks t JOIN proj ON proj.id = t.project_id
        WHERE t.team_role = 'BACKEND'
        ORDER BY (t.state = 'READY') DESC, t.created_at
        LIMIT 1
     ),
     repo AS (
       SELECT coalesce((SELECT repo_id FROM task),
                       (SELECT pr.repo_id FROM project_repos pr JOIN proj ON proj.id = pr.project_id LIMIT 1)) AS id
     ),
     path AS (
       SELECT p.id FROM repo_paths p JOIN repo ON repo.id = p.repo_id
        WHERE p.path_pattern = 'tests/**' LIMIT 1
     ),
     agent AS (
       SELECT m.agent_id FROM project_members m JOIN proj ON proj.id = m.project_id
        ORDER BY (m.team_role = 'BACKEND') DESC LIMIT 1
     ),
     invite AS (
       SELECT i.token FROM invites i JOIN org ON org.id = i.org_id
        WHERE i.used_by IS NULL AND i.expires_at > now()
        ORDER BY i.created_at DESC LIMIT 1
     )
SELECT (SELECT id FROM org)::text       AS org_id,
       (SELECT id FROM proj)::text      AS project_id,
       (SELECT id FROM repo)::text      AS repo_api,
       (SELECT id FROM path)::text      AS path_id,
       (SELECT id FROM task)::text      AS task_be,
       (SELECT policy_hash FROM projects WHERE id = (SELECT id FROM proj)) AS policy_hash,
       (SELECT agent_id FROM agent)::text AS agent_be,
       (SELECT token FROM invite)       AS invite_token`;

export async function findExampleIds(db: Queryable): Promise<ExampleIds> {
  const { rows } = await db.query(SQL);
  const row = rows[0] ?? {};
  return {
    ORG_ID: row.org_id ?? null,
    PROJECT_ID: row.project_id ?? null,
    REPO_API: row.repo_api ?? null,
    PATH_ID: row.path_id ?? null,
    TASK_BE: row.task_be ?? null,
    POLICY_HASH: row.policy_hash ?? null,
    AGENT_BE: row.agent_be ?? null,
    INVITE_TOKEN: row.invite_token ?? null,
  };
}
