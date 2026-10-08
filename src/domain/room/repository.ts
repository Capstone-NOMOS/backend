import type { Queryable } from '../../config/db.js';
import type { TeamRole } from '../roles.js';

// ── 배정 기록(task_dispatches) ───────────────────────────────────────────

export type DispatchedTask = { taskId: string; title: string; teamRole: TeamRole | null; attempt: number; orgId: string };

// 지금 가져갈 수 있는 태스크(시작한 프로젝트·READY·담당 없음·선행 전부 DONE)를 attempt(=retry_count)별로 한 번만 기록한다.
// 조건은 task/repository.ts의 listClaimableTasks에서 역할 조건만 뺀 것이다 — 둘이 갈리면 "실행해 주세요"가 왔는데 못 가져가는 일이 생긴다.
// 이미 기록된 (task, attempt)는 PK 충돌로 건너뛰고, 새로 들어간 행만 돌려준다(그 행에만 이벤트를 남긴다).
export async function insertNewDispatches(db: Queryable, projectId: string): Promise<DispatchedTask[]> {
  const { rows } = await db.query(
    `WITH ready AS (
       SELECT t.id, t.retry_count FROM tasks t
         JOIN projects p ON p.id = t.project_id
        WHERE t.project_id = $1
          AND p.started_at IS NOT NULL
          AND t.state = 'READY'
          AND t.assignee_agent_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on
             WHERE d.task_id = t.id AND dt.state <> 'DONE')
     ), inserted AS (
       INSERT INTO task_dispatches (task_id, attempt)
       SELECT id, retry_count FROM ready
       ON CONFLICT DO NOTHING
       RETURNING task_id, attempt
     )
     SELECT i.task_id, i.attempt, t.title, t.team_role, p.org_id
       FROM inserted i JOIN tasks t ON t.id = i.task_id JOIN projects p ON p.id = t.project_id
      ORDER BY t.created_at, t.id`,
    [projectId],
  );
  return rows.map((r) => ({
    taskId: r.task_id as string,
    title: r.title as string,
    teamRole: (r.team_role as TeamRole | null) ?? null,
    attempt: Number(r.attempt),
    orgId: r.org_id as string,
  }));
}

// ── 실행(run) ─────────────────────────────────────────────────────────────

// 이 에이전트가 이 태스크에서 시작하고 아직 끝내지 않은 실행 — 마지막 실행 이벤트가 STARTED면 그 attempt, 아니면 null.
export async function findOpenRun(db: Queryable, taskId: string, agentId: string): Promise<{ attempt: number } | null> {
  const { rows } = await db.query(
    `SELECT type, payload->>'attempt' AS attempt FROM events
      WHERE type IN ('AGENT_RUN_STARTED', 'AGENT_RUN_ENDED')
        AND actor_agent_id = $2 AND payload->>'taskId' = $1
      ORDER BY id DESC LIMIT 1`,
    [taskId, agentId],
  );
  return rows[0]?.type === 'AGENT_RUN_STARTED' ? { attempt: Number(rows[0].attempt) } : null;
}

// ── 활동(agent_activity) ─────────────────────────────────────────────────

export type ActivityKind = 'read' | 'edit' | 'write' | 'run' | 'search' | 'other';
export const ACTIVITY_KINDS: readonly ActivityKind[] = ['read', 'edit', 'write', 'run', 'search', 'other'];

export async function insertActivity(
  db: Queryable,
  input: { projectId: string; taskId: string; agentId: string; items: { kind: ActivityKind; target: string }[] },
): Promise<void> {
  // 한 묶음은 한 문장으로 넣는다 — id(bigserial) 순서가 보낸 순서와 같다.
  await db.query(
    `INSERT INTO agent_activity (project_id, task_id, agent_id, kind, target)
     SELECT $1, $2, $3, k, t FROM unnest($4::text[], $5::text[]) WITH ORDINALITY AS x(k, t, n) ORDER BY n`,
    [input.projectId, input.taskId, input.agentId, input.items.map((i) => i.kind), input.items.map((i) => i.target)],
  );
}

// ── 룸 피드 ──────────────────────────────────────────────────────────────

// 룸에 보이는 이벤트. 태스크에 딸린 것은 그 태스크의 역할 룸에만(역할 제한 없는 태스크는 모든 룸), 프로젝트 단위는 모든 룸에.
export const TASK_FEED_EVENTS = [
  'TASK_DISPATCHED',
  'TASK_CLAIMED',
  'AGENT_RUN_STARTED',
  'AGENT_RUN_ENDED',
  'ARTIFACT_SUBMITTED',
  'VERIFICATION_COMPLETED',
  // APPROVAL_REQUESTED는 넣지 않는다 — 같은 트랜잭션의 검증 결과 줄이 이미 "대표 승인을 기다립니다"라고 말한다(겹쳐 보였다).
  'APPROVAL_RESULT',
  'NOTE_PUBLISHED',
] as const;
export const PROJECT_FEED_EVENTS = ['PROJECT_STARTED', 'PLAN_APPLIED'] as const;

export type FeedRow = {
  source: 'e' | 'a';
  id: string;
  tsMicros: string;
  ts: string;
  type: string;
  payload: Record<string, unknown>;
  taskId: string | null;
  taskTitle: string | null;
  changedPathCount: number | null;
};

// 이벤트와 활동을 시각순으로 섞어 최신부터 읽는다. 커서는 (시각 마이크로초, 출처, id) — 시각만으로는 같은 트랜잭션·같은 묶음에서 겹친다.
// 시각을 JS Date로 옮기면 마이크로초가 잘려 커서 경계에서 행이 빠지므로 정수로 비교한다.
export async function listRoomFeed(
  db: Queryable,
  projectId: string,
  teamRole: TeamRole,
  query: { before?: { tsMicros: string; source: 'e' | 'a'; id: string }; limit: number },
): Promise<FeedRow[]> {
  const before = query.before ?? null;
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT 'e'::text AS source, e.id::text AS id, (extract(epoch FROM e.ts) * 1000000)::bigint AS ts_us, e.ts,
              e.type, e.payload, t.id AS task_id, t.title AS task_title,
              cardinality(ar.changed_paths) AS changed_path_count
         FROM events e
         LEFT JOIN tasks t ON t.id = (e.payload->>'taskId')::uuid
         LEFT JOIN artifacts ar ON e.type = 'ARTIFACT_SUBMITTED' AND ar.id = (e.payload->>'artifactId')::uuid
        WHERE e.project_id = $1
          AND (
            (e.type = ANY($3::text[]) AND t.id IS NOT NULL AND (t.team_role IS NULL OR t.team_role = $2))
            OR e.type = ANY($4::text[])
          )
       UNION ALL
       SELECT 'a'::text, a.id::text, (extract(epoch FROM a.ts) * 1000000)::bigint, a.ts,
              a.kind, jsonb_build_object('target', a.target), t.id, t.title, NULL::int
         FROM agent_activity a
         JOIN tasks t ON t.id = a.task_id
        WHERE a.project_id = $1 AND (t.team_role IS NULL OR t.team_role = $2)
     ) feed
     WHERE $5::bigint IS NULL OR (ts_us, source, id::bigint) < ($5::bigint, $6::text, $7::bigint)
     ORDER BY ts_us DESC, source DESC, id::bigint DESC
     LIMIT $8`,
    [
      projectId,
      teamRole,
      [...TASK_FEED_EVENTS],
      [...PROJECT_FEED_EVENTS],
      before?.tsMicros ?? null,
      before?.source ?? null,
      before?.id ?? null,
      query.limit,
    ],
  );
  return rows.map((r) => ({
    source: r.source as 'e' | 'a',
    id: r.id as string,
    tsMicros: String(r.ts_us),
    ts: (r.ts as Date).toISOString(),
    type: r.type as string,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    taskId: (r.task_id as string | null) ?? null,
    taskTitle: (r.task_title as string | null) ?? null,
    changedPathCount: r.changed_path_count === null || r.changed_path_count === undefined ? null : Number(r.changed_path_count),
  }));
}

// ── 룸 목록 ──────────────────────────────────────────────────────────────

export type RoomTask = { id: string; title: string; state: string; teamRole: TeamRole | null };

// 그 역할의 진행 중 태스크(담당이 있는 것). 화면 머리의 "지금 하는 일".
export async function listActiveRoleTasks(db: Queryable, projectId: string, teamRole: TeamRole): Promise<RoomTask[]> {
  const { rows } = await db.query(
    `SELECT id, title, state, team_role FROM tasks
      WHERE project_id = $1 AND (team_role IS NULL OR team_role = $2)
        AND state IN ('CLAIMED', 'IN_PROGRESS', 'VERIFYING', 'AWAITING_APPROVAL')
      ORDER BY updated_at DESC, id`,
    [projectId, teamRole],
  );
  return rows.map((r) => ({ id: r.id as string, title: r.title as string, state: r.state as string, teamRole: (r.team_role as TeamRole | null) ?? null }));
}
