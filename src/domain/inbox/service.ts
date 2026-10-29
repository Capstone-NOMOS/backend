import { pool } from '../../config/db.js';
import { listApprovals, type ApprovalView } from '../approval/repository.js';
import { findBackendOwners, listContractsForProjects } from '../contract/repository.js';
import { contractApproverRole } from '../contract/service.js';
import { listLatestPlansByKind } from '../pm/repository.js';
import { listAgentlessRolesOfUser, listProjectsByOrg, type Project } from '../project/repository.js';
import type { UserContext } from '../project/visibility.js';
import { listMyQuestions } from '../question/service.js';
import { listResumableTasks } from '../task/repository.js';
import { clip, firstQuestion, notificationTypeOf, renderNotification, roleShort, type NotificationType } from './render.js';
import { advanceReadCursor, countUnreadNotifications, findReadCursor, listNotificationRows } from './repository.js';

// 받은 편지함(대표 결정 2026-10-29) — 두 칸이다.
//
// (1) 알림 = "일어난 일"(내 태스크가 완료됐다, 내 질문에 답이 왔다, 나에게 질문이 왔다). **events에서 계산한다** —
//     알림 테이블을 두면 events와 같은 사실을 두 번 쓰게 되고(P5), 받는 사람 규칙을 바꿀 때마다 쌓인 행을 고쳐야 한다.
//     사람마다 남는 것은 읽음 커서(users.notifications_read_event_id) 하나다. 읽음은 상태 변화가 아니라 화면 상태라
//     events에 쓰지 않는다(노트 읽기와 같은 이유 — 쓰면 events가 조회 로그가 된다).
// (2) 처리할 일 = 지금 내가 손대야 하는 것. **지금 상태에서 계산한다** — 처리하면 저절로 빠진다.
//     종류마다 기존 API의 조회·판정 함수를 그대로 쓴다(승인 listApprovals, 질문 listMyQuestions, 계약 contractApproverRole, 재개 listResumableTasks) —
//     "누가 처리할 수 있나"의 정의가 두 벌이면 받은 편지함에 보이는데 누르면 403이 된다.
// 화면 신호는 org 토픽 'inbox'(realtime/topics.ts) — 데이터가 없고 화면이 두 API를 다시 읽는다.

export type Notification = {
  id: string;
  type: NotificationType;
  ts: string;
  read: boolean;
  projectId: string;
  projectName: string;
  taskId: string | null;
  taskTitle: string | null;
  questionId: string | null;
  role: string | null;
  text: string;
};

function recipient(actor: UserContext) {
  return { orgId: actor.orgId, userId: actor.userId, isRepresentative: actor.orgRole === 'REPRESENTATIVE' };
}

function isRead(eventId: string, cursor: string | null): boolean {
  return cursor !== null && BigInt(eventId) <= BigInt(cursor);
}

export async function listNotifications(
  actor: UserContext,
  input: { before: string | null; limit: number },
): Promise<{ notifications: Notification[]; unreadCount: number }> {
  const who = recipient(actor);
  const cursor = await findReadCursor(pool, actor.userId);
  const [rows, unreadCount] = await Promise.all([listNotificationRows(pool, who, input), countUnreadNotifications(pool, who, cursor)]);
  const notifications = rows.map((row): Notification => {
    const type = notificationTypeOf(row.type);
    return {
      id: row.eventId,
      type,
      ts: row.ts,
      read: isRead(row.eventId, cursor),
      projectId: row.projectId,
      projectName: row.projectName,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      questionId: type === 'task_done' ? null : row.questionId,
      role: row.role,
      text: renderNotification(row),
    };
  });
  return { notifications, unreadCount };
}

// 읽음 — 커서를 upToEventId(없으면 지금 최신)까지 민다. 뒤로는 가지 않는다. 이벤트를 남기지 않는다(위 주석).
export async function markNotificationsRead(actor: UserContext, upToEventId: string | null): Promise<{ readUpToEventId: string | null; unreadCount: number }> {
  const cursor = await advanceReadCursor(pool, actor.userId, upToEventId);
  return { readUpToEventId: cursor, unreadCount: await countUnreadNotifications(pool, recipient(actor), cursor) };
}

// ── 처리할 일 ───────────────────────────────────────────────────────────

export const INBOX_KINDS = [
  'approval_role_review',
  'approval_final',
  'release',
  'question',
  'contract',
  'plan',
  'stuck_task',
  'agent_needed',
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export type InboxItem = {
  kind: InboxKind;
  createdAt: string;
  projectId: string;
  projectName: string;
  approvalId: string | null;
  questionId: string | null;
  contractId: string | null;
  planId: string | null;
  taskId: string | null;
  agentId: string | null;
  role: string | null;
  title: string;
  text: string;
};

const OPEN_STATUSES = new Set(['planning', 'active', 'halted']);
const PLAN_KIND_LABEL: Record<string, string> = { feature: '기능 명세', tasks: '태스크 나누기' };

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function item(project: Pick<Project, 'id' | 'name'>, kind: InboxKind, createdAt: unknown, rest: Partial<InboxItem> & { title: string; text: string }): InboxItem {
  return {
    kind,
    createdAt: iso(createdAt),
    projectId: project.id,
    projectName: project.name,
    approvalId: null,
    questionId: null,
    contractId: null,
    planId: null,
    taskId: null,
    agentId: null,
    role: null,
    ...rest,
  };
}

function approvalItem(a: ApprovalView, kind: InboxKind): InboxItem {
  const project = { id: a.projectId, name: a.projectName };
  if (kind === 'release') {
    return item(project, kind, a.requestedAt, {
      approvalId: a.id,
      title: a.projectName,
      text: `${a.projectName} — 모든 태스크가 끝났습니다. 통합 확인 후 완료를 승인해 주세요`,
    });
  }
  const title = a.taskTitle ?? String(a.payload.taskTitle ?? '태스크');
  const sha = typeof a.payload.commitSha === 'string' ? ` (커밋 ${a.payload.commitSha.slice(0, 7)})` : '';
  const role = (a.payload.teamRole as string | null | undefined) ?? null;
  let text: string;
  if (kind === 'approval_role_review') {
    text = `${title} — 1차 검토를 기다립니다${sha}`;
  } else if (a.roleReview) {
    const by = a.roleReview.decidedByRepresentative
      ? '대표가 1차 검토를 대신 승인'
      : `${[roleShort(role) ? `${roleShort(role)} 담당` : '담당', a.roleReview.nickname].filter(Boolean).join(' ')} 1차 승인`;
    text = `${title} — 최종 승인을 기다립니다 (${by})`;
  } else {
    text = `${title} — 최종 승인을 기다립니다${sha}`;
  }
  return item(project, kind, a.requestedAt, { approvalId: a.id, taskId: a.taskId, role, title, text });
}

export async function listInbox(actor: UserContext): Promise<{ items: InboxItem[]; counts: Record<InboxKind, number> }> {
  const isRep = actor.orgRole === 'REPRESENTATIVE';
  // 볼 수 있는 진행 중 프로젝트(프로젝트 목록 API와 같은 선택 — 지운 프로젝트는 이미 빠진다). 끝난 프로젝트의 일은 처리할 것이 아니다.
  const projects = (await listProjectsByOrg(pool, actor.orgId, isRep ? null : actor.userId)).filter((p) => OPEN_STATUSES.has(p.status));
  const open = new Map(projects.map((p) => [p.id, p]));
  const items: InboxItem[] = [];

  // 승인 — GET /me/approvals와 같은 선택(내가 지금 그 역할 담당인 1차 검토), 대표는 조직 대기열의 final·G3.
  const mine = await listApprovals(pool, { orgId: actor.orgId, status: 'pending', stage: 'role_review', reviewerUserId: actor.userId, limit: 200 });
  for (const a of mine) if (open.has(a.projectId)) items.push(approvalItem(a, 'approval_role_review'));
  if (isRep) {
    const finals = await listApprovals(pool, { orgId: actor.orgId, status: 'pending', stage: 'final', limit: 200 });
    for (const a of finals) {
      if (!open.has(a.projectId)) continue;
      if (a.gate === 'ACTION') items.push(approvalItem(a, 'approval_final'));
      else if (a.gate === 'G3') items.push(approvalItem(a, 'release'));
    }
  }

  // 질문 — GET /me/questions와 같은 선택(answerQuestion의 자격 정의).
  for (const { question, projectName, taskTitle } of await listMyQuestions(actor, 'pending', 200)) {
    if (!open.has(question.projectId)) continue;
    items.push(
      item({ id: question.projectId, name: projectName }, 'question', question.createdAt, {
        questionId: question.id,
        taskId: question.taskId,
        role: question.targetRole,
        title: firstQuestion(question.questions),
        text: `${roleShort(question.askerRole)} 에이전트의 질문 (${taskTitle}) — ${firstQuestion(question.questions)}`,
      }),
    );
  }

  // 아래는 프로젝트 수와 상관없이 종류마다 쿼리 한 번이다(프로젝트마다 물으면 프로젝트가 늘수록 받은 편지함이 느려진다).
  const projectIds = projects.map((p) => p.id);

  // 계약 — 확정 대기(draft)와 실패(failed). 확정할 수 있는 사람만(contractApproverRole — 확정 API와 같은 판정).
  const contracts = await listContractsForProjects(pool, projectIds, ['draft', 'failed']);
  if (contracts.length > 0) {
    const owners = await findBackendOwners(pool, [...new Set(contracts.map((c) => c.projectId))]);
    for (const c of contracts) {
      if (contractApproverRole(owners.get(c.projectId) ?? null, actor) === null) continue;
      items.push(
        item(open.get(c.projectId)!, 'contract', c.updatedAt, {
          contractId: c.id,
          role: 'BACKEND',
          title: c.specTitle,
          text:
            c.status === 'draft'
              ? `${c.specTitle} — API 계약 초안을 확정해 주세요`
              : `${c.specTitle} — API 계약 작성이 실패했습니다. 다시 요청이 필요합니다`,
        }),
      );
    }
  }

  // PM 초안 — 프로젝트·종류마다 가장 최근 것이 검토 대기(ready)나 실패(failed)면. 대표만(계획 API가 대표 전용).
  if (isRep) {
    for (const plan of await listLatestPlansByKind(pool, projectIds)) {
      if (plan.status !== 'ready' && plan.status !== 'failed') continue;
      const label = PLAN_KIND_LABEL[plan.kind] ?? '계획';
      items.push(
        item(open.get(plan.projectId)!, 'plan', plan.createdAt, {
          planId: plan.id,
          title: `${label} 초안`,
          text:
            plan.status === 'ready'
              ? `${label} 초안이 준비됐습니다 — 검토해 주세요`
              : `${label} 초안 작성이 실패했습니다(${plan.errorReason ?? '알 수 없음'}) — 다시 요청이 필요합니다`,
        }),
      );
    }
  }

  // 에이전트가 필요한 내 역할 — 진행 중 프로젝트에서 담당은 나인데 에이전트가 없다(연결 해제 등). 재연결 판정(028)과 같은 함수.
  for (const seat of await listAgentlessRolesOfUser(pool, actor.userId)) {
    const project = open.get(seat.projectId);
    if (!project) continue;
    items.push(
      item(project, 'agent_needed', project.createdAt, {
        role: seat.teamRole,
        title: project.name,
        text: `${project.name} — ${roleShort(seat.teamRole)} 역할에 에이전트가 연결돼 있지 않습니다. CLI로 연결해 주세요`,
      }),
    );
  }

  // 멈춘 태스크 — 재개(POST /tasks/:id/resume)는 대표 전용이다.
  if (isRep) {
    for (const { task, updatedAt } of await listResumableTasks(pool, projects.map((p) => p.id))) {
      const project = open.get(task.projectId)!;
      items.push(
        item(project, 'stuck_task', updatedAt, {
          taskId: task.id,
          agentId: task.assigneeAgentId,
          role: task.teamRole,
          title: task.title,
          text:
            task.state === 'ESCALATED'
              ? `${clip(task.title)} — 재시도 한도를 넘었습니다. 원인을 확인하고 재개해 주세요`
              : `${clip(task.title)} — 에이전트가 제출 없이 멈췄습니다. 원인을 확인하고 재개해 주세요`,
        }),
      );
    }
  }

  // 먼저 생긴 일부터 처리한다.
  items.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.kind.localeCompare(b.kind));
  const counts = Object.fromEntries(INBOX_KINDS.map((k) => [k, 0])) as Record<InboxKind, number>;
  for (const i of items) counts[i.kind] += 1;
  return { items, counts };
}
