import type { NextFunction, Request, Response } from 'express';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import type { OrgId, UserId } from '../domain/ids.js';
import { findUserById, type OrgRole } from '../domain/org/repository.js';
import { AppError } from '../errors.js';
import { verifyJwt } from '../utils/tokens.js';

export type AuthUser = { id: UserId; orgId: OrgId | null; orgRole: OrgRole };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// Authorization: Bearer <JWT>를 검증해 req.user를 붙인다.
// 인증 방식이 바뀌어도 교체 지점은 이 파일 하나다 — 라우트는 req.user와 orgIdOf()만 쓴다.
//
// 토큰은 신원(sub)만 증명한다. orgId·orgRole은 매 요청 DB에서 다시 읽는다 — 조직을 만들어
// MEMBER→REPRESENTATIVE가 된 직후에도 옛 토큰의 역할로 판정되지 않게 하기 위해서다.
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const match = req.header('Authorization')?.match(/^Bearer (\S+)$/);
    if (!match?.[1]) {
      throw new AppError('UNAUTHENTICATED', 'bearer token required');
    }
    req.user = await resolveUserToken(match[1]);
    next();
  } catch (err) {
    next(err);
  }
}

// 사람 토큰 검증. HTTP(authenticate)와 웹소켓(realtime/user-stream)이 같은 검증을 탄다 — 한쪽만 느슨해지지 않게.
export async function resolveUserToken(token: string): Promise<AuthUser> {
  const claims = verifyJwt(token, env.JWT_SECRET);
  // kind 검사가 없으면 에이전트 access token으로 사람 전용 API를 부를 수 있다.
  if (!claims || claims.kind !== 'user' || typeof claims.sub !== 'string') {
    throw new AppError('UNAUTHENTICATED', 'invalid or expired token');
  }
  const user = await findUserById(pool, claims.sub);
  if (!user) {
    throw new AppError('UNAUTHENTICATED', 'invalid or expired token');
  }
  return { id: user.id, orgId: user.orgId, orgRole: user.orgRole };
}

// 요청자의 조직 id. 아직 조직이 없으면 NOT_IN_ORG(403).
export function orgIdOf(req: Request): OrgId {
  if (!req.user) throw new AppError('UNAUTHENTICATED', 'authentication required');
  if (req.user.orgId === null) throw new AppError('NOT_IN_ORG', 'join or create an organization first');
  return req.user.orgId;
}

// URL의 :orgId가 요청자 소속 조직과 같은지 검사한다. 조직이 없는 사용자도 CROSS_ORG_ACCESS(403).
export function requireSameOrg(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new AppError('UNAUTHENTICATED', 'authentication required'));
    return;
  }
  const paramOrgId = req.params.orgId;
  if (paramOrgId !== undefined && paramOrgId !== req.user.orgId) {
    next(new AppError('CROSS_ORG_ACCESS', 'cannot access another organization'));
    return;
  }
  next();
}

export function requireRepresentative(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new AppError('UNAUTHENTICATED', 'authentication required'));
    return;
  }
  if (req.user.orgRole !== 'REPRESENTATIVE') {
    next(new AppError('NOT_REPRESENTATIVE', 'this action requires the organization representative'));
    return;
  }
  next();
}
