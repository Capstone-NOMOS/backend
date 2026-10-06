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
  | 'PROJECT_STARTED'
  | 'NOTES_ACK_REQUIRED'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_RESULT'
  | 'QUESTION_ASKED'
  | 'QUESTION_ANSWERED'
  | 'QUESTION_EXPIRED'
  | 'MEMBER_UNASSIGNED'
  | 'REPO_UPDATED'
  | 'TASKS_IMPORTED'
  | 'SPEC_CREATED'
  | 'TASK_CREATED'
  | 'AGENT_DEVICE_REQUESTED'
  | 'AGENT_DEVICE_DECIDED'
  | 'PM_PLAN_REQUESTED'
  | 'PM_CALL'
  | 'PM_PLAN_DRAFTED'
  | 'PM_PLAN_FAILED'
  | 'PLAN_APPLIED'
  | 'PLAN_REJECTED';

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
  // 어떤 경로로 연결했나. 예전 행에는 없다(연결 키뿐이던 시절).
  method?: 'connect_key' | 'device';
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
  // 이 제출이 확인한 인계 노트(브리핑으로 받은 것 + 반려 뒤 모델이 확인한 것). "무엇을 보고 냈나"의 기록이다.
  acknowledgedNoteIds?: string[];
};

// 제출을 반려하고 노트 확인을 요구했다. 정책 거부(TOOL_DENIED)가 아니다 — 새 정보가 생긴 것이라 M5′ 분모에 넣지 않고,
// 재시도 횟수도 올리지 않는다. 몇 번 반려됐는지는 이 이벤트로 센다.
// 승인 카드가 생겼다(검증 통과 + 판정이 HUMAN·PM_REVIEW). 책임 주체는 제출한 에이전트의 주인.
export type ApprovalRequestedPayload = {
  approvalId: string;
  gate: string;
  taskId: string;
  artifactId: string;
  gateMode: string;
  triggeredActions: string[];
};

// 실행 중인 에이전트가 다른 역할 소관의 결정을 물었다(AskUserQuestion → 브릿지 → 서버). 질문 문장은 행에 있다.
export type QuestionAskedPayload = {
  questionId: string;
  taskId: string;
  askerRole: string;
  targetRole: string;
  routedBy: string;
  questionCount: number;
};

// 대상 역할의 사람이 답했다. answeredByRole: 답한 사람이 대상 역할 담당인지 대표인지(대표는 어느 역할이든 답할 수 있다).
export type QuestionAnsweredPayload = {
  questionId: string;
  taskId: string;
  targetRole: string;
  answeredByRole: 'TARGET_OWNER' | 'REPRESENTATIVE';
  waitedMs: number;
};

// 시간 안에 답이 오지 않았다 — 에이전트는 멈추고(E4) 태스크는 사람이 다시 움직여야 한다.
export type QuestionExpiredPayload = {
  questionId: string;
  taskId: string;
  targetRole: string;
};

// 대표가 승인·반려했다.
// - reviewer: 'human' | 'human_fallback'(PM_REVIEW를 PM 리뷰가 없어 사람이 대신 처리) — PM 리뷰가 생기면 지표를 나눠 센다.
// - selfApproval: 승인자가 제출한 에이전트의 주인이다 — "다른 멤버 승인" 규칙을 만들 때의 근거.
// - retryCause: 반려면 'REJECTED'(검증 실패는 VERIFICATION_COMPLETED의 'VERIFICATION_FAILED'). retry_count를 같이 쓴다.
export type ApprovalResultPayload = {
  approvalId: string;
  gate: string;
  taskId: string;
  artifactId: string | null;
  decision: 'APPROVE' | 'REJECT';
  reason: string | null;
  gateMode: string | null;
  reviewer: 'human' | 'human_fallback';
  selfApproval: boolean;
  taskState: string;
  retryCount?: number;
  retryCause?: 'REJECTED';
};

export type NotesAckRequiredPayload = {
  taskId: string;
  noteIds: string[];
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

// G1 — 이 시점의 멤버·태스크 수·승인한 계획을 남긴다. 이후 지표("이 구성으로 시작해서 어땠나")의 기준점이다.
export type ProjectStartedPayload = {
  members: { agentId: string; teamRole: string }[];
  taskCount: number;
  approvedSpecCount: number;
  approvedPlanIds: string[];
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

// 과거 기록용 — 더 이상 새로 남기지 않는다. 명세·태스크 생성은 경로(API·들여오기·PM)와 무관하게
// 항목마다 SPEC_CREATED·TASK_CREATED를 남기고 source로 가른다(domain/authoring). 이미 쌓인 행을 읽을 때만 쓴다.
export type TasksImportedPayload = {
  source: string;
  specIds: string[];
  taskIds: string[];
  specTestCount: number;
  dependencyCount: number;
};

// 명세·태스크를 누가 어떤 경로로 만들었나. 지표는 이 값으로 가른다 —
// human(대표가 API로) · import(seed:tasks 파일) · pm(PM 에이전트, 미구현).
export type AuthoringSource = 'human' | 'import' | 'pm';

export type SpecCreatedPayload = {
  source: AuthoringSource;
  specId: string;
  featureKey: string;
  testCount: number;
  lockedTestCount: number;
};

export type TaskCreatedPayload = {
  source: AuthoringSource;
  taskId: string;
  title: string;
  repoId: string;
  teamRole: string | null;
  kind: string;
  specId: string | null;
  dependsOn: string[];
};

// ── 내장 PM(domain/pm) ──
// 요청·적용은 대표 명의, 초안 생성·호출은 system:pm 명의다(P3).
export type PmPlanRequestedPayload = { planId: string; parentPlanId: string | null; kind: 'draft' | 'revise' };

// PM의 모델 호출 한 번. 비용은 events.token_cost(USD)에 싣는다 — 프로젝트 PM 예산은 이 합계로 검사한다.
// interrupted면 실제 사용량을 모른다(재시작·시간 제한) — 호출 전에 잡아 둔 최대치로 정산한 것이다.
export type PmCallPayload = {
  planId: string;
  purpose: 'draft' | 'repair';
  requestedModel: string;
  servedModel: string | null;
  // api: 서버가 Anthropic API를 직접 불렀다(과금). relay: 대표 노트북의 Claude Code(구독)가 실행했다 — 비용은 참고값이다.
  provider?: 'api' | 'relay';
  stopReason: string | null;
  interrupted: boolean;
  // 시도마다(대체 모델이 돌면 둘 이상) 모델과 토큰. 비용은 항목마다 그 모델 가격으로 계산해 더한다.
  attempts: { model: string; inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number }[];
};

export type PmPlanDraftedPayload = { planId: string; dagHash: string; specCount: number; taskCount: number; repaired: boolean };
export type PmPlanFailedPayload = { planId: string; reason: string };
// 대표가 초안을 버렸다. 사유는 선택이다. 지표: PM 초안이 얼마나 반려되나(수정 요청과 구분된다).
export type PlanRejectedPayload = {
  planId: string;
  rootPlanId: string;
  reason: string | null;
};

export type PlanAppliedPayload = { planId: string; specIds: string[]; taskIds: string[] };

// CLI 브라우저 승인. 요청 시점에는 승인할 사람이 아직 없다 — on_behalf_of는 system:device-flow.
// 결정(승인·거부)은 결정한 사람 명의다. 토큰 발급은 AGENT_CONNECTED(method: 'device')로 남는다.
export type AgentDeviceRequestedPayload = { requestId: string; agentName: string; harness: string; clientIp: string | null };
export type AgentDeviceDecidedPayload = { requestId: string; decision: 'APPROVED' | 'DENIED'; agentName: string; clientIp: string | null };

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
  PROJECT_STARTED: ProjectStartedPayload;
  NOTES_ACK_REQUIRED: NotesAckRequiredPayload;
  APPROVAL_REQUESTED: ApprovalRequestedPayload;
  APPROVAL_RESULT: ApprovalResultPayload;
  QUESTION_ASKED: QuestionAskedPayload;
  QUESTION_ANSWERED: QuestionAnsweredPayload;
  QUESTION_EXPIRED: QuestionExpiredPayload;
  MEMBER_UNASSIGNED: MemberUnassignedPayload;
  REPO_UPDATED: RepoUpdatedPayload;
  TASKS_IMPORTED: TasksImportedPayload;
  SPEC_CREATED: SpecCreatedPayload;
  TASK_CREATED: TaskCreatedPayload;
  PM_PLAN_REQUESTED: PmPlanRequestedPayload;
  PM_CALL: PmCallPayload;
  PM_PLAN_DRAFTED: PmPlanDraftedPayload;
  PM_PLAN_FAILED: PmPlanFailedPayload;
  PLAN_APPLIED: PlanAppliedPayload;
  PLAN_REJECTED: PlanRejectedPayload;

  AGENT_DEVICE_REQUESTED: AgentDeviceRequestedPayload;
  AGENT_DEVICE_DECIDED: AgentDeviceDecidedPayload;
};
