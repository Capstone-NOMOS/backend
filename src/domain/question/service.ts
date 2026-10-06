import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors.js';
import { appendEvent } from '../events/append.js';
import { findAgentMembership } from '../policy/repository.js';
import { findProjectById, listProjectMembers } from '../project/repository.js';
import { assertProjectVisibleToUser, type UserContext } from '../project/visibility.js';
import type { TeamRole } from '../roles.js';
import { findTaskById } from '../task/repository.js';
import type { AgentContext } from '../task/service.js';
import {
  expireIfDue,
  findQuestion,
  insertQuestion,
  listQuestions,
  markAnswered,
  type AgentQuestion,
  type AskedQuestion,
  type QuestionStatus,
} from './repository.js';

// 에이전트 질문 중계(실험 — exp/question-relay).
//
// 실행 중인 에이전트가 다른 역할 소관의 결정을 AskUserQuestion으로 물으면, 브릿지의 권한 도구가 질문을 여기 올리고
// 답이 오거나 만료될 때까지 기다린다(그동안 에이전트 실행은 멈춰 있다). 답은 대상 역할의 사람이 한다 —
// 그 역할의 개발자가 결정을 알아야 하기 때문이다. 대표도 답할 수 있다.
//
// - 대상 역할은 서버가 정한다. 지금은 "묻는 쪽의 반대 역할"(역할이 둘뿐이다) — 결정 모델로 바꿀 자리이고, routed_by에 근거를 남긴다.
// - 답의 키는 질문 문장과 정확히 같아야 한다. 다르면 Claude Code가 "답하지 않음"으로 처리한다(실험 E3) — 그래서 여기서 막는다.
// - 만료는 읽을 때 판정한다. 만료되면 브릿지가 "커밋하지 말고 멈춰라"로 거부한다(실험 E4: 지시가 없으면 모델이 스스로 추측해 커밋했다).

const ROUTED_BY = 'role_rule:opposite';
const MAX_QUESTION_CHARS = 500;
const MAX_ANSWER_CHARS = 2000;

function oppositeRole(role: TeamRole): TeamRole {
  return role === 'FRONTEND' ? 'BACKEND' : 'FRONTEND';
}

type Violation = { where: string; message: string };

function validateQuestions(questions: AskedQuestion[]): Violation[] {
  const v: Violation[] = [];
  if (questions.length < 1 || questions.length > 4) v.push({ where: 'questions', message: '1~4개여야 한다' });
  const seen = new Set<string>();
  questions.forEach((q, i) => {
    const text = q.question?.trim() ?? '';
    if (!text) v.push({ where: `questions[${i}].question`, message: '비어 있다' });
    if (text.length > MAX_QUESTION_CHARS) v.push({ where: `questions[${i}].question`, message: `${MAX_QUESTION_CHARS}자를 넘는다` });
    if (seen.has(q.question)) v.push({ where: `questions[${i}].question`, message: '같은 질문이 두 번 있다(답의 키가 겹친다)' });
    seen.add(q.question);
  });
  return v;
}

function validateAnswers(question: AgentQuestion, answers: Record<string, string>): Violation[] {
  const v: Violation[] = [];
  const expected = new Set(question.questions.map((q) => q.question));
  for (const key of expected) {
    const value = answers[key];
    if (typeof value !== 'string' || !value.trim()) v.push({ where: key, message: '이 질문의 답이 없다' });
    else if (value.length > MAX_ANSWER_CHARS) v.push({ where: key, message: `${MAX_ANSWER_CHARS}자를 넘는다` });
  }
  for (const key of Object.keys(answers)) {
    if (!expected.has(key)) v.push({ where: key, message: '질문에 없는 키 — 질문 문장을 그대로 써야 한다' });
  }
  return v;
}

export async function askQuestion(ctx: AgentContext, taskId: string, questions: AskedQuestion[]): Promise<AgentQuestion> {
  const violations = validateQuestions(questions);
  if (violations.length > 0) throw new AppError('QUESTION_INVALID', 'invalid questions', violations);

  return withTransaction(async (tx) => {
    const membership = await findAgentMembership(tx, ctx.agentId);
    if (!membership || membership.projectId !== ctx.projectId) {
      throw new AppError('NOT_PROJECT_MEMBER', 'agent is not a member of this project');
    }
    const task = await findTaskById(tx, taskId);
    if (!task || task.projectId !== ctx.projectId) throw new AppError('TASK_NOT_FOUND', `task ${taskId} not found`);
    if (task.assigneeAgentId !== ctx.agentId) throw new AppError('NOT_TASK_ASSIGNEE', 'task is assigned to another agent');

    const targetRole = oppositeRole(membership.teamRole);
    const question = await insertQuestion(tx, {
      projectId: ctx.projectId,
      taskId,
      askedByAgentId: ctx.agentId,
      askerRole: membership.teamRole,
      targetRole,
      routedBy: ROUTED_BY,
      questions,
      timeoutMs: env.QUESTION_TIMEOUT_MS,
    });
    await appendEvent(tx, {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      type: 'QUESTION_ASKED',
      actorAgentId: ctx.agentId,
      onBehalfOf: ctx.onBehalfOf,
      policyHash: ctx.policyHash,
      payload: {
        questionId: question.id,
        taskId,
        askerRole: membership.teamRole,
        targetRole,
        routedBy: ROUTED_BY,
        questionCount: questions.length,
      },
    });
    return question;
  });
}

// 만료 시각이 지난 대기 질문을 만료로 바꾸고 이벤트를 남긴다. 만료는 아무도 하지 않은 일이라 시스템 명의다.
async function settleExpiry(question: AgentQuestion, orgId: string): Promise<AgentQuestion> {
  if (question.status !== 'pending' || Date.parse(question.expiresAt) > Date.now()) return question;
  return withTransaction(async (tx) => {
    if (await expireIfDue(tx, question.id)) {
      await appendEvent(tx, {
        orgId,
        projectId: question.projectId,
        type: 'QUESTION_EXPIRED',
        onBehalfOf: 'system:question-timeout',
        payload: { questionId: question.id, taskId: question.taskId, targetRole: question.targetRole },
      });
    }
    return (await findQuestion(tx, question.id))!;
  });
}

// 브릿지가 답을 기다리며 부른다. 묻은 에이전트만 본다.
export async function getQuestionForAgent(ctx: AgentContext, taskId: string, questionId: string): Promise<AgentQuestion> {
  const question = await findQuestion(pool, questionId);
  if (!question || question.taskId !== taskId || question.askedByAgentId !== ctx.agentId) {
    throw new AppError('QUESTION_NOT_FOUND', `question ${questionId} not found`);
  }
  return settleExpiry(question, ctx.orgId);
}

export async function listProjectQuestions(
  actor: UserContext,
  projectId: string,
  status: QuestionStatus | 'all',
  limit: number,
): Promise<AgentQuestion[]> {
  await assertProjectVisibleToUser(pool, actor, projectId);
  const questions = await listQuestions(pool, projectId, status, limit);
  return Promise.all(questions.map((q) => settleExpiry(q, actor.orgId)));
}

// 답은 대상 역할 담당(그 역할에 배정된 에이전트의 주인) 또는 대표가 한다.
export async function answerQuestion(actor: UserContext, questionId: string, answers: Record<string, string>): Promise<AgentQuestion> {
  const existing = await findQuestion(pool, questionId);
  if (!existing) throw new AppError('QUESTION_NOT_FOUND', `question ${questionId} not found`);
  const project = await findProjectById(pool, existing.projectId);
  if (!project || project.orgId !== actor.orgId) throw new AppError('CROSS_ORG_ACCESS', 'cannot access another organization');
  const current = await settleExpiry(existing, actor.orgId);
  if (current.status !== 'pending') throw new AppError('QUESTION_CLOSED', `question is already ${current.status}`);

  const members = await listProjectMembers(pool, current.projectId);
  const ownsTarget = members.some((m) => m.teamRole === current.targetRole && m.userId === actor.userId);
  const isRep = actor.orgRole === 'REPRESENTATIVE';
  if (!ownsTarget && !isRep) {
    throw new AppError('NOT_QUESTION_TARGET', `only the ${current.targetRole} owner or the representative can answer`);
  }
  const violations = validateAnswers(current, answers);
  if (violations.length > 0) throw new AppError('QUESTION_INVALID', 'invalid answers', violations);

  return withTransaction(async (tx) => {
    if (!(await markAnswered(tx, questionId, answers, actor.userId))) {
      throw new AppError('QUESTION_CLOSED', 'question was answered or expired concurrently');
    }
    const answered = (await findQuestion(tx, questionId))!;
    await appendEvent(tx, {
      orgId: actor.orgId,
      projectId: answered.projectId,
      type: 'QUESTION_ANSWERED',
      onBehalfOf: actor.userId,
      policyHash: project.policyHash,
      payload: {
        questionId,
        taskId: answered.taskId,
        targetRole: answered.targetRole,
        answeredByRole: ownsTarget ? 'TARGET_OWNER' : 'REPRESENTATIVE',
        waitedMs: Date.parse(answered.answeredAt!) - Date.parse(answered.createdAt),
      },
    });
    return answered;
  });
}
