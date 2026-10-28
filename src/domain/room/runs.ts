import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { appendEvent } from '../events/append.js';
import type { AgentRunEndedPayload } from '../events/types.js';
import { findTaskById } from '../task/repository.js';
import { findRunOutcome, listDisconnectedAgentsWithOpenRuns, listOpenRunsOfAgent } from './repository.js';

// 실행 종료(AGENT_RUN_ENDED) payload 조립 한 벌 — Executor의 종료 보고(service.ts의 endRun)와 서버가 대신 닫는 경우(아래)가 같이 쓴다.
// 제출 여부는 서버가 정한다: 이 실행이 시작된 뒤 남은 이벤트(findRunOutcome)로 판정한다(실험 C1 — 종료 순간의 태스크 상태로 짐작하지 않는다).
export async function buildRunEndedPayload(
  tx: PoolClient,
  input: {
    taskId: string;
    agentId: string;
    startedEventId: string;
    attempt: number;
    outcome: AgentRunEndedPayload['outcome'];
    committed: boolean;
    durationMs: number;
    exitCode: number | null;
    taskState: string;
  },
): Promise<AgentRunEndedPayload> {
  const result = await findRunOutcome(tx, input.taskId, input.agentId, input.startedEventId);
  // 질문의 답을 기다리느라 내려놓았다(담당도 비었다) — 제출한 것도, 멈춘 것도 아니다.
  const waitingQuestion = !result.submitted && result.detachedForQuestion;
  return {
    taskId: input.taskId,
    attempt: input.attempt,
    outcome: input.outcome,
    committed: input.committed,
    durationMs: input.durationMs,
    exitCode: input.exitCode,
    submitted: result.submitted,
    taskState: input.taskState,
    ...(waitingQuestion ? { waitingQuestion: true } : {}),
  };
}

// 연결이 끊긴 에이전트의 열린 실행을 닫는다(outcome 'disconnected'). 연결 해제·조직 탈퇴(내보내기·탈퇴·해산)의 트랜잭션 안에서 부른다.
// 닫지 않으면 Executor의 종료 보고가 막힌 토큰 때문에 401이 되어, 그 실행이 서버에서 영원히 열려 있고 룸에 "생각 중"이 계속 올라간다.
// - 여기서는 task/stall.ts의 멈춤(AGENT_STOPPED·BLOCKED)을 하지 않는다. 연결 해제는 진행 중 태스크(CLAIMED·IN_PROGRESS·VERIFYING)가 없을 때만
//   되므로(assertNoActiveTasks — 조직 탈퇴·해산도 같은 규칙) 이 에이전트는 태스크를 잡고 있지 않다. 남는 것은 "실행은 시작했지만 아직 잡기 전"
//   같은 실행이고, 멈출 태스크가 없다.
// - committed는 알 수 없어 false, exitCode는 null(프로세스를 서버가 보지 못한다). durationMs는 시작 이벤트부터 지금까지.
// - 이미 닫힌 실행은 목록에 없다(태스크별 마지막 실행 이벤트가 ENDED) — 여러 번 불러도 한 번만 닫힌다.
export async function closeOpenRunsOfAgentInTx(tx: PoolClient, agentId: string, onBehalfOf: string): Promise<string[]> {
  const closed: string[] = [];
  for (const run of await listOpenRunsOfAgent(tx, agentId)) {
    const task = await findTaskById(tx, run.taskId);
    const payload = await buildRunEndedPayload(tx, {
      taskId: run.taskId,
      agentId,
      startedEventId: run.startedEventId,
      attempt: run.attempt,
      outcome: 'disconnected',
      committed: false,
      durationMs: Math.max(0, Date.now() - run.startedAt.getTime()),
      exitCode: null,
      taskState: task?.state ?? 'UNKNOWN',
    });
    await appendEvent(tx, {
      orgId: run.orgId,
      projectId: run.projectId,
      type: 'AGENT_RUN_ENDED',
      actorAgentId: agentId,
      onBehalfOf,
      ...(run.policyHash ? { policyHash: run.policyHash } : {}),
      payload,
    });
    closed.push(run.taskId);
  }
  return closed;
}

// 서버 시작 때 한 번 — 이 수정 전에 연결 해제된 에이전트의 열린 실행(고아 실행)을 닫는다. 명의는 그 에이전트의 주인이다.
// 운영 DB를 손으로 고치지 않고 배포만으로 남은 "생각 중"이 정리되게 하는 것이 목적이다. recoverInterruptedPlans와 같은 이유로
// startServer에서만 부른다(migrate 단계에서는 옛 서버가 아직 돌고 있을 수 있다). 여러 번 돌아도 같은 결과다.
export async function closeOrphanedRuns(): Promise<number> {
  let closed = 0;
  for (const agent of await listDisconnectedAgentsWithOpenRuns(pool)) {
    closed += (await withTransaction((tx) => closeOpenRunsOfAgentInTx(tx, agent.agentId, agent.userId))).length;
  }
  if (closed > 0) logger.info('closed orphaned agent runs of disconnected agents', { closed });
  return closed;
}
