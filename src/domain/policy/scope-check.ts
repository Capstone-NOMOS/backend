import type { PoolClient } from 'pg';
import { appendEvent } from '../events/append.js';
import type { DenialStage, PathDenialReason } from '../events/types.js';
import { matchingRules } from '../repo/glob.js';
import type { RepoPath } from '../repo/types.js';
import type { TeamRole } from '../roles.js';
import { getPolicySnapshot } from './policy-cache.js';
import type { PolicyMode } from './pm-review-fallback.js';
import { findAgentMembership } from './repository.js';

// 경로 규칙에 action_key가 없으면 "자기 경로 수정"으로 읽는다 (004 이후의 해석).
const DEFAULT_ACTION_KEY = 'code:own_path';

const STRICTNESS: Record<PolicyMode, number> = { AUTO: 0, PM_REVIEW: 1, HUMAN: 2, FORBIDDEN: 3 };

// 한 산출물이 여러 칸에 걸리면 가장 엄격한 판정을 적용한다.
export function strictestMode(modes: PolicyMode[]): PolicyMode {
  return modes.reduce<PolicyMode>((worst, m) => (STRICTNESS[m] > STRICTNESS[worst] ? m : worst), 'AUTO');
}

export type PathDenial = {
  stage: DenialStage;
  detail: string;
  path: string;
  ownerRole: string | null;
  pathViolation: boolean;
  // 집계용 구분. stage만으로는 소유자 없음과 남의 소유가 갈리지 않는다(PathDenialReason 주석).
  reason: PathDenialReason;
};

export type PathInspection = { ok: true; actionKeys: string[] } | ({ ok: false } & PathDenial);

// 한 경로의 판정 재료. 접근·행동 키는 가장 높은 행(rule)에서, 소유 역할은 **owner가 지정된 가장 높은 행**
// (ownerRule)에서 가져온다 — 소유 역할 상속(docs/construction.md §3.0 B-2).
//
// 상속이 필요한 이유: 시드는 `**`만 대표가 소유 역할을 정하고 tests/**·migrations/** 같은 행은 owner가 NULL이다.
// 그 행들이 priority가 높아 이기므로, 이긴 행의 owner만 보면 그 파일은 "아무도 못 쓰거나"(NULL=거부로 읽을 때)
// "누구나 쓸 수 있다"(NULL=허용으로 읽을 때). 예전 구현이 후자였고 B-2(기본 거부)를 어겼다.
export type PathPolicy = { rule: RepoPath; ownerRule: RepoPath | null };

export function resolvePathPolicy(rules: RepoPath[], path: string): PathPolicy | null {
  const matched = matchingRules(rules, path);
  const rule = matched[0];
  if (!rule) return null;
  return { rule, ownerRule: matched.find((r) => r.ownerRole !== null) ?? null };
}

// 3·4단계. 경로마다 규칙을 한 번만 풀고 그 규칙의 access로 금지와 소유권을 함께 판정한다.
// 소유권을 먼저 보면 .env(owner_role NULL)가 scope:violation으로 잘못 기록되어 M5′ 분자가 오염된다.
//
// 소유권은 **쓰기에만** 적용한다. B-2는 "누가 쓸 수 있는가"의 원칙이고, 읽기 전용(contracts/**)은 누구나 읽는다.
// 운영 호출부(제출·V3)는 전부 쓰기다.
//
// 통과하면 걸린 행동 키들을 돌려준다 — submit_artifact가 triggered_actions로 고정할 값이다.
export function inspectPaths(
  rules: RepoPath[],
  paths: string[],
  teamRole: TeamRole,
  write: boolean,
): PathInspection {
  const actionKeys = new Set<string>();

  for (const path of paths) {
    const policy = resolvePathPolicy(rules, path);
    if (!policy) {
      // '**' 시드가 항상 매칭되므로 여기 오면 시드가 빠진 레포다. 열지 않고 닫는다.
      return { ok: false, stage: 'ownership', detail: 'no matching path rule', path, ownerRole: null, pathViolation: false, reason: 'no_rule' };
    }
    const { rule, ownerRule } = policy;
    if (rule.access === 'denied') {
      return {
        ok: false,
        stage: 'forbidden_path',
        detail: `${rule.pathPattern} is denied`,
        path,
        ownerRole: rule.ownerRole,
        pathViolation: false,
        reason: 'denied_path',
      };
    }
    if (rule.access === 'read' && write) {
      return {
        ok: false,
        stage: 'ownership',
        detail: `${rule.pathPattern} is read-only`,
        path,
        ownerRole: rule.ownerRole,
        pathViolation: false,
        reason: 'read_only',
      };
    }
    if (write) {
      if (ownerRule === null) {
        // 기본 거부(B-2). 아무도 소유하지 않은 경로는 아무도 쓸 수 없다. 남의 영역을 침범한 게 아니라
        // 소유권이 정해지지 않은 상태이므로 path_violation은 아니다 — 섞으면 M5′ 분자가 오염된다.
        return {
          ok: false,
          stage: 'ownership',
          detail: `${path}: no owner role assigned (default deny) — set the owner of '**' or a covering rule`,
          path,
          ownerRole: null,
          pathViolation: false,
          reason: 'unowned', // 온보딩 소유권 지정 누락 — 따로 센다
        };
      }
      if (ownerRule.ownerRole !== teamRole) {
        return {
          ok: false,
          stage: 'ownership',
          detail: `${ownerRule.pathPattern} belongs to ${ownerRule.ownerRole}`,
          path,
          ownerRole: ownerRule.ownerRole,
          pathViolation: true, // M5′ 집계가 읽는 열
          reason: 'owned_by_other',
        };
      }
    }
    actionKeys.add(rule.actionKey ?? DEFAULT_ACTION_KEY);
  }

  return { ok: true, actionKeys: [...actionKeys].sort() };
}

export type ActionAttempt = {
  agentId: string;
  onBehalfOf: string;
  orgId: string;
  projectId: string;
  policyHash: string;
  actionKey: string;
  repoId: string;
  paths: string[];
  write?: boolean; // 기본 true. read 전용 경로를 읽기만 할 때는 false
};

export type ScopeDecision =
  | { ok: true; gate: PolicyMode; teamRole: TeamRole }
  | { ok: false; stage: DenialStage; detail: string; path: string | null };

export type DenyInput = {
  orgId: string;
  projectId: string;
  agentId: string;
  onBehalfOf: string;
  policyHash: string;
  actionKey: string;
  repoId: string | null;
  stage: DenialStage;
  detail: string;
  path?: string | null;
  ownerRole?: string | null;
  memberRole?: TeamRole | null;
  pathViolation?: boolean;
  // 경로 판정 거부의 구분. 소유자 없음(unowned)을 M5′와 분리해 셀 수 있게 payload에 남긴다.
  reason?: PathDenialReason;
};

// 거부는 전부 여기를 지난다. 통과만 기록하면 "무엇이 차단됐는가"(M5′의 분모)가 사라진다.
export async function recordToolDenied(tx: PoolClient, input: DenyInput): Promise<void> {
  await appendEvent(tx, {
    orgId: input.orgId,
    projectId: input.projectId,
    type: 'TOOL_DENIED',
    actorAgentId: input.agentId,
    onBehalfOf: input.onBehalfOf,
    policyHash: input.policyHash,
    pathViolation: input.pathViolation ?? false,
    ownerRole: input.ownerRole ?? null,
    payload: {
      stage: input.stage,
      actionKey: input.actionKey,
      repoId: input.repoId,
      path: input.path ?? null,
      memberRole: input.memberRole ?? null,
      detail: input.detail,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
  });
}

// 검증 파이프라인 2~5단계. 0a(정지)·0b(정책 신선도)·1(서명)은 요청이 여기 닿기 전에
// 미들웨어가 끝낸다 — 클레임을 읽으려면 서명 검증이 물리적으로 먼저여야 하기 때문이다.
export async function checkScope(tx: PoolClient, attempt: ActionAttempt): Promise<ScopeDecision> {
  const write = attempt.write ?? true;

  const deny = async (
    stage: DenialStage,
    detail: string,
    extra: {
      path?: string;
      ownerRole?: string | null;
      memberRole?: TeamRole | null;
      pathViolation?: boolean;
      reason?: PathDenialReason;
    } = {},
  ): Promise<ScopeDecision> => {
    await recordToolDenied(tx, { ...attempt, stage, detail, ...extra });
    return { ok: false, stage, detail, path: extra.path ?? null };
  };

  // 2단계 — 스코프. 이 에이전트가 이 프로젝트의 멤버인지, 그 행동의 판정이 무엇인지.
  const membership = await findAgentMembership(tx, attempt.agentId);
  if (!membership || membership.projectId !== attempt.projectId) {
    return deny('membership', 'agent is not a member of this project');
  }
  const teamRole = membership.teamRole;

  const snapshot = await getPolicySnapshot(tx, attempt.projectId, attempt.policyHash);
  const policy = snapshot.policies.find((p) => p.actionKey === attempt.actionKey);
  // 정책 사본에 없는 행동은 닫는다. 모르는 행동을 열어주면 카탈로그에 없는 도구가 곧 통로가 된다.
  if (!policy) {
    return deny('unknown_action', `no policy row for ${attempt.actionKey}`, { memberRole: teamRole });
  }
  if (policy.mode === 'FORBIDDEN') {
    return deny('forbidden_action', `${attempt.actionKey} is FORBIDDEN at this level`, { memberRole: teamRole });
  }

  // 3·4단계
  const rules = snapshot.repoPaths.filter((p) => p.repoId === attempt.repoId);
  const verdict = inspectPaths(rules, attempt.paths, teamRole, write);
  if (!verdict.ok) {
    return deny(verdict.stage, verdict.detail, {
      path: verdict.path,
      ownerRole: verdict.ownerRole,
      memberRole: teamRole,
      pathViolation: verdict.pathViolation,
      reason: verdict.reason,
    });
  }

  // 5단계 — 계약 LOCK 침범(G2). contracts 테이블이 아직 없어 자리만 둔다.
  // 통과시키는 게 아니라 "검사할 대상이 없다"는 뜻이며, contracts가 생기면 여기서 막는다.

  return { ok: true, gate: policy.mode, teamRole };
}
