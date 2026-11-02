import type { PoolClient } from 'pg';
import { planningQuestionsSettled, type PlanningSubjectRef } from '../dispatch/planning-questions.js';
import { tasksChanged } from '../dispatch/tasks-changed.js';
import { unblockQuestionTask } from '../task/repository.js';
import { countPendingForTask, type AgentQuestion } from './repository.js';

// 답이 저장된 뒤 할 일 — 사람의 답·상담 초안의 답·실험 모드 자동 답이 같은 규칙을 탄다(한 벌).
//   implementation: 그 태스크에 대기 질문이 더 없으면 멈춘 태스크를 다시 잡을 수 있게 돌려놓는다(BLOCKED·QUESTION → READY).
//   feature_spec·contract: 태스크를 멈추지 않는다. 커밋 뒤 "그 초안의 질문에 답이 왔다" 신호를 낸다 — 대기가 남지 않았는지는
//   받는 쪽(pm/service.ts의 rewriteWithAnswers, contract/service.ts의 redraftWithAnswers)이 잠금 안에서 다시 센다.
//   여기서(답 저장 트랜잭션 안) 세면 동시에 커밋된 답끼리 서로를 대기로 보아 아무도 "다 답했다"를 내지 못한다(실험 모드 자동 답이 그랬다).
// 답을 저장한 트랜잭션 안에서 부르고, 돌려받은 것을 커밋 뒤 afterAnswerCommitted에 넘긴다.

export type AnswerEffects = { resumedTask: boolean; settled: PlanningSubjectRef | null };

export function subjectOf(question: AgentQuestion): PlanningSubjectRef | null {
  if (question.stage === 'feature_spec' && question.planId) return { kind: 'plan', planId: question.planId };
  if (question.stage === 'contract' && question.contractId) return { kind: 'contract', contractId: question.contractId };
  return null;
}

export async function afterAnswerInTx(tx: PoolClient, question: AgentQuestion): Promise<AnswerEffects> {
  if (question.stage === 'implementation') {
    if (!question.taskId || (await countPendingForTask(tx, question.taskId)) > 0) return { resumedTask: false, settled: null };
    return { resumedTask: await unblockQuestionTask(tx, question.taskId), settled: null };
  }
  return { resumedTask: false, settled: subjectOf(question) };
}

export function afterAnswerCommitted(projectId: string, effects: AnswerEffects): void {
  tasksChanged(projectId);
  if (effects.settled) planningQuestionsSettled(projectId, effects.settled);
}
