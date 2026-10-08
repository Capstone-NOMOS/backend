import type { PoolClient } from 'pg';
import { logger } from '../../config/logger.js';
import { pool, withTransaction, type Queryable } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors.js';
import { appendEvent } from '../events/append.js';
import { findAgentMembership } from '../policy/repository.js';
import { findProjectById, listProjectMembers } from '../project/repository.js';
import { assertProjectVisibleToUser, type UserContext } from '../project/visibility.js';
import type { TeamRole } from '../roles.js';
import { findRepoById } from '../repo/repository.js';
import { tasksChanged } from '../dispatch/tasks-changed.js';
import { blockTaskForQuestion, escalateQuestionTask, findSpecForTask, findTaskById, unblockQuestionTask } from '../task/repository.js';
import { routeQuestion } from './router-registry.js';
import type { AgentContext } from '../task/service.js';
import {
  countPendingForTask,
  expireIfDue,
  findQuestion,
  insertQuestion,
  listQuestions,
  listRoleRepos,
  listUndraftedForRole,
  markAnsweredByHuman,
  saveDraft,
  type AgentQuestion,
  type AnswerSource,
  type AskedQuestion,
  type ConsultRepo,
  type QuestionDraft,
  listDueQuestions,
  listQuestionsForAnswerer,
  type QuestionStatus,
} from './repository.js';

// 에이전트 질문 중계(실험 — exp/question-relay).
//
// 실행 중인 에이전트가 다른 역할 소관의 결정을 AskUserQuestion으로 물으면, 브릿지의 권한 도구가 질문을 여기 올리고 정한 시간만 기다린다.
// 답은 두 길로 온다(C안):
//   ① 대상 역할 에이전트의 상담 실행(읽기 전용)이 초안을 올린다. 전부 코드·명세에 이미 정해진 것이면 그 답을 바로 쓴다(사람 미확인).
//   ② 아직 정해지지 않은 결정이면 대상 역할의 사람(또는 대표)이 답한다 — 그 역할의 개발자가 결정을 알아야 한다.
// 기다리는 시간이 지나면 태스크를 BLOCKED(QUESTION)로 내려놓고(detachFromQuestion), 답이 오면 READY로 돌려놓는다(resumeIfAnswered).
//
// - 대상 역할은 질문 라우터가 정한다(router.ts — 반대 역할 규칙·LLM·결정 모델을 바꿔 끼운다). routed_by·routing에 판정과 근거를 남긴다.
//   "묻는 쪽 자기 소관"(SELF)이면 넘기지 않고 self_owned로 돌려보낸다 — 브릿지가 "스스로 정하라"로 답한다.
//   라우터는 트랜잭션 밖에서 부른다(LLM이면 수 초가 걸린다 — 그동안 잠금을 쥐지 않는다).
// - 답의 키는 질문 문장과 정확히 같아야 한다. 다르면 Claude Code가 "답하지 않음"으로 처리한다(실험 E3) — 그래서 여기서 막는다.
// - 만료(기본 3일)는 읽을 때 판정한다. 그 질문으로 멈춘 태스크는 ESCALATED — 사람이 봐야 한다.
// - 답을 기다리다 내려놓을 때 브릿지는 "커밋하지 말고 멈춰라"로 거부한다(실험 E4: 지시가 없으면 모델이 스스로 추측해 커밋했다).

const MAX_QUESTION_CHARS = 500;
const MAX_ANSWER_CHARS = 2000;

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

  // 권한 확인과 라우팅 맥락 — 라우터를 부르기 전에 막을 것은 막는다(남의 태스크로 라우터 비용을 쓰지 않게).
  const assertAsker = async (db: Queryable) => {
    const membership = await findAgentMembership(db, ctx.agentId);
    if (!membership || membership.projectId !== ctx.projectId) {
      throw new AppError('NOT_PROJECT_MEMBER', 'agent is not a member of this project');
    }
    const task = await findTaskById(db, taskId);
    if (!task || task.projectId !== ctx.projectId) throw new AppError('TASK_NOT_FOUND', `task ${taskId} not found`);
    if (task.assigneeAgentId !== ctx.agentId) throw new AppError('NOT_TASK_ASSIGNEE', 'task is assigned to another agent');
    return { membership, task };
  };
  const { membership, task } = await assertAsker(pool);
  const project = await findProjectById(pool, ctx.projectId);
  if (project?.questionRelay === false) {
    throw new AppError('QUESTION_RELAY_OFF', 'question relay is off for this project — record the assumption as a GOTCHA note and continue');
  }
  const [spec, repo, members] = await Promise.all([
    task.specId ? findSpecForTask(pool, task.specId) : Promise.resolve(null),
    findRepoById(pool, task.repoId),
    listProjectMembers(pool, ctx.projectId),
  ]);
  const routed = await routeQuestion({
    askerRole: membership.teamRole,
    roles: [...new Set<TeamRole>([membership.teamRole, ...members.map((m) => m.teamRole)])],
    task: { title: task.title, kind: task.kind },
    spec: spec ? { featureKey: spec.featureKey, title: spec.title, content: spec.content } : null,
    repo: repo ? { fullName: repo.fullName } : null,
    questions,
  });
  const selfOwned = routed.target === 'SELF';
  const targetRole: TeamRole = selfOwned ? membership.teamRole : (routed.target as TeamRole);
  const routing = { confidence: routed.confidence, reason: routed.reason, latencyMs: routed.latencyMs, fallback: routed.fallback };

  const created = await withTransaction(async (tx) => {
    await assertAsker(tx);
    const question = await insertQuestion(tx, {
      projectId: ctx.projectId,
      taskId,
      askedByAgentId: ctx.agentId,
      askerRole: membership.teamRole,
      targetRole,
      routedBy: routed.routedBy,
      routing,
      status: selfOwned ? 'self_owned' : 'pending',
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
        targetRole: selfOwned ? 'SELF' : targetRole,
        routedBy: routed.routedBy,
        confidence: routed.confidence,
        latencyMs: routed.latencyMs,
        fallback: routed.fallback,
        questionCount: questions.length,
      },
    });
    return question;
  });
  // 커밋 뒤 — 대상 역할 에이전트의 스트림이 깨어나 상담 실행을 맡는다(태스크 스냅샷과 같은 신호를 쓴다).
  if (created.status === 'pending') tasksChanged(ctx.projectId);
  return created;
}

// 만료 시각이 지난 대기 질문을 만료로 바꾸고 이벤트를 남긴다. 만료는 아무도 하지 않은 일이라 시스템 명의다.
// 그 질문 때문에 멈춘 태스크는 ESCALATED로 올린다 — 더 기다려도 답할 사람이 없다는 뜻이라 사람이 봐야 한다.
async function settleExpiry(question: AgentQuestion, orgId: string): Promise<AgentQuestion> {
  if (question.status !== 'pending' || Date.parse(question.expiresAt) > Date.now()) return question;
  let changed = false;
  const result = await withTransaction(async (tx) => {
    if (await expireIfDue(tx, question.id)) {
      changed = true;
      const escalated = await escalateQuestionTask(tx, question.taskId);
      await appendEvent(tx, {
        orgId,
        projectId: question.projectId,
        type: 'QUESTION_EXPIRED',
        onBehalfOf: 'system:question-timeout',
        payload: { questionId: question.id, taskId: question.taskId, targetRole: question.targetRole, escalated },
      });
    }
    return (await findQuestion(tx, question.id))!;
  });
  if (changed) tasksChanged(question.projectId);
  return result;
}

// 주기 정리: 만료는 원래 질문을 읽을 때 처리되는데(settleExpiry), 아무도 읽지 않으면 묻는 쪽 태스크가 "답을 기다림"에 영원히 남는다.
// 그래서 서버가 주기적으로 지난 질문을 만료시키고 그 태스크를 ESCALATED로 올린다. startServer에서만 건다(테스트·migrate에는 걸지 않는다).
export async function sweepExpiredQuestions(): Promise<number> {
  const due = await listDueQuestions(pool);
  for (const d of due) await settleExpiry(d.question, d.orgId);
  return due.length;
}

export function startQuestionExpirySweep(intervalMs = 10 * 60 * 1000): () => void {
  const timer = setInterval(() => {
    sweepExpiredQuestions().catch((err: unknown) => logger.warn('question expiry sweep failed', { error: String(err) }));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// 이 태스크에 대기 중인 질문이 더 없으면 멈춘 태스크를 다시 잡을 수 있게 돌려놓는다. 답을 저장한 트랜잭션 안에서 부른다.
async function resumeIfAnswered(tx: PoolClient, taskId: string): Promise<boolean> {
  if ((await countPendingForTask(tx, taskId)) > 0) return false;
  return unblockQuestionTask(tx, taskId);
}

// 브릿지가 답을 기다리며 부른다. 묻은 에이전트만 본다.
export async function getQuestionForAgent(ctx: AgentContext, taskId: string, questionId: string): Promise<AgentQuestion> {
  const question = await findQuestion(pool, questionId);
  if (!question || question.taskId !== taskId || question.askedByAgentId !== ctx.agentId) {
    throw new AppError('QUESTION_NOT_FOUND', `question ${questionId} not found`);
  }
  return settleExpiry(question, ctx.orgId);
}

// 브릿지가 정한 시간만큼 기다렸는데 답이 없다 — 태스크를 내려놓는다(BLOCKED·QUESTION). 에이전트 실행은 커밋 없이 끝나고
// 노트북은 다른 태스크로 간다. 답이 오면 resumeIfAnswered가 READY로 돌려놓는다. 그 사이 답이 왔으면 아무것도 하지 않고 돌려준다.
export async function detachFromQuestion(ctx: AgentContext, taskId: string, questionId: string): Promise<AgentQuestion> {
  const current = await getQuestionForAgent(ctx, taskId, questionId);
  if (current.status !== 'pending') return current;
  const blocked = await withTransaction(async (tx) => {
    if (!(await blockTaskForQuestion(tx, taskId, ctx.agentId))) return false;
    await appendEvent(tx, {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      type: 'TASK_BLOCKED_ON_QUESTION',
      actorAgentId: ctx.agentId,
      onBehalfOf: ctx.onBehalfOf,
      policyHash: ctx.policyHash,
      payload: { taskId, questionId, targetRole: current.targetRole },
    });
    return true;
  });
  if (blocked) tasksChanged(ctx.projectId);
  return (await findQuestion(pool, questionId))!;
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

// 내가 답할 질문(조직 전체) — 알림 배지와 "답할 질문" 목록. 대표는 전부, 팀원은 자기 에이전트가 맡은 역할을 대상으로 한 것만.
// 만료 시각이 지난 대기 질문은 목록을 읽는 순간 만료로 정리한다(프로젝트 목록과 같은 규칙).
export async function listMyQuestions(
  actor: UserContext,
  status: QuestionStatus | 'all',
  limit: number,
): Promise<{ question: AgentQuestion; projectName: string; taskTitle: string }[]> {
  const rows = await listQuestionsForAnswerer(pool, {
    orgId: actor.orgId,
    userId: actor.userId,
    isRepresentative: actor.orgRole === 'REPRESENTATIVE',
    status,
    limit,
  });
  const settled = await Promise.all(rows.map(async (r) => ({ ...r, question: await settleExpiry(r.question, actor.orgId) })));
  // 읽는 사이 만료된 것은 대기 목록에서 뺀다.
  return status === 'all' ? settled : settled.filter((r) => r.question.status === status);
}

// 상담 실행이 맡을 질문과 읽을 레포 — 대상 역할 에이전트의 Executor가 묻는다.
export async function listConsultJobs(ctx: AgentContext): Promise<{ questions: AgentQuestion[]; repos: ConsultRepo[] }> {
  const membership = await findAgentMembership(pool, ctx.agentId);
  if (!membership || membership.projectId !== ctx.projectId) throw new AppError('NOT_PROJECT_MEMBER', 'agent is not a member of this project');
  const [questions, repos] = await Promise.all([
    listUndraftedForRole(pool, ctx.projectId, membership.teamRole),
    listRoleRepos(pool, ctx.projectId, membership.teamRole),
  ]);
  return { questions, repos };
}

// 상담 실행의 초안. 질문 전부가 코드·명세에 이미 정해져 있으면(decided) 초안이 곧 답이다 — 묻는 쪽에 바로 간다(사람 미확인).
// 하나라도 아니면 초안은 사람에게 보여 줄 참고로만 남고 질문은 대기한다. 초안은 한 번만 받는다.
export async function submitDraft(ctx: AgentContext, questionId: string, draft: QuestionDraft): Promise<AgentQuestion> {
  const question = await findQuestion(pool, questionId);
  if (!question || question.projectId !== ctx.projectId) throw new AppError('QUESTION_NOT_FOUND', `question ${questionId} not found`);
  const membership = await findAgentMembership(pool, ctx.agentId);
  if (!membership || membership.projectId !== ctx.projectId || membership.teamRole !== question.targetRole) {
    throw new AppError('NOT_QUESTION_TARGET', `only the ${question.targetRole} agent can draft an answer`);
  }
  const violations = [
    ...validateAnswers(question, draft.answers),
    ...question.questions.filter((q) => typeof draft.decided[q.question] !== 'boolean').map((q) => ({ where: q.question, message: 'decided가 없다' })),
  ];
  if (violations.length > 0) throw new AppError('QUESTION_INVALID', 'invalid draft', violations);

  const autoAnswered = question.questions.every((q) => draft.decided[q.question] === true);
  const project = (await findProjectById(pool, question.projectId))!;
  const result = await withTransaction(async (tx) => {
    if (!(await saveDraft(tx, questionId, draft, ctx.agentId, autoAnswered))) {
      throw new AppError('QUESTION_CLOSED', 'question is no longer waiting for a draft');
    }
    const resumedTask = autoAnswered ? await resumeIfAnswered(tx, question.taskId) : false;
    await appendEvent(tx, {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      type: 'QUESTION_DRAFTED',
      actorAgentId: ctx.agentId,
      onBehalfOf: ctx.onBehalfOf,
      policyHash: project.policyHash,
      payload: {
        questionId,
        taskId: question.taskId,
        decidedCount: question.questions.filter((q) => draft.decided[q.question] === true).length,
        questionCount: question.questions.length,
        autoAnswered,
        resumedTask,
      },
    });
    return (await findQuestion(tx, questionId))!;
  });
  tasksChanged(ctx.projectId);
  return result;
}

// 답은 대상 역할 담당(그 역할에 배정된 에이전트의 주인) 또는 대표가 한다.
// 대기 중이면 직접 답(human). 에이전트가 이미 답했으면(agent_answered) 같은 답이면 확인(agent_confirmed), 다르면 뒤집기(human_override).
export async function answerQuestion(actor: UserContext, questionId: string, answers: Record<string, string>): Promise<AgentQuestion> {
  const existing = await findQuestion(pool, questionId);
  if (!existing) throw new AppError('QUESTION_NOT_FOUND', `question ${questionId} not found`);
  const project = await findProjectById(pool, existing.projectId);
  if (!project || project.orgId !== actor.orgId) throw new AppError('CROSS_ORG_ACCESS', 'cannot access another organization');
  const current = await settleExpiry(existing, actor.orgId);
  if (current.status !== 'pending' && current.status !== 'agent_answered') {
    throw new AppError('QUESTION_CLOSED', `question is already ${current.status}`);
  }

  const members = await listProjectMembers(pool, current.projectId);
  const ownsTarget = members.some((m) => m.teamRole === current.targetRole && m.userId === actor.userId);
  const isRep = actor.orgRole === 'REPRESENTATIVE';
  if (!ownsTarget && !isRep) {
    throw new AppError('NOT_QUESTION_TARGET', `only the ${current.targetRole} owner or the representative can answer`);
  }
  const violations = validateAnswers(current, answers);
  if (violations.length > 0) throw new AppError('QUESTION_INVALID', 'invalid answers', violations);

  const from = current.status;
  const sameAsAgent = current.questions.every((q) => current.answers?.[q.question] === answers[q.question]);
  const source: AnswerSource = from === 'pending' ? 'human' : sameAsAgent ? 'agent_confirmed' : 'human_override';

  const result = await withTransaction(async (tx) => {
    if (!(await markAnsweredByHuman(tx, questionId, from, answers, source, actor.userId))) {
      throw new AppError('QUESTION_CLOSED', 'question was answered or expired concurrently');
    }
    const answered = (await findQuestion(tx, questionId))!;
    const resumedTask = from === 'pending' ? await resumeIfAnswered(tx, answered.taskId) : false;
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
        source,
        resumedTask,
        waitedMs: Date.parse(answered.answeredAt!) - Date.parse(answered.createdAt),
        // 에이전트 답을 뒤집었다 — 묻는 쪽이 이미 그 답으로 구현했을 수 있다. 고치는 태스크를 자동으로 만드는 경로는 아직 없다.
        ...(source === 'human_override' ? { notice: 'REWORK_NOT_IMPLEMENTED' as const } : {}),
      },
    });
    return answered;
  });
  tasksChanged(result.projectId);
  return result;
}
