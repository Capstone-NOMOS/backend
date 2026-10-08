import { Router, type Request } from 'express';
import { z } from 'zod';
import { answerQuestion, askQuestion, detachFromQuestion, getQuestionForAgent, listConsultJobs, listProjectQuestions, submitDraft, listMyQuestions } from '../domain/question/service.js';
import type { UserContext } from '../domain/project/visibility.js';
import { agentContextOf, authenticateAgent } from '../middleware/agent-auth.js';
import { authenticate, orgIdOf } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

// 에이전트 질문 중계(실험). 에이전트가 묻고(브릿지가 대신 부른다) 대상 역할의 사람이 답한다 — 이유는 domain/question/service.ts.

export const questionsRouter = Router();

function actorOf(req: Request): UserContext {
  return { userId: req.user!.id, orgId: orgIdOf(req), orgRole: req.user!.orgRole };
}

// Claude Code AskUserQuestion의 질문 형식. 모르는 필드도 그대로 받아 둔다(형식이 바뀌어도 답의 키만 맞으면 된다).
const questionSchema = z
  .object({
    question: z.string(),
    header: z.string().optional(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() }).passthrough()).max(10),
    multiSelect: z.boolean().optional(),
  })
  .passthrough();

const askBody = z.object({ questions: z.array(questionSchema) }).strict();
const taskParams = z.object({ taskId: z.string().uuid() });
const taskQuestionParams = z.object({ taskId: z.string().uuid(), questionId: z.string().uuid() });

// POST /api/tasks/:taskId/questions — 브릿지의 권한 도구가 AskUserQuestion을 받아 올린다.
questionsRouter.post(
  '/tasks/:taskId/questions',
  authenticateAgent,
  validate({ params: taskParams, body: askBody }),
  async (req, res) => {
    const { taskId } = req.params as z.infer<typeof taskParams>;
    const { questions } = req.body as z.infer<typeof askBody>;
    res.status(201).json({ data: await askQuestion(agentContextOf(req), taskId, questions) });
  },
);

// GET /api/tasks/:taskId/questions/:questionId — 브릿지가 답을 기다리며 읽는다(묻은 에이전트만).
questionsRouter.get(
  '/tasks/:taskId/questions/:questionId',
  authenticateAgent,
  validate({ params: taskQuestionParams }),
  async (req, res) => {
    const { taskId, questionId } = req.params as z.infer<typeof taskQuestionParams>;
    res.status(200).json({ data: await getQuestionForAgent(agentContextOf(req), taskId, questionId) });
  },
);

// POST /api/tasks/:taskId/questions/:questionId/detach — 브릿지가 정한 시간만 기다렸는데 답이 없다.
// 태스크를 BLOCKED(QUESTION)로 내려놓고 질문을 돌려준다. 그 사이 답이 왔으면 아무것도 바꾸지 않고 답을 돌려준다.
questionsRouter.post(
  '/tasks/:taskId/questions/:questionId/detach',
  authenticateAgent,
  validate({ params: taskQuestionParams }),
  async (req, res) => {
    const { taskId, questionId } = req.params as z.infer<typeof taskQuestionParams>;
    res.status(200).json({ data: await detachFromQuestion(agentContextOf(req), taskId, questionId) });
  },
);

// GET /api/agents/me/questions — 대상 역할 에이전트의 Executor가 상담 실행으로 맡을 질문과 읽을 레포.
questionsRouter.get('/agents/me/questions', authenticateAgent, async (req, res) => {
  res.status(200).json({ data: await listConsultJobs(agentContextOf(req)) });
});

// POST /api/questions/:questionId/draft — 상담 실행의 초안. 전부 decided면 곧 답이다(사람 미확인).
const draftBody = z
  .object({
    answers: z.record(z.string()),
    decided: z.record(z.boolean()),
    basis: z.record(z.array(z.string())).default({}),
  })
  .strict();
questionsRouter.post(
  '/questions/:questionId/draft',
  authenticateAgent,
  validate({ params: z.object({ questionId: z.string().uuid() }), body: draftBody }),
  async (req, res) => {
    const { questionId } = req.params as { questionId: string };
    res.status(200).json({ data: await submitDraft(agentContextOf(req), questionId, req.body as z.infer<typeof draftBody>) });
  },
);

const listQuery = z.object({
  status: z.enum(['pending', 'agent_answered', 'answered', 'expired', 'self_owned', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// GET /api/me/questions — 내가 답할 질문(조직 전체). 알림 배지·목록용. 기본은 대기(pending)만.
questionsRouter.get('/me/questions', validate({ query: listQuery }), authenticate, async (req, res) => {
  const { status, limit } = req.query as unknown as z.infer<typeof listQuery>;
  res.status(200).json({ data: { questions: await listMyQuestions(actorOf(req), status, limit) } });
});

// GET /api/projects/:projectId/questions — 답할 사람이 보는 목록(볼 수 있는 범위는 태스크와 같다).
questionsRouter.get(
  '/projects/:projectId/questions',
  validate({ params: z.object({ projectId: z.string().uuid() }), query: listQuery }),
  authenticate,
  async (req, res) => {
    const { projectId } = req.params as { projectId: string };
    const { status, limit } = req.query as unknown as z.infer<typeof listQuery>;
    res.status(200).json({ data: { questions: await listProjectQuestions(actorOf(req), projectId, status, limit) } });
  },
);

const answerBody = z.object({ answers: z.record(z.string()) }).strict();
const questionParams = z.object({ questionId: z.string().uuid() });

// POST /api/questions/:questionId/answer — 대상 역할 담당 또는 대표가 답한다. 키는 질문 문장 그대로.
questionsRouter.post(
  '/questions/:questionId/answer',
  validate({ params: questionParams, body: answerBody }),
  authenticate,
  async (req, res) => {
    const { questionId } = req.params as z.infer<typeof questionParams>;
    const { answers } = req.body as z.infer<typeof answerBody>;
    res.status(200).json({ data: await answerQuestion(actorOf(req), questionId, answers) });
  },
);
