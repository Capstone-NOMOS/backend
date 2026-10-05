import { pool, withTransaction, type Queryable } from '../../config/db.js';
import { assertProjectVisibleToUser, type UserContext } from '../project/visibility.js';

// 프로젝트 이벤트 로그 조회(활동 화면·대시보드 최근 활동). events는 유일한 진실(P5)이라 따로 요약 테이블을 두지 않고 그대로 읽는다.
// 쓰기는 append.ts 한 곳뿐이고 여기는 읽기만 한다. payload에는 비밀값이 없다(쓰는 쪽 규칙) — 그래서 그대로 내보낸다.
//
// 최신순, id 커서(before)로 페이지를 넘긴다. 시각(ts)이 아니라 id로 넘기는 이유: 같은 트랜잭션의 이벤트는 ts가 같을 수 있어
// 시각 커서는 경계에서 빠지거나 겹친다. id는 bigserial이라 유일하고 단조 증가한다.
// 비용(token_cost)은 행의 값을 그대로 싣는다 — 태스크별·사람별 집계는 따로 다룬다(에이전트 실행 비용은 아직 수집하지 않는다).

export type EventView = {
  id: string;
  type: string;
  ts: string;
  onBehalfOf: string;
  actorAgentId: string | null;
  payload: unknown;
  tokenCost: number | null;
  pathViolation: boolean | null;
};

export type EventQuery = { before?: string; limit: number; types?: string[] };

async function listProjectEvents(db: Queryable, projectId: string, query: EventQuery): Promise<EventView[]> {
  const { rows } = await db.query(
    `SELECT id::text AS id, type, ts, on_behalf_of, actor_agent_id, payload, token_cost::float8 AS token_cost, path_violation
       FROM events
      WHERE project_id = $1
        AND ($2::bigint IS NULL OR id < $2::bigint)
        AND ($3::text[] IS NULL OR type = ANY($3::text[]))
      ORDER BY id DESC
      LIMIT $4`,
    [projectId, query.before ?? null, query.types && query.types.length > 0 ? query.types : null, query.limit],
  );
  return rows.map((r) => ({
    id: r.id as string,
    type: r.type as string,
    ts: (r.ts as Date).toISOString(),
    onBehalfOf: r.on_behalf_of as string,
    actorAgentId: (r.actor_agent_id as string | null) ?? null,
    payload: r.payload,
    tokenCost: (r.token_cost as number | null) ?? null,
    pathViolation: (r.path_violation as boolean | null) ?? null,
  }));
}

// 볼 수 있는 범위는 태스크·노트와 같다(assertProjectVisibleToUser) — 대표는 전부, 팀원은 자기 에이전트가 배정된 프로젝트.
export async function listProjectEventsForUser(
  actor: UserContext,
  projectId: string,
  query: EventQuery,
): Promise<{ events: EventView[]; nextBefore: string | null }> {
  await withTransaction((tx) => assertProjectVisibleToUser(tx, actor, projectId));
  const events = await listProjectEvents(pool, projectId, query);
  // 한 페이지를 꽉 채웠으면 더 있을 수 있다 — 마지막(가장 오래된) id가 다음 커서다.
  const nextBefore = events.length === query.limit ? events[events.length - 1]!.id : null;
  return { events, nextBefore };
}
