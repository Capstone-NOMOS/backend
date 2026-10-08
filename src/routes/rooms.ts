import { Router, type Request } from 'express';
import { z } from 'zod';
import { ACTIVITY_KINDS } from '../domain/room/repository.js';
import { endRun, getRoomFeed, listRooms, recordActivity, startRun } from '../domain/room/service.js';
import { TEAM_ROLES } from '../domain/roles.js';
import type { UserContext } from '../domain/project/visibility.js';
import { AppError } from '../errors.js';
import { authenticate, orgIdOf } from '../middleware/auth.js';
import { agentContextOf, authenticateAgent } from '../middleware/agent-auth.js';
import { validate } from '../middleware/validate.js';

// 룸(프로젝트 × 역할): Executor가 실행 시작·끝·도구 사용을 보고하고(에이전트 토큰), 사람이 룸 피드를 읽는다(사람 토큰).

export const roomsRouter = Router();

const taskIdParamsSchema = z.object({ taskId: z.string().uuid() });

// POST /api/tasks/:taskId/runs/start — Claude 실행 시작(그 태스크를 잡고 있는 에이전트만).
roomsRouter.post('/tasks/:taskId/runs/start', authenticateAgent, validate({ params: taskIdParamsSchema }), async (req, res) => {
  const { taskId } = req.params as z.infer<typeof taskIdParamsSchema>;
  res.status(201).json({ data: await startRun(agentContextOf(req), taskId) });
});

const endRunBodySchema = z.object({
  outcome: z.enum(['completed', 'timeout', 'failed']),
  committed: z.boolean(),
  durationMs: z.number().int().min(0),
  exitCode: z.number().int().nullable(),
});

// POST /api/tasks/:taskId/runs/end — Claude 실행 끝. 제출 여부는 서버가 태스크 상태로 정한다.
roomsRouter.post(
  '/tasks/:taskId/runs/end',
  authenticateAgent,
  validate({ params: taskIdParamsSchema, body: endRunBodySchema }),
  async (req, res) => {
    const { taskId } = req.params as z.infer<typeof taskIdParamsSchema>;
    res.status(200).json({ data: await endRun(agentContextOf(req), taskId, req.body as z.infer<typeof endRunBodySchema>) });
  },
);

// 도구 종류와 대상(경로·명령)만 받는다. 파일 내용·명령 결과·모델 설명은 받지 않는다(설명은 인계 노트의 몫).
const activityBodySchema = z.object({
  items: z
    .array(z.object({ kind: z.enum(ACTIVITY_KINDS as [string, ...string[]]), target: z.string().trim().min(1).max(300) }))
    .min(1)
    .max(50),
});

// POST /api/tasks/:taskId/activity — 실행 중 도구 사용 묶음(열린 실행에만).
roomsRouter.post(
  '/tasks/:taskId/activity',
  authenticateAgent,
  validate({ params: taskIdParamsSchema, body: activityBodySchema }),
  async (req, res) => {
    const { taskId } = req.params as z.infer<typeof taskIdParamsSchema>;
    const { items } = req.body as { items: { kind: (typeof ACTIVITY_KINDS)[number]; target: string }[] };
    res.status(201).json({ data: await recordActivity(agentContextOf(req), taskId, items) });
  },
);

function userOf(req: Request): UserContext {
  if (!req.user) throw new AppError('UNAUTHENTICATED', 'authentication required');
  return { userId: req.user.id, orgId: orgIdOf(req), orgRole: req.user.orgRole };
}

const projectIdParamsSchema = z.object({ projectId: z.string().uuid() });

// GET /api/projects/:projectId/rooms — 내가 볼 수 있는 룸(대표는 전부, 팀원은 자기 역할)과 담당 에이전트·진행 중 태스크.
roomsRouter.get('/projects/:projectId/rooms', validate({ params: projectIdParamsSchema }), authenticate, async (req, res) => {
  const { projectId } = req.params as z.infer<typeof projectIdParamsSchema>;
  res.status(200).json({ data: { rooms: await listRooms(userOf(req), projectId) } });
});

const feedParamsSchema = z.object({ projectId: z.string().uuid(), role: z.enum(TEAM_ROLES) });
const feedQuerySchema = z.object({
  before: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// GET /api/projects/:projectId/rooms/:role/feed — 룸 피드(최신부터). nextBefore로 더 오래된 것을 읽는다.
roomsRouter.get(
  '/projects/:projectId/rooms/:role/feed',
  validate({ params: feedParamsSchema, query: feedQuerySchema }),
  authenticate,
  async (req, res) => {
    const { projectId, role } = req.params as z.infer<typeof feedParamsSchema>;
    const query = req.query as unknown as z.infer<typeof feedQuerySchema>;
    res.status(200).json({ data: await getRoomFeed(userOf(req), projectId, role, query) });
  },
);
