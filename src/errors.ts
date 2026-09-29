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
  | 'INVALID_REFRESH_TOKEN'
  | 'ALREADY_IN_ORG'
  | 'NOT_IN_ORG'
  | 'POLICY_STALE'
  | 'PROJECT_HALTED'
  | 'NOT_PROJECT_MEMBER'
  | 'SCOPE_DENIED'
  | 'FORBIDDEN_PATH'
  | 'GITHUB_ACCOUNT_TAKEN'
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
  | 'PROJECT_NOT_FOUND'
  | 'INVALID_AUTONOMY_PRESET'
  | 'REPO_IN_ACTIVE_PROJECT'
  | 'ROLE_ALREADY_ASSIGNED'
  | 'AGENT_ALREADY_ASSIGNED'
  | 'AGENT_IN_ANOTHER_PROJECT'
  | 'AGENT_NOT_IN_ORG'
  | 'PROJECT_STARTED'
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
