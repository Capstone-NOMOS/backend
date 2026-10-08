export type ErrorCode =
  | 'ORG_NAME_REQUIRED'
  | 'INVALID_GLOB_PATTERN'
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'NOT_REPRESENTATIVE'
  | 'CROSS_ORG_ACCESS'
  | 'REPO_NOT_FOUND'
  | 'PATH_NOT_FOUND'
  | 'INVITE_NOT_FOUND'
  | 'REPO_ALREADY_CONNECTED'
  | 'PATH_PATTERN_DUPLICATE'
  | 'IMMUTABLE_ORG_CEILING'
  | 'PATH_PRIORITY_TAKEN'
  | 'INVITE_EXPIRED'
  | 'INVITE_ALREADY_USED'
  | 'GITHUB_UNAVAILABLE'
  | 'LOGIN_ID_TAKEN'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_CONNECT_REQUEST'
  | 'INVALID_DEVICE_CODE'
  | 'DEVICE_REQUEST_NOT_FOUND'
  | 'DEVICE_REQUEST_EXPIRED'
  | 'DEVICE_REQUEST_ALREADY_DECIDED'
  | 'INVALID_REFRESH_TOKEN'
  | 'ALREADY_IN_ORG'
  | 'NOT_IN_ORG'
  | 'POLICY_STALE'
  | 'PROJECT_HALTED'
  | 'NOT_PROJECT_MEMBER'
  | 'SCOPE_DENIED'
  | 'FORBIDDEN_PATH'
  | 'GITHUB_ACCOUNT_TAKEN'
  | 'GITHUB_NOT_LINKED'
  | 'GITHUB_FORBIDDEN'
  | 'GITHUB_REPO_NAME_TAKEN'
  | 'RUN_NOT_ALLOWED'
  | 'RUN_NOT_OPEN'
  | 'ROOM_NOT_VISIBLE'
  | 'TASK_NOT_STOPPED'
  | 'TASK_NOT_FOUND'
  | 'TASK_ALREADY_CLAIMED'
  | 'ARTIFACT_NOT_FOUND'
  | 'VERIFICATION_ALREADY_RECORDED'
  | 'VERIFICATION_STAGE_NOT_REPORTABLE'
  | 'TASK_DEPS_NOT_DONE'
  | 'TASK_ROLE_MISMATCH'
  | 'NOT_TASK_ASSIGNEE'
  | 'TASK_STATE_INVALID'
  | 'NOTE_INVALID'
  | 'PLAN_INVALID'
  | 'PLAN_CONFLICT'
  | 'PROJECT_NOT_OPEN'
  | 'PM_UNAVAILABLE'
  | 'PM_BUDGET_EXCEEDED'
  | 'PM_PLAN_IN_PROGRESS'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_NOT_APPLICABLE'
  | 'PLAN_REVISION_LIMIT'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_ALREADY_DECIDED'
  | 'APPROVAL_STALE'
  | 'QUESTION_NOT_FOUND'
  | 'QUESTION_CLOSED'
  | 'QUESTION_INVALID'
  | 'NOT_QUESTION_TARGET'
  | 'PM_JOB_NOT_FOUND'
  | 'PM_RELAY_DISABLED'
  | 'PROJECT_NOT_FOUND'
  | 'INVALID_AUTONOMY_PRESET'
  | 'REPO_IN_ACTIVE_PROJECT'
  | 'ROLE_ALREADY_ASSIGNED'
  | 'AGENT_ALREADY_ASSIGNED'
  | 'AGENT_IN_ANOTHER_PROJECT'
  | 'AGENT_NOT_IN_ORG'
  | 'PROJECT_STARTED'
  | 'PROJECT_ALREADY_STARTED'
  | 'PROJECT_START_INVALID'
  | 'PROJECT_NOT_STARTED'
  | 'NOTES_UNACKNOWLEDGED'
  | 'MEMBER_NOT_FOUND'
  | 'REPO_OWNERSHIP_NOT_SET';

// 에러 코드 -> HTTP 상태 코드 매핑. 도메인 코드는 이 테이블에 없는 코드를 쓸 수 없다.
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  ORG_NAME_REQUIRED: 400,
  INVALID_GLOB_PATTERN: 400,
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  NOT_REPRESENTATIVE: 403,
  CROSS_ORG_ACCESS: 403,
  REPO_NOT_FOUND: 404,
  PATH_NOT_FOUND: 404,
  INVITE_NOT_FOUND: 404,
  REPO_ALREADY_CONNECTED: 409,
  PATH_PATTERN_DUPLICATE: 409,
  IMMUTABLE_ORG_CEILING: 409,
  PATH_PRIORITY_TAKEN: 409,
  INVITE_EXPIRED: 410,
  INVITE_ALREADY_USED: 410,
  GITHUB_UNAVAILABLE: 502,
  LOGIN_ID_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  // 401이 아니라 400. 연결 키가 틀렸다는 사실 자체를 드러내지 않는다.
  INVALID_CONNECT_REQUEST: 400,
  // 브라우저 승인(device flow). 모르는 deviceCode는 연결 키와 같이 400 — 존재 여부를 드러내지 않는다.
  INVALID_DEVICE_CODE: 400,
  DEVICE_REQUEST_NOT_FOUND: 404,
  DEVICE_REQUEST_EXPIRED: 410,
  DEVICE_REQUEST_ALREADY_DECIDED: 409,
  INVALID_REFRESH_TOKEN: 401,
  ALREADY_IN_ORG: 409,
  NOT_IN_ORG: 403,
  // 401 — 토큰이 옛 정책 기준이라는 뜻이므로 브릿지가 refresh로 재발급받아 1회 재시도한다.
  POLICY_STALE: 401,
  PROJECT_HALTED: 403,
  NOT_PROJECT_MEMBER: 403,
  SCOPE_DENIED: 403,
  FORBIDDEN_PATH: 403,
  GITHUB_ACCOUNT_TAKEN: 409,
  // 대표가 GitHub를 연결하지 않았거나 토큰이 무효 — 사람이 먼저 해야 할 일이 있다.
  GITHUB_NOT_LINKED: 409,
  // GitHub가 대표 토큰의 요청을 거부했다(조직 권한 없음, 조직이 NOMOS 앱을 승인하지 않음 등).
  GITHUB_FORBIDDEN: 403,
  GITHUB_REPO_NAME_TAKEN: 409,
  // 실행 시작은 그 태스크를 잡고 있는 에이전트만(CLAIMED·IN_PROGRESS).
  RUN_NOT_ALLOWED: 409,
  // 시작하지 않았거나 이미 끝낸 실행에 활동·종료를 보냈다.
  RUN_NOT_OPEN: 409,
  // 팀원은 자기 역할 룸만 본다(대표는 전부).
  ROOM_NOT_VISIBLE: 403,
  // 재개는 BLOCKED(AGENT_STOPPED)인 태스크만.
  TASK_NOT_STOPPED: 409,
  TASK_NOT_FOUND: 404,
  // 409 — 권한 문제가 아니라 경합에서 진 것이다. 재시도하면 다른 태스크를 잡으면 된다.
  TASK_ALREADY_CLAIMED: 409,
  ARTIFACT_NOT_FOUND: 404,
  VERIFICATION_ALREADY_RECORDED: 409,
  VERIFICATION_STAGE_NOT_REPORTABLE: 403,
  TASK_DEPS_NOT_DONE: 409,
  TASK_ROLE_MISMATCH: 403,
  NOT_TASK_ASSIGNEE: 403,
  TASK_STATE_INVALID: 409,
  // 422 — 형식 위반이다. 자르지 않고 어디가 틀렸는지 돌려준다.
  NOTE_INVALID: 422,
  PROJECT_NOT_FOUND: 404,
  // 명세·태스크 작성 검증 위반. details에 위반 전부를 싣는다(하나씩 고치고 다시 보내게 하지 않는다).
  PLAN_INVALID: 422,
  // 사전 검사를 통과했는데 DB 유일 제약에 걸렸다 — 동시 요청이 먼저 같은 키를 썼다.
  PLAN_CONFLICT: 409,
  // 끝났거나(completed·aborted) 멈춘(halted) 프로젝트에는 명세·태스크를 만들 수 없다.
  PROJECT_NOT_OPEN: 409,
  // 서버에 PM 키가 없다(ANTHROPIC_API_KEY). PM 외 기능은 그대로 돈다.
  PM_UNAVAILABLE: 503,
  // 이 호출이 PM 예산을 넘길 수 있다. 설계상 대표 승인 카드(budget:exceed)가 떠야 하지만 승인 API가 없어 거절만 한다(미구현).
  PM_BUDGET_EXCEEDED: 409,
  // 프로젝트당 진행 중인 PM 요청은 하나.
  PM_PLAN_IN_PROGRESS: 409,
  PLAN_NOT_FOUND: 404,
  // 적용할 수 없는 상태(ready가 아님)이거나, 같은 수정 체인에서 이미 적용된 계획이 있다.
  PLAN_NOT_APPLICABLE: 409,
  // 409 — 같은 수정 체인에서 수정 요청 한도(PM_MAX_REVISIONS)를 다 썼다. details: { limit, used }. 새 계획 요청은 0부터 다시 센다.
  PLAN_REVISION_LIMIT: 409,
  APPROVAL_NOT_FOUND: 404,
  // 409 — 결정은 한 번뿐이다(이미 승인·반려됨).
  APPROVAL_ALREADY_DECIDED: 409,
  // 409 — 결정하려는 순간 태스크가 더 이상 승인 대기가 아니다(정지·수동 변경 등).
  APPROVAL_STALE: 409,
  QUESTION_NOT_FOUND: 404,
  QUESTION_CLOSED: 409,
  QUESTION_INVALID: 422,
  NOT_QUESTION_TARGET: 403,
  // 중계 모드의 작업. 끝났거나 시간 제한에 걸렸거나 서버가 재시작돼 사라졌다.
  PM_JOB_NOT_FOUND: 404,
  // 서버가 중계 모드가 아니다(PM_PROVIDER=api) — pm-worker가 할 일이 없다.
  PM_RELAY_DISABLED: 409,
  // 422 — zod가 아니라 서비스가 판정한다. 어휘 위반은 형식 오류와 구분해서 알려준다.
  INVALID_AUTONOMY_PRESET: 422,
  // 409 — 같은 레포를 두 활성 프로젝트가 쓰면 경로 소유권이 겹친다.
  REPO_IN_ACTIVE_PROJECT: 409,
  ROLE_ALREADY_ASSIGNED: 409,
  AGENT_ALREADY_ASSIGNED: 409,
  AGENT_IN_ANOTHER_PROJECT: 409,
  AGENT_NOT_IN_ORG: 403,
  // 403 — G1(started_at) 이후에는 멤버 구성을 바꿀 수 없다. 실험 통제가 흔들린다.
  PROJECT_STARTED: 403,
  PROJECT_ALREADY_STARTED: 409,
  // 422 — 시작할 수 없는 상태(태스크 없음·역할 공백). 무엇이 비었는지 details로 전부 알려준다.
  PROJECT_START_INVALID: 422,
  // 409 — 프로젝트 시작(G1) 전에는 태스크를 가져갈 수 없다. 시작해야 실행이 시작된다.
  PROJECT_NOT_STARTED: 409,
  // 409 — 브리핑 뒤에 관련 인계 노트가 새로 생겼다. 읽고(필요하면 고치고) acknowledgedNoteIds에 넣어 다시 제출한다.
  NOTES_UNACKNOWLEDGED: 409,
  MEMBER_NOT_FOUND: 404,
  // 422 — 요청 형식은 맞지만 레포가 아직 쓸 수 있는 상태가 아니다. 무엇을 먼저 해야 하는지 함께 알려준다.
  REPO_OWNERSHIP_NOT_SET: 422,
};

// 도메인 코드가 던질 수 있는 유일한 예외 타입. code로부터 HTTP 상태를 스스로 결정한다.
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}
