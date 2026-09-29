import { AppError, type ErrorCode } from '../errors.js';

// 거부를 트랜잭션 안에서 throw하면 방금 남긴 TOOL_DENIED까지 함께 롤백된다.
// 그래서 트랜잭션은 "거부했다"는 사실을 커밋하고 돌아온 뒤, 밖에서 던진다.
// 이 패턴을 쓰는 서비스가 둘 이상이라 한 곳에 둔다.
export type Denied = { code: ErrorCode; message: string; details?: unknown };

export type Outcome<T> = { denied: Denied } | { value: T };

export function settle<T>(outcome: Outcome<T>): T {
  if ('denied' in outcome) {
    throw new AppError(outcome.denied.code, outcome.denied.message, outcome.denied.details);
  }
  return outcome.value;
}
