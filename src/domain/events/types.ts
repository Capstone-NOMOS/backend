export type EventType =
  | 'USER_SIGNED_UP'
  | 'CONNECT_KEY_ROTATED'
  | 'AGENT_CONNECTED'
  | 'ORG_CREATED'
  | 'REPO_CONNECTED'
  | 'REPO_PATH_UPDATED'
  | 'INVITE_CREATED'
  | 'INVITE_ACCEPTED'
  | 'MEMBER_JOINED'
  | 'PM_REVIEW_DEGRADED'
  | 'TOOL_DENIED'
  | 'GITHUB_LINKED'
  | 'TASK_CLAIMED'
  | 'ARTIFACT_SUBMITTED'
  | 'VERIFICATION_COMPLETED'
  | 'NOTE_PUBLISHED'
  | 'PROJECT_CREATED'
  | 'MEMBER_ASSIGNED'
  | 'MEMBER_UNASSIGNED'
  | 'REPO_UPDATED'
  | 'TASKS_IMPORTED';

// payload에 연결 키·토큰·비밀번호 같은 비밀값을 절대 넣지 않는다. events는 지워지지 않는다.

export type UserSignedUpPayload = {
  userId: string;
  loginId: string;
};

export type ConnectKeyRotatedPayload = {
  userId: string;
};

export type AgentConnectedPayload = {
  agentId: string;
  userId: string;
  name: string;
  harness: string;
  reconnected: boolean;
};

export type OrgCreatedPayload = {
  orgName: string;
  userId: string;
  agentIds: string[];
};

export type RepoConnectedPayload = {
  repoId: string;
  fullName: string;
  seededPathCount: number;
};

export type RepoPathUpdatedPayload = {
  pathId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

export type InviteCreatedPayload = {
  inviteId: string;
  expiresAt: string;
  teamRole: string | null;
};

export type InviteAcceptedPayload = {
  inviteId: string;
  userId: string;
  agentIds: string[];
};

export type MemberJoinedPayload = {
  userId: string;
  orgRole: string;
  teamRole: string | null;
};

export type PmReviewDegradedPayload = {
  actionKey: string;
  reason: 'pm_timeout' | 'budget_exhausted';
  policyHash: string;
  from: 'PM_REVIEW';
  to: 'AUTO';
  subjectId: string | null;
};

export type DenialStage =
  | 'halted'          // 0a. 프로젝트 정지 — 멈춤은 명령이 아니라 상태다
  | 'policy_stale'    // 0b. 토큰이 옛 정책 기준
  | 'membership'      // 2.  이 프로젝트의 멤버가 아님
  | 'unknown_action'  // 2.  정책 사본에 없는 행동 키 — 열어주지 않고 닫는다
  | 'forbidden_action'// 2.  판정이 FORBIDDEN인 행동
  | 'ownership'       // 3.  소유 역할 불일치 또는 읽기 전용 경로
  | 'forbidden_path'  // 4.  access='denied' 경로
  | 'contract_lock';  // 5.  잠긴 계약 침범

// 경로 판정(3·4단계)이 왜 막았는가. stage 'ownership' 하나에 여러 경우가 섞이므로 집계는 이 값으로 한다 —
// 사람이 읽으라고 쓴 detail 문구로 세면 문구를 고치는 순간 지표가 조용히 0이 된다.
//   owned_by_other  다른 역할이 소유한 경로에 씀         → M5′ 분자 (path_violation = true인 유일한 경우)
//   unowned         그 경로를 덮는 소유자가 하나도 없음   → "온보딩 소유권 지정 누락". 에이전트 잘못이 아니므로 M5′에서 제외
//   read_only       읽기 전용 경로에 씀
//   denied_path     금지 경로(access='denied')
//   no_rule         매칭되는 규칙 없음('**' 시드가 빠진 레포)
export type PathDenialReason = 'owned_by_other' | 'unowned' | 'read_only' | 'denied_path' | 'no_rule';

// 권한 검증 파이프라인이 거부한 요청. 성공만 기록하면 M5′의 분모가 사라진다.
// stage가 어느 단계에서 막혔는지를 남긴다 — '왜 막혔나'를 리플레이로 복원하는 유일한 단서다.
export type ToolDeniedPayload = {
  stage: DenialStage;
  // action_catalog의 키이거나, 정책 게이트가 없는 도구의 설명 라벨('task:claim').
  // 인증 단계 거부(0a·0b)는 걸린 행동이 없으므로 '-'다.
  actionKey: string;
  repoId: string | null;
  path: string | null;
  memberRole: string | null;
  detail: string;
  // 경로 판정 거부일 때만 있다. 멤버십·정책 단계 거부에는 없다.
  reason?: PathDenialReason;
};

export type GithubLinkedPayload = {
  userId: string;
  githubLogin: string;
  scope: string;
};

export type TaskClaimedPayload = {
  taskId: string;
  teamRole: string;
  // tasks.team_role이 NULL인 태스크(역할 제한 없음)를 잡았다는 표시.
  // 나중에 "누가 아무 태스크나 잡았나"를 집계할 때 역할 배정 실수와 구분하기 위해 남긴다.
  unrestricted: boolean;
};

// changed_paths는 artifacts 행에 있다. 여기엔 판정 결과만 둔다 —
// 같은 내용을 두 곳에 쓰면 나중에 서로 어긋난다.
export type ArtifactSubmittedPayload = {
  taskId: string;
  artifactId: string;
  commitSha: string;
  attempt: number;
  triggeredActions: string[];
  gateMode: string;
};

// 읽기는 기록하지 않는다. read_notes까지 이벤트로 남기면 events가 조회 로그가 된다.
export type NotePublishedPayload = {
  noteId: string;
  seq: number;
  kind: string;
  title: string;
  specId: string | null;
  affectsCount: number;
};

// projectId는 events.project_id 열에 들어가므로 payload에 중복해 넣지 않는다.
export type ProjectCreatedPayload = {
  name: string;
  autonomyPreset: string;
  pmBudgetUsd: string;
  repoIds: string[];
  policyHash: string;
  constitutionHash: string;
};

export type MemberAssignedPayload = {
  agentId: string;
  teamRole: string;
};

export type MemberUnassignedPayload = {
  agentId: string;
  teamRole: string;
};

// 어느 단계가 어떻게 끝났는지를 그대로 남긴다. SKIPPED도 기록한다 —
// M5(자동 통과율)를 계산할 때 "통과"와 "못 돌렸다"를 구분할 수 있어야 한다.
export type VerificationCompletedPayload = {
  taskId: string;
  artifactId: string;
  attempt: number;
  stages: { stage: string; result: string }[];
  outcome: string;
  taskState: string;
  retryCount: number;
};

// 레포 설정(github_repo_id·clone_url) 변경. clone_url은 자격 증명을 넣을 수 없게 검증하므로 그대로 남겨도 된다.
export type RepoUpdatedPayload = {
  repoId: string;
  before: { githubRepoId: number | null; cloneUrl: string | null };
  after: { githubRepoId: number | null; cloneUrl: string | null };
};

// 명세·태스크를 파일에서 들여왔다(scripts/seed-remote-tasks.ts). 생성 API가 생기기 전까지의 유일한 경로다.
export type TasksImportedPayload = {
  source: string;
  specIds: string[];
  taskIds: string[];
  specTestCount: number;
  dependencyCount: number;
};

export type EventPayloadMap = {
  USER_SIGNED_UP: UserSignedUpPayload;
  CONNECT_KEY_ROTATED: ConnectKeyRotatedPayload;
  AGENT_CONNECTED: AgentConnectedPayload;
  ORG_CREATED: OrgCreatedPayload;
  REPO_CONNECTED: RepoConnectedPayload;
  REPO_PATH_UPDATED: RepoPathUpdatedPayload;
  INVITE_CREATED: InviteCreatedPayload;
  INVITE_ACCEPTED: InviteAcceptedPayload;
  MEMBER_JOINED: MemberJoinedPayload;
  PM_REVIEW_DEGRADED: PmReviewDegradedPayload;
  TOOL_DENIED: ToolDeniedPayload;
  GITHUB_LINKED: GithubLinkedPayload;
  TASK_CLAIMED: TaskClaimedPayload;
  ARTIFACT_SUBMITTED: ArtifactSubmittedPayload;
  VERIFICATION_COMPLETED: VerificationCompletedPayload;
  NOTE_PUBLISHED: NotePublishedPayload;
  PROJECT_CREATED: ProjectCreatedPayload;
  MEMBER_ASSIGNED: MemberAssignedPayload;
  MEMBER_UNASSIGNED: MemberUnassignedPayload;
  REPO_UPDATED: RepoUpdatedPayload;
  TASKS_IMPORTED: TasksImportedPayload;
};
