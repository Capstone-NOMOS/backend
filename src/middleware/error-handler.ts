import type { NextFunction, Request, Response } from 'express';
import { logger } from '../config/logger.js';
import { AppError } from '../errors.js';

// 상세를 응답에 실어도 되는 코드. 기본은 감추는 것이다 — details에는 zod 내부 구조처럼
// 밖에 보여선 안 되는 게 들어올 수 있다. 여기 있는 코드만 예외로 공개한다.
//
// NOTE_INVALID가 여기 있어야 하는 이유: 위반 목록(어느 필드의 몇 번째가 몇 자인지)이 빠지면
// 에이전트는 "note validation failed"만 보고 무엇을 줄여야 할지 모른 채 같은 요청을 반복한다.
// 자르지 않고 전부 되돌려주는 것이 노트 검증의 설계 의도다(domain/note/validate.ts).
const PUBLIC_DETAIL_CODES = new Set(['POLICY_STALE', 'NOTE_INVALID', 'PLAN_INVALID']);

// 객체 details는 error 안으로 펼치고(POLICY_STALE의 reason), 배열은 details 키에 담는다.
// 배열을 펼치면 {0:…,1:…}가 되어 클라이언트가 읽을 수 없다.
function publicDetails(details: unknown): Record<string, unknown> {
  if (Array.isArray(details)) return { details };
  return typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {};
}

// AppError -> { error: { code, message } } HTTP 응답으로 변환한다.
// AppError가 아닌 예외(버그, DB 예외 등)는 500으로 감추고 상세는 로그로만 남긴다.
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    const details = PUBLIC_DETAIL_CODES.has(err.code) ? publicDetails(err.details) : {};
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...details } });
    return;
  }

  logger.error('unhandled error', {
    path: req.path,
    method: req.method,
    error: err instanceof Error ? err.stack : String(err),
  });
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'internal server error' } });
}
