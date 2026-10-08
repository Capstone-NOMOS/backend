import { Router, type Request } from 'express';
import { z } from 'zod';
import { ACTIVITY_KINDS } from '../domain/room/repository.js';
import { endRun, getRoomFeed, listRooms, recordActivity, startRun } from '../domain/room/service.js';
import { resumeTask } from '../domain/task/stall.js';
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
  // 제출하지 않았을 때 대표에게 보일 사유(선택). 모델의 마지막 말, 거부된 쉘 명령.
  lastMessage: z.string().max(2000).nullable().optional(),
  deniedCommands: z.array(z.string().max(300)).max(20).optional(),
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

const resumeBodySchema = z.object({ note: z.string().trim().max(500).nullable().optional() });

// POST /api/tasks/:taskId/resume — 멈춘 태스크(BLOCKED·AGENT_STOPPED) 재개(대표 전용). READY로 돌아가 같은 역할의 에이전트가 다시 가져간다.
// 재시도 횟수는 그대로다 — 권한·환경 탓은 에이전트 실패가 아니다.
roomsRouter.post(
  '/tasks/:taskId/resume',
  validate({ params: taskIdParamsSchema, body: resumeBodySchema }),
  authenticate,
  async (req, res) => {
    const { taskId } = req.params as z.infer<typeof taskIdParamsSchema>;
    const { note } = req.body as z.infer<typeof resumeBodySchema>;
    res.status(200).json({ data: await resumeTask(userOf(req), taskId, note ?? null) });
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
