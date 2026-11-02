import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { tasksChanged } from '../dispatch/tasks-changed.js';
import { appendEvent } from '../events/append.js';
import { autoAnswer } from '../question/auto-answer.js';
import { EXPERIMENT_ACTOR } from './attribution.js';
import { runExperimentAutopilot } from './autopilot.js';
import { blockVerifyingTask, listOpenExperimentProjects, listStalePendingQuestions, listStuckVerifying } from './repository.js';

// 무인 실험(034)의 주기 정리 — 신호로 풀리지 않는 멈춤을 정리한다. startServer에서만 건다(startStallWatchdog과 같은 자리 — 테스트 앱·migrate에는 걸지 않는다).
// 모든 쿼리가 question_mode = experiment로 거른다 — 기본 모드 프로젝트는 건드리지 않는다.
//   ① 대기 질문 다시 자동 답: EXPERIMENT_STALE_QUESTION_MS 넘게 pending(자동 답 작업이 실패했거나 그 사이 서버가 재시작했다)
//   ② VERIFYING 멈춤: 검증 보고(V2·V4)가 EXPERIMENT_VERIFYING_TIMEOUT_MS 넘게 없으면 BLOCKED(AGENT_STOPPED). 45분 감시(stall.ts)는
//      CLAIMED·IN_PROGRESS만 봐서 Executor가 보고 전에 꺼지면 VERIFYING이 영원히 남았다. 기본 모드는 사람이 보고 재개·직접 완료를 고른다.
//   ③ 자동 진행 다시 보기: 놓친 신호(서버 재시작 등)를 메운다.

export const VERIFYING_TIMEOUT_MESSAGE = '검증 보고가 오지 않음 — 실험 모드 정리';

export type ExperimentSweepResult = { reanswered: number; unstuck: number; autopilot: number };

export async function sweepExperiment(): Promise<ExperimentSweepResult> {
  let reanswered = 0;
  for (const q of await listStalePendingQuestions(pool, env.EXPERIMENT_STALE_QUESTION_MS)) {
    try {
      await autoAnswer(q.id, q.orgId);
      reanswered += 1;
    } catch (err) {
      logger.warn('실험 모드: 대기 질문 다시 자동 답 실패', { questionId: q.id, error: String(err) });
    }
  }

  let unstuck = 0;
  for (const s of await listStuckVerifying(pool, env.EXPERIMENT_VERIFYING_TIMEOUT_MS)) {
    const blocked = await withTransaction(async (tx) => {
      if (!(await blockVerifyingTask(tx, s.taskId, s.agentId))) return false;
      await appendEvent(tx, {
        orgId: s.orgId,
        projectId: s.projectId,
        type: 'TASK_BLOCKED',
        actorAgentId: s.agentId,
        onBehalfOf: EXPERIMENT_ACTOR,
        payload: { auto: true, taskId: s.taskId, reason: 'AGENT_STOPPED', cause: 'verification_timeout', agentId: s.agentId, lastMessage: VERIFYING_TIMEOUT_MESSAGE, deniedCommands: [] },
      });
      return true;
    });
    if (blocked) {
      unstuck += 1;
      tasksChanged(s.projectId);
    }
  }

  let autopilot = 0;
  for (const project of await listOpenExperimentProjects(pool)) {
    try {
      autopilot += await runExperimentAutopilot(project.id);
    } catch (err) {
      logger.warn('실험 모드: 주기 자동 진행 실패', { projectId: project.id, error: String(err) });
    }
  }
  return { reanswered, unstuck, autopilot };
}

export function startExperimentSweep(intervalMs = 60 * 1000): () => void {
  const timer = setInterval(() => {
    sweepExperiment().catch((err: unknown) => logger.warn('experiment sweep failed', { error: String(err) }));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
