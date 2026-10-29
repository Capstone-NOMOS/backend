import type { EventType } from '../domain/events/types.js';

// 이벤트 타입 → 화면이 다시 읽을 것(토픽). 신호에는 "무엇을 다시 읽을지"만 싣고 데이터는 싣지 않는다 —
// 화면은 기존 API로 다시 읽으므로 권한·모양이 API 한 곳에서 정해진다.
//
// project 토픽은 그 프로젝트를 구독한 연결에만, org 토픽은 같은 조직의 모든 연결에 간다.
// 프로젝트가 있는 이벤트는 전부 'events'(활동 로그)를 함께 받는다 — 여기 매핑이 없는 새 타입도 활동 로그로는 빠지지 않는다.
// Record<EventType, …>라서 이벤트 타입을 추가하면 여기를 채우기 전에는 컴파일이 안 된다.

// room: 룸 피드(GET /projects/:id/rooms/:role/feed). 에이전트 활동(agent_activity)은 이벤트가 아니라 room/activity-hub로 따로 온다.
// contracts(023): API 계약 — BE 개발자가 확정할 계약 목록.
export const PROJECT_TOPICS = ['project', 'tasks', 'specs', 'plans', 'approvals', 'notes', 'members', 'questions', 'events', 'room', 'contracts'] as const;
// inbox: 받은 편지함(GET /me/notifications·/me/inbox). 알림이 되는 이벤트와 "처리할 일"이 바뀌는 이벤트에서 조직 전부에 간다 —
// 누가 받을지는 화면이 두 API를 다시 읽어 안다(신호에는 데이터가 없다).
export const ORG_TOPICS = ['projects', 'approvals', 'agents', 'repos', 'members', 'questions', 'contracts', 'inbox'] as const;

export type ProjectTopic = (typeof PROJECT_TOPICS)[number];
export type OrgTopic = (typeof ORG_TOPICS)[number];

type Mapping = { project?: ProjectTopic[]; org?: OrgTopic[] };

export const TOPICS_BY_EVENT: Record<EventType, Mapping> = {
  // 조직에 들기 전·밖의 행동 — 화면에 실시간으로 보일 곳이 없다.
  USER_SIGNED_UP: {},
  CONNECT_KEY_ROTATED: {},
  ORG_CREATED: {},
  AGENT_DEVICE_REQUESTED: {},
  AGENT_DEVICE_DECIDED: {},

  AGENT_CONNECTED: { org: ['agents'] },
  AGENT_CONNECT_CODE_ISSUED: {},
  MEMBER_JOINED: { org: ['members', 'agents'] },
  INVITE_CREATED: { org: ['members'] },
  INVITE_ACCEPTED: { org: ['members'] },
  GITHUB_LINKED: { org: ['repos'] },
  REPO_CONNECTED: { org: ['repos'] },
  REPO_PATH_UPDATED: { org: ['repos'] },
  REPO_UPDATED: { org: ['repos'] },

  PROJECT_CREATED: { project: ['project'], org: ['projects', 'repos'] },
  PROJECT_STARTED: { project: ['project', 'tasks', 'specs', 'plans', 'room'], org: ['projects'] },
  MEMBER_ASSIGNED: { project: ['members'], org: ['agents', 'inbox'] },
  MEMBER_UNASSIGNED: { project: ['members'], org: ['agents', 'inbox'] },
  ROOM_MESSAGE_SENT: { project: ['room'] },
  MEMBER_AGENT_DETACHED: { project: ['members', 'room'], org: ['agents', 'inbox'] },
  MEMBER_AGENT_ATTACHED: { project: ['members', 'room'], org: ['agents', 'inbox'] },
  AGENT_DISCONNECTED: { org: ['agents'] },
  ORG_MEMBER_REMOVED: { org: ['members', 'agents'] },
  REPO_DISCONNECTED: { org: ['repos'] },
  INVITE_REVOKED: { org: ['members'] },
  GITHUB_COLLABORATORS_REMOVED: { project: ['members'], org: ['members'] },
  PROJECT_ABORTED: { project: ['project', 'tasks', 'members', 'room'], org: ['projects', 'repos', 'agents', 'approvals', 'inbox'] },
  // 지운 프로젝트는 목록에서 빠진다. 그 프로젝트를 구독 중인 연결은 신호를 받은 뒤 구독이 끊긴다(user-stream의 다시 확인).
  PROJECT_DELETED: { project: ['project'], org: ['projects', 'approvals', 'questions', 'inbox'] },
  // 해산 — 연결은 user-stream이 대표까지 다시 확인해 끊는다(4403 NOT_IN_ORG).
  ORG_DISSOLVED: { org: ['members', 'agents', 'projects', 'repos'] },
  GITHUB_COLLABORATORS_INVITED: { project: ['members'], org: ['members'] },

  SPEC_CREATED: { project: ['specs'] },
  TASK_CREATED: { project: ['tasks'] },
  TASKS_IMPORTED: { project: ['tasks', 'specs'] },
  TASK_CLAIMED: { project: ['tasks', 'room'] },
  ARTIFACT_SUBMITTED: { project: ['tasks', 'room'] },
  VERIFICATION_COMPLETED: { project: ['tasks', 'room'], org: ['inbox'] },
  TASK_DISPATCHED: { project: ['room'] },
  AGENT_RUN_STARTED: { project: ['room'] },
  AGENT_RUN_ENDED: { project: ['room', 'tasks'] },
  TASK_BLOCKED: { project: ['room', 'tasks'], org: ['inbox'] },
  TASK_RESUMED: { project: ['room', 'tasks'], org: ['inbox'] },
  TASK_CANCELLED: { project: ['room', 'tasks'], org: ['inbox'] },
  TASK_COMPLETED_MANUALLY: { project: ['room', 'tasks'], org: ['inbox'] },
  PROJECT_SETTINGS_UPDATED: { project: ['project'], org: ['projects'] },
  RELEASE_REQUESTED: { project: ['approvals', 'project', 'room'], org: ['approvals', 'projects', 'inbox'] },
  ACTION_DETECTED: { project: ['tasks'] },
  RELEASE_DECIDED: { project: ['approvals', 'project', 'room'], org: ['approvals', 'projects', 'inbox'] },
  NOTES_ACK_REQUIRED: {},
  DECISIONS_ACK_REQUIRED: {},
  TOOL_DENIED: {},
  PM_REVIEW_DEGRADED: {},
  NOTE_PUBLISHED: { project: ['notes', 'room'] },

  APPROVAL_REQUESTED: { project: ['approvals', 'tasks', 'room'], org: ['approvals', 'inbox'] },
  APPROVAL_RESULT: { project: ['approvals', 'tasks', 'room'], org: ['approvals', 'inbox'] },
  QUESTION_ASKED: { project: ['questions'], org: ['questions', 'inbox'] },
  QUESTION_GOLD_LABELED: { project: ['questions'] },
  CONTRACT_REQUESTED: { project: ['contracts', 'room'], org: ['contracts'] },
  CONTRACT_DRAFTED: { project: ['contracts', 'room'], org: ['contracts', 'inbox'] },
  CONTRACT_REVISION_REQUESTED: { project: ['contracts', 'room'], org: ['contracts', 'inbox'] },
  CONTRACT_APPROVED: { project: ['contracts', 'room'], org: ['contracts', 'inbox'] },
  CONTRACT_FAILED: { project: ['contracts', 'room'], org: ['contracts', 'inbox'] },
  QUESTION_ANSWERED: { project: ['questions', 'tasks'], org: ['questions', 'inbox'] },
  QUESTION_EXPIRED: { project: ['questions', 'tasks'], org: ['questions', 'inbox'] },
  QUESTION_DRAFTED: { project: ['questions', 'tasks'], org: ['questions', 'inbox'] },
  TASK_BLOCKED_ON_QUESTION: { project: ['tasks', 'questions'] },

  PM_PLAN_REQUESTED: { project: ['plans'], org: ['inbox'] },
  PM_CALL: { project: ['plans'] },
  PM_PLAN_DRAFTED: { project: ['plans'], org: ['inbox'] },
  PM_PLAN_FAILED: { project: ['plans'], org: ['inbox'] },
  PLAN_REJECTED: { project: ['plans'], org: ['inbox'] },
  PLAN_APPLIED: { project: ['plans', 'tasks', 'specs', 'room'], org: ['inbox'] },
};

export function topicsFor(type: string, hasProject: boolean): { project: ProjectTopic[]; org: OrgTopic[] } {
  const mapping: Mapping = (TOPICS_BY_EVENT as Record<string, Mapping | undefined>)[type] ?? {};
  const project = new Set<ProjectTopic>(mapping.project ?? []);
  if (hasProject) project.add('events');
  return { project: hasProject ? [...project] : [], org: [...(mapping.org ?? [])] };
}
