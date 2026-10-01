import type { NextFunction, Request, Response } from 'express';
import { pool, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { findAgentById } from '../domain/agent/repository.js';
import { appendEvent } from '../domain/events/append.js';
import type { DenialStage } from '../domain/events/types.js';
import { findProjectAuthRow } from '../domain/policy/repository.js';
import { AppError } from '../errors.js';
import { authenticate } from './auth.js';
import type { AgentContext } from '../domain/task/service.js';
import { verifyJwt } from '../utils/tokens.js';

export type AuthAgent = {
  id: string;
  onBehalfOf: string;
  orgId: string | null;
  projectId: string | null;
  policyHash: string | null;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agent?: AuthAgent;
    }
  }
}

// 0a·0b 거부도 기록한다. 차단된 요청이 남지 않으면 M5′의 분모가 사라진다.
async function recordDenial(agent: AuthAgent, stage: DenialStage, detail: string): Promise<void> {
  await withTransaction((tx) =>
    appendEvent(tx, {
      orgId: agent.orgId,
      projectId: agent.projectId ?? undefined,
      type: 'TOOL_DENIED',
      actorAgentId: agent.id,
      onBehalfOf: agent.onBehalfOf,
      policyHash: agent.policyHash ?? undefined,
      pathViolation: false,
      payload: { stage, actionKey: '-', repoId: null, path: null, memberRole: null, detail },
    }),
  );
}

// 에이전트 access token 검증. 사람 토큰의 authenticate와 분리되어 있다 —
// 두 토큰은 클레임도 다르고 통과시켜야 할 대상도 다르다.
//
// 토큰에는 신원만 들어 있다. 권한(scopes·denied)은 넣지 않는다: 대표가 금지 경로를 추가해도
// 만료 전까지 옛 권한으로 도는 상황을 만들지 않기 위해서다. 대신 policy_hash를 실어
// "이 토큰이 어느 정책 스냅샷 기준인가"를 매 요청 대조한다.
export async function authenticateAgent(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const match = req.header('Authorization')?.match(/^Bearer (\S+)$/);
    if (!match?.[1]) {
      throw new AppError('UNAUTHENTICATED', 'bearer token required');
    }
    req.agent = await resolveAgentToken(match[1]);
    next();
  } catch (err) {
    next(err);
  }
}

// 토큰 → 에이전트(1단계 서명 → 재조회 → 0a 정지 → 0b 정책 신선도).
// HTTP(authenticateAgent)와 웹소켓(realtime/agent-stream)이 같은 검증을 탄다 — 한쪽만 느슨해지지 않게.
export async function resolveAgentToken(token: string): Promise<AuthAgent> {
  {
    // 1단계 — 서명·만료. 클레임을 읽으려면 이게 물리적으로 먼저여야 한다.
    const claims = verifyJwt(token, env.JWT_SECRET);
    if (!claims || claims.kind !== 'agent' || typeof claims.sub !== 'string') {
      throw new AppError('UNAUTHENTICATED', 'invalid or expired token');
    }

    // 에이전트를 DB에서 다시 읽는다. 사람 경로(authenticate)가 orgId·orgRole을 매 요청 읽는 것과 같은 이유다:
    // 지워진 에이전트의 토큰이 만료까지 사는 것과, 조직 가입 뒤에도 토큰의 옛 org_id가 쓰이는 것을 막는다.
    const row = await findAgentById(pool, claims.sub);
    if (!row) {
      throw new AppError('UNAUTHENTICATED', 'invalid or expired token');
    }
    // 책임 귀속(on_behalf_of)이 실제 소유자와 어긋난 토큰은 받지 않는다 — P3가 무너진다.
    if (claims.on_behalf_of !== row.userId) {
      throw new AppError('UNAUTHENTICATED', 'invalid or expired token');
    }

    const agent: AuthAgent = {
      id: row.id,
      onBehalfOf: row.userId,
      orgId: row.orgId, // 토큰이 아니라 DB가 정본
      projectId: typeof claims.project_id === 'string' ? claims.project_id : null,
      policyHash: typeof claims.policy_hash === 'string' ? claims.policy_hash : null,
    };

    if (agent.projectId) {
      const project = await findProjectAuthRow(pool, agent.projectId);
      if (!project) {
        throw new AppError('UNAUTHENTICATED', 'invalid or expired token');
      }

      // 0a — 정지된 프로젝트는 전부 거부한다. 멈춤은 명령이 아니라 상태이므로
      // 이미 발급된 토큰이 살아 있어도 여기서 막힌다.
      if (project.status === 'halted') {
        await recordDenial(agent, 'halted', 'project is halted');
        throw new AppError('PROJECT_HALTED', 'project is halted');
      }

      // 0b — 토큰이 옛 정책 기준이면 거부한다. 브릿지는 refresh로 재발급받아 1회만 재시도한다.
      if (project.policyHash !== agent.policyHash) {
        await recordDenial(agent, 'policy_stale', 'token was issued against an older policy snapshot');
        throw new AppError('POLICY_STALE', 'policy snapshot changed; refresh the token', {
          reason: 'policy_stale',
        });
      }
    }

    return agent;
  }
}

// 프로젝트에 배정되기 전의 에이전트는 태스크·노트 도구를 쓸 수 없다.
// 토큰의 project_id·policy_hash가 비어 있다는 건 아직 아무 프로젝트에도 안 들어갔다는 뜻이다.
export function agentContextOf(req: Request): AgentContext {
  const agent = req.agent;
  if (!agent) throw new AppError('UNAUTHENTICATED', 'agent authentication required');
  return agentContextFrom(agent);
}

export function agentContextFrom(agent: AuthAgent): AgentContext {
  if (!agent.orgId || !agent.projectId || !agent.policyHash) {
    throw new AppError('NOT_PROJECT_MEMBER', 'agent is not assigned to a project');
  }
  return {
    agentId: agent.id,
    onBehalfOf: agent.onBehalfOf,
    orgId: agent.orgId,
    projectId: agent.projectId,
    policyHash: agent.policyHash,
  };
}

// 사람 토큰과 에이전트 토큰을 모두 받는 엔드포인트용. 조회처럼 양쪽이 같이 쓰는 자리에만 붙인다.
// kind를 먼저 보고 해당 검증기로 넘긴다 — 에이전트 토큰이면 0a·0b도 그대로 탄다.
export async function authenticateAny(req: Request, res: Response, next: NextFunction): Promise<void> {
  const match = req.header('Authorization')?.match(/^Bearer (\S+)$/);
  if (!match?.[1]) {
    next(new AppError('UNAUTHENTICATED', 'bearer token required'));
    return;
  }
  const claims = verifyJwt(match[1], env.JWT_SECRET);
  if (!claims) {
    next(new AppError('UNAUTHENTICATED', 'invalid or expired token'));
    return;
  }
  if (claims.kind === 'agent') {
    await authenticateAgent(req, res, next);
    return;
  }
  await authenticate(req, res, next);
}
