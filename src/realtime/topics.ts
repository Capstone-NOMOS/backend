import type { EventType } from '../domain/events/types.js';

// 이벤트 타입 → 화면이 다시 읽을 것(토픽). 신호에는 "무엇을 다시 읽을지"만 싣고 데이터는 싣지 않는다 —
// 화면은 기존 API로 다시 읽으므로 권한·모양이 API 한 곳에서 정해진다.
//
// project 토픽은 그 프로젝트를 구독한 연결에만, org 토픽은 같은 조직의 모든 연결에 간다(approvals는 대표에게만 — 조직 대기열 API가 대표 전용이다).
// 프로젝트가 있는 이벤트는 전부 'events'(활동 로그)를 함께 받는다 — 여기 매핑이 없는 새 타입도 활동 로그로는 빠지지 않는다.
// Record<EventType, …>라서 이벤트 타입을 추가하면 여기를 채우기 전에는 컴파일이 안 된다.

// room: 룸 피드(GET /projects/:id/rooms/:role/feed). 에이전트 활동(agent_activity)은 이벤트가 아니라 room/activity-hub로 따로 온다.
export const PROJECT_TOPICS = ['project', 'tasks', 'specs', 'plans', 'approvals', 'notes', 'members', 'events', 'room'] as const;
export const ORG_TOPICS = ['projects', 'approvals', 'agents', 'repos', 'members'] as const;

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
  MEMBER_JOINED: { org: ['members', 'agents'] },
  INVITE_CREATED: { org: ['members'] },
  INVITE_ACCEPTED: { org: ['members'] },
  GITHUB_LINKED: { org: ['repos'] },
  REPO_CONNECTED: { org: ['repos'] },
  REPO_PATH_UPDATED: { org: ['repos'] },
  REPO_UPDATED: { org: ['repos'] },

  PROJECT_CREATED: { project: ['project'], org: ['projects', 'repos'] },
  PROJECT_STARTED: { project: ['project', 'tasks', 'specs', 'plans', 'room'], org: ['projects'] },
  MEMBER_ASSIGNED: { project: ['members'], org: ['agents'] },
  MEMBER_UNASSIGNED: { project: ['members'], org: ['agents'] },
  GITHUB_COLLABORATORS_INVITED: { project: ['members'], org: ['members'] },

  SPEC_CREATED: { project: ['specs'] },
  TASK_CREATED: { project: ['tasks'] },
  TASKS_IMPORTED: { project: ['tasks', 'specs'] },
  TASK_CLAIMED: { project: ['tasks', 'room'] },
  ARTIFACT_SUBMITTED: { project: ['tasks', 'room'] },
  VERIFICATION_COMPLETED: { project: ['tasks', 'room'] },
  TASK_DISPATCHED: { project: ['room'] },
  AGENT_RUN_STARTED: { project: ['room'] },
  AGENT_RUN_ENDED: { project: ['room', 'tasks'] },
  TASK_BLOCKED: { project: ['room', 'tasks'] },
  TASK_RESUMED: { project: ['room', 'tasks'] },
  RELEASE_REQUESTED: { project: ['approvals', 'project', 'room'], org: ['approvals', 'projects'] },
  ACTION_DETECTED: { project: ['tasks'] },
  RELEASE_DECIDED: { project: ['approvals', 'project', 'room'], org: ['approvals', 'projects'] },
  NOTES_ACK_REQUIRED: {},
  TOOL_DENIED: {},
  PM_REVIEW_DEGRADED: {},
  NOTE_PUBLISHED: { project: ['notes', 'room'] },

  APPROVAL_REQUESTED: { project: ['approvals', 'tasks', 'room'], org: ['approvals'] },
  APPROVAL_RESULT: { project: ['approvals', 'tasks', 'room'], org: ['approvals'] },

  PM_PLAN_REQUESTED: { project: ['plans'] },
  PM_CALL: { project: ['plans'] },
  PM_PLAN_DRAFTED: { project: ['plans'] },
  PM_PLAN_FAILED: { project: ['plans'] },
  PLAN_REJECTED: { project: ['plans'] },
  PLAN_APPLIED: { project: ['plans', 'tasks', 'specs', 'room'] },
};

export function topicsFor(type: string, hasProject: boolean): { project: ProjectTopic[]; org: OrgTopic[] } {
  const mapping: Mapping = (TOPICS_BY_EVENT as Record<string, Mapping | undefined>)[type] ?? {};
  const project = new Set<ProjectTopic>(mapping.project ?? []);
  if (hasProject) project.add('events');
  return { project: hasProject ? [...project] : [], org: [...(mapping.org ?? [])] };
}
