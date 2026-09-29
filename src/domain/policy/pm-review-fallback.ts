import type { PoolClient } from 'pg';
import { appendEvent } from '../events/append.js';

export type PolicyMode = 'AUTO' | 'PM_REVIEW' | 'HUMAN' | 'FORBIDDEN';
export type PmUnavailableReason = 'pm_timeout' | 'budget_exhausted';

export type GateDecision = { gate: PolicyMode; degraded: boolean };

// PM이 응답하지 못할 때(타임아웃·예산 소진)의 판정.
// AUTO 강등은 PM_REVIEW 한 칸에만 적용한다 — PM이 게이트를 열 수 없듯, PM 장애가 게이트를 영원히
// 닫아서도 안 되기 때문이다. HUMAN·FORBIDDEN은 사람과 코드의 판정이라 PM 상태와 무관하게 절대 강등하지 않는다.
export function gateWhenPmUnavailable(mode: PolicyMode, lockedMode: PolicyMode | null): GateDecision {
  if (lockedMode !== null) return { gate: mode, degraded: false }; // 🔒 행은 강등 원천 제외
  if (mode === 'PM_REVIEW') return { gate: 'AUTO', degraded: true };
  return { gate: mode, degraded: false };
}

export type PmUnavailableInput = {
  orgId: string;
  projectId?: string;
  actorAgentId?: string;
  onBehalfOf: string; // 판정 대상 행동의 주인
  actionKey: string;
  mode: PolicyMode;
  lockedMode: PolicyMode | null;
  reason: PmUnavailableReason;
  policyHash: string;
  subjectId?: string; // task·artifact 등 판정 대상
};

// 강등이 일어나면 같은 트랜잭션에 PM_REVIEW_DEGRADED를 남긴다.
// 이게 없으면 "왜 PM 주석 없이 통과했나"를 리플레이로 복원할 수 없다.
export async function decideGateWithoutPm(tx: PoolClient, input: PmUnavailableInput): Promise<GateDecision> {
  const decision = gateWhenPmUnavailable(input.mode, input.lockedMode);
  if (decision.degraded) {
    await appendEvent(tx, {
      orgId: input.orgId,
      projectId: input.projectId,
      actorAgentId: input.actorAgentId,
      onBehalfOf: input.onBehalfOf,
      type: 'PM_REVIEW_DEGRADED',
      payload: {
        actionKey: input.actionKey,
        reason: input.reason,
        policyHash: input.policyHash,
        from: 'PM_REVIEW',
        to: 'AUTO',
        subjectId: input.subjectId ?? null,
      },
    });
  }
  return decision;
}
