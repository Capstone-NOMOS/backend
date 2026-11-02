import { pool, withTransaction } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { appendEvent } from '../events/append.js';
import { EXPERIMENT_ACTOR } from '../experiment/attribution.js';
import { findProjectById } from '../project/repository.js';
import { afterAnswerCommitted, afterAnswerInTx } from './answer-effects.js';
import { findQuestion, markAutoAnswered, type AgentQuestion } from './repository.js';

// 실험 모드의 자동 답(033) — 질문 데이터를 최대한 모으려고, 사람을 기다리지 않고 **첫 번째 선택지**로 답해 실행을 끝까지 진행시킨다.
// 질문의 라우팅(primary)과 그림자 라우터 기록을 시도한 **뒤에** 답한다 — 답이 먼저 오면 라우팅 비교 데이터가 빈다.
// 선택지는 추천안이 맨 앞이라(기획 단계 질문 지침) 첫 번째가 "가장 그럴듯한 답"이다. 그래도 정답은 아니다 — 정답 라벨(gold)은 사람이 따로 붙인다.
// 대상이 PM이어도 대표 확정을 기다리지 않는다. 명의는 system:experiment, answerSource auto_first_option — 지표(사람 개입·답까지 걸린 시간)에서 이것으로 뺀다.

export { EXPERIMENT_ACTOR };
// 선택지가 없는 질문(구현 단계 AskUserQuestion은 선택지 없이도 온다)의 자동 답.
export const AUTO_ANSWER_NO_OPTION = '(실험 모드 자동 답 — 선택지가 없어 정해 줄 수 없다. 가장 합리적인 쪽으로 정하고 GOTCHA 노트로 남겨라)';

export function firstOptionAnswers(question: Pick<AgentQuestion, 'questions'>): Record<string, string> {
  return Object.fromEntries(question.questions.map((q) => [q.question, q.options[0]?.label ?? AUTO_ANSWER_NO_OPTION]));
}

const inflight = new Set<Promise<void>>();

// after: 라우팅 기록 작업(recordRouting). 실패해도 자동 답은 한다 — 실험이 멈추면 안 된다.
export function scheduleAutoAnswer(questionId: string, orgId: string, after: Promise<void>): void {
  const job = after
    .catch(() => undefined)
    .then(() => autoAnswer(questionId, orgId))
    .catch((err: unknown) => logger.warn('실험 모드 자동 답 실패', { questionId, error: String(err) }))
    .finally(() => inflight.delete(job));
  inflight.add(job);
}

// 테스트용.
export async function drainAutoAnswers(): Promise<void> {
  while (inflight.size > 0) await Promise.all([...inflight]);
}

// 주기 정리(experiment/sweep.ts)가 자동 답이 빠진 대기 질문에 다시 부른다 — 대기가 아니면 아무것도 하지 않는다.
export async function autoAnswer(questionId: string, orgId: string): Promise<void> {
  const question = await findQuestion(pool, questionId);
  if (!question || question.status !== 'pending') return;
  const project = await findProjectById(pool, question.projectId);
  if (!project) return;
  const answers = firstOptionAnswers(question);
  const result = await withTransaction(async (tx) => {
    if (!(await markAutoAnswered(tx, questionId, answers))) return null; // 그 사이 사람이 답했거나 만료
    const answered = (await findQuestion(tx, questionId))!;
    const effects = await afterAnswerInTx(tx, answered);
    await appendEvent(tx, {
      orgId,
      projectId: answered.projectId,
      type: 'QUESTION_ANSWERED',
      onBehalfOf: EXPERIMENT_ACTOR,
      policyHash: project.policyHash,
      payload: {
        auto: true,
        questionId,
        taskId: answered.taskId,
        stage: answered.stage,
        planId: answered.planId,
        contractId: answered.contractId,
        targetRole: answered.targetRole,
        answeredByRole: 'EXPERIMENT_AUTO',
        source: 'auto_first_option',
        resumedTask: effects.resumedTask,
        waitedMs: Date.parse(answered.answeredAt!) - Date.parse(answered.createdAt),
      },
    });
    return { projectId: answered.projectId, effects };
  });
  if (result) afterAnswerCommitted(result.projectId, result.effects);
}
