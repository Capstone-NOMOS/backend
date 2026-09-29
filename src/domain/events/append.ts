import type { PoolClient } from 'pg';
import type { EventPayloadMap, EventType } from './types.js';

export type AppendEventInput<T extends EventType = EventType> = {
  // 조직에 들기 전의 행동(가입·CLI 연결)은 null. 생략하지 못하게 해 호출부가 의식적으로 고르게 한다.
  orgId: string | null;
  projectId?: string;
  type: T;
  actorAgentId?: string;
  onBehalfOf: string; // user UUID 또는 'system:planner' 같은 명시적 시스템 주체 (P3, 절대 비울 수 없음)
  payload: EventPayloadMap[T];
  idempotencyKey?: string;

  // 실험 컬럼. payload가 아니라 열로 두는 이유는 M1~M6 집계가 jsonb 파싱 없이 돌아야 하기 때문이다.
  runId?: string;
  arm?: string;
  injectedFault?: string;
  policyHash?: string;
  tokenCost?: number;
  latencyMs?: number;
  pathViolation?: boolean;
  ownerRole?: string | null;
};

// events 테이블에 쓰는 유일한 경로. 반드시 상태 변경과 같은 트랜잭션(tx) 안에서 호출해야
// 상태만 바뀌고 이벤트가 누락되는 상황을 막을 수 있다 (P5).
export async function appendEvent<T extends EventType>(
  tx: PoolClient,
  e: AppendEventInput<T>,
): Promise<void> {
  await tx.query(
    `INSERT INTO events (org_id, project_id, type, actor_agent_id, on_behalf_of, payload, idempotency_key,
                         run_id, arm, injected_fault, policy_hash, token_cost, latency_ms, path_violation, owner_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      e.orgId,
      e.projectId ?? null,
      e.type,
      e.actorAgentId ?? null,
      e.onBehalfOf,
      JSON.stringify(e.payload),
      e.idempotencyKey ?? null,
      e.runId ?? null,
      e.arm ?? null,
      e.injectedFault ?? null,
      e.policyHash ?? null,
      e.tokenCost ?? null,
      e.latencyMs ?? null,
      e.pathViolation ?? null,
      e.ownerRole ?? null,
    ],
  );
}
