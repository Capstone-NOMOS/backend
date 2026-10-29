import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';

// 받은 편지함의 알림(031). SQL만 둔다. 알림은 따로 쌓지 않고 events에서 계산한다 — 정본은 events다(P5).

// 알림이 되는 이벤트 타입. 마이그레이션 031의 부분 인덱스(idx_events_notifications)와 같아야 한다.
export const NOTIFICATION_EVENT_TYPES = [
  'APPROVAL_RESULT',
  'VERIFICATION_COMPLETED',
  'TASK_COMPLETED_MANUALLY',
  'QUESTION_ANSWERED',
  'QUESTION_DRAFTED',
  'QUESTION_ASKED',
] as const;

// 최근 이만큼만 본다. events는 지워지지 않아 계속 자라는데, 받은 편지함은 "최근에 일어난 일"이다 —
// 상한이 없으면 오래 쓴 조직일수록 매번 전 기간을 훑고, 몇 달 전 알림이 안 읽음으로 남아 숫자가 의미를 잃는다.
export const NOTIFICATION_WINDOW_DAYS = 30;

export type NotificationRow = {
  eventId: string;
  type: string;
  ts: string;
  projectId: string;
  projectName: string;
  payload: Record<string, unknown>;
  taskId: string | null;
  taskTitle: string | null;
  role: string | null;
  questionId: string | null;
  askerRole: string | null;
  targetRole: string | null;
  questions: { question: string }[] | null;
  answers: Record<string, string> | null;
  actorNickname: string | null;
  actorIsRepresentative: boolean;
};

// 이벤트 하나가 알림이 되는 조건과 "관련 역할"(받는 사람을 정하는 역할).
//   task_done          — 태스크가 DONE이 된 순간: 최종 승인(1차 검토 승인은 taskState가 AWAITING_APPROVAL이라 빠진다)·검증만으로 완료·직접 완료. 역할 = 태스크 역할.
//   question_answered  — 사람의 답, 또는 상담 초안이 그대로 답이 된 경우(QUESTION_DRAFTED.autoAnswered). 역할 = 질문한 쪽(asker).
//   question_asked     — 대상 역할(PM이면 담당이 없어 대표만). SELF(자기 소관으로 돌려보냄)는 묻는 쪽이 계속 하므로 빠진다.
// 대표는 조직의 모든 프로젝트 알림을, 팀원은 지금 그 역할 담당(project_members.user_id)인 것만 받는다. 한 이벤트는 한 줄이라 대표이면서 담당이어도 한 번이다.
const BASE = `
  WITH n AS (
    SELECT e.id, e.type, e.ts, e.project_id, e.payload, e.on_behalf_of,
           p.name AS project_name,
           t.id AS task_id, t.title AS task_title,
           q.id AS question_id, q.asker_role, q.target_role, q.questions, q.answers,
           CASE
             WHEN e.type IN ('QUESTION_ANSWERED', 'QUESTION_DRAFTED') THEN q.asker_role
             WHEN e.type = 'QUESTION_ASKED' THEN e.payload->>'targetRole'
             ELSE t.team_role
           END AS role
      FROM events e
      JOIN projects p ON p.id = e.project_id
      LEFT JOIN tasks t ON t.id = (e.payload->>'taskId')::uuid
      LEFT JOIN agent_questions q ON e.type IN ('QUESTION_ANSWERED', 'QUESTION_DRAFTED', 'QUESTION_ASKED')
                                 AND q.id = (e.payload->>'questionId')::uuid
     WHERE e.org_id = $1
       AND e.type = ANY($4::text[])
       AND e.ts >= now() - make_interval(days => $5)
       AND p.deleted_at IS NULL
       AND (   (e.type = 'APPROVAL_RESULT' AND e.payload->>'decision' = 'APPROVE' AND e.payload->>'taskState' = 'DONE')
            OR (e.type = 'VERIFICATION_COMPLETED' AND e.payload->>'taskState' = 'DONE')
            OR e.type = 'TASK_COMPLETED_MANUALLY'
            OR e.type = 'QUESTION_ANSWERED'
            OR (e.type = 'QUESTION_DRAFTED' AND e.payload->>'autoAnswered' = 'true')
            OR (e.type = 'QUESTION_ASKED' AND e.payload->>'targetRole' <> 'SELF'))
  ),
  mine AS (
    SELECT n.* FROM n
     WHERE $2 OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = n.project_id AND m.user_id = $3 AND m.team_role = n.role)
  )`;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function toNotificationRow(r: QueryResultRow): NotificationRow {
  return {
    eventId: String(r.id),
    type: r.type as string,
    ts: iso(r.ts),
    projectId: r.project_id as string,
    projectName: r.project_name as string,
    payload: r.payload as Record<string, unknown>,
    taskId: (r.task_id as string | null) ?? null,
    taskTitle: (r.task_title as string | null) ?? null,
    role: (r.role as string | null) ?? null,
    questionId: (r.question_id as string | null) ?? null,
    askerRole: (r.asker_role as string | null) ?? null,
    targetRole: (r.target_role as string | null) ?? null,
    questions: (r.questions as { question: string }[] | null) ?? null,
    answers: (r.answers as Record<string, string> | null) ?? null,
    actorNickname: (r.actor_nickname as string | null) ?? null,
    actorIsRepresentative: r.actor_is_rep === true,
  };
}

type Recipient = { orgId: string; userId: string; isRepresentative: boolean };

function baseParams(who: Recipient): unknown[] {
  return [who.orgId, who.isRepresentative, who.userId, [...NOTIFICATION_EVENT_TYPES], NOTIFICATION_WINDOW_DAYS];
}

// 최신순. before(이벤트 id)보다 앞의 것만 — "더 보기".
export async function listNotificationRows(db: Queryable, who: Recipient, input: { before: string | null; limit: number }): Promise<NotificationRow[]> {
  const { rows } = await db.query(
    `${BASE}
     SELECT mine.*, u.nickname AS actor_nickname, (u.org_role = 'REPRESENTATIVE') AS actor_is_rep
       FROM mine LEFT JOIN users u ON u.id::text = mine.on_behalf_of
      WHERE ($6::bigint IS NULL OR mine.id < $6)
      ORDER BY mine.id DESC
      LIMIT $7`,
    [...baseParams(who), input.before, input.limit],
  );
  return rows.map(toNotificationRow);
}

// 커서 이후 내 알림 수(같은 30일 창 안에서).
export async function countUnreadNotifications(db: Queryable, who: Recipient, readUpTo: string | null): Promise<number> {
  const { rows } = await db.query(`${BASE} SELECT count(*)::int AS n FROM mine WHERE ($6::bigint IS NULL OR mine.id > $6)`, [
    ...baseParams(who),
    readUpTo,
  ]);
  return rows[0]!.n as number;
}

export async function findReadCursor(db: Queryable, userId: string): Promise<string | null> {
  const { rows } = await db.query(`SELECT notifications_read_event_id FROM users WHERE id = $1`, [userId]);
  const v = rows[0]?.notifications_read_event_id as string | number | null | undefined;
  return v === null || v === undefined ? null : String(v);
}

// 커서는 앞으로만 간다 — 더 작은 값이면 그대로 둔다. upTo가 null이면 지금 가장 최근 이벤트까지.
export async function advanceReadCursor(db: Queryable, userId: string, upTo: string | null): Promise<string | null> {
  const { rows } = await db.query(
    `UPDATE users
        SET notifications_read_event_id = GREATEST(COALESCE(notifications_read_event_id, 0),
                                                   COALESCE($2::bigint, (SELECT COALESCE(max(id), 0) FROM events)))
      WHERE id = $1
      RETURNING notifications_read_event_id`,
    [userId, upTo],
  );
  const v = rows[0]?.notifications_read_event_id as string | number | null | undefined;
  return v === null || v === undefined ? null : String(v);
}
