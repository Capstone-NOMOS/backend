import { Router } from 'express';
import { z } from 'zod';
import { TASK_STATES } from '../domain/task/repository.js';
import {
  claimTask,
  getTaskBriefing,
  listTasksForAgent,
  listTaskArtifacts,
  listTaskArtifactsForUser,
  listTasksForUser,
  reportTaskBranch,
  submitArtifact,
} from '../domain/task/service.js';
import { TEAM_ROLES } from '../domain/roles.js';
import { orgIdOf } from '../middleware/auth.js';
import { agentContextOf, authenticateAgent, authenticateAny } from '../middleware/agent-auth.js';
import { validate } from '../middleware/validate.js';
import {
  getArtifactVerifications,
  recordBridgeVerification,
} from '../domain/verification/service.js';
import { VERIFICATION_RESULTS, VERIFICATION_STAGES } from '../domain/verification/repository.js';

export const tasksRouter = Router();

const taskIdParamsSchema = z.object({ taskId: z.string().uuid() });

// POST /api/tasks/:taskId/claim — MCP 도구 claim_task의 서버 쪽.
tasksRouter.post(
  '/tasks/:taskId/claim',
  authenticateAgent,
  validate({ params: taskIdParamsSchema }),
  async (req, res) => {
    const { taskId } = req.params as z.infer<typeof taskIdParamsSchema>;
    const task = await claimTask(agentContextOf(req), taskId);
    res.json({ data: task });
  },
);

const submitBodySchema = z.object({
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/, 'commitSha must be a lowercase hex sha'),
  // 빈 제출은 받지 않는다 — 바꾼 게 없으면 경로 검증할 대상도 없다.
  changedPaths: z.array(z.string().min(1)).min(1).max(1000),
});

// POST /api/tasks/:taskId/artifacts — MCP 도구 submit_artifact의 서버 쪽.
tasksRouter.post(
  '/tasks/:taskId/artifacts',
  authenticateAgent,
  validate({ params: taskIdParamsSchema, body: submitBodySchema }),
  async (req, res) => {
    const { taskId } = req.params as z.infer<typeof taskIdParamsSchema>;
    const body = req.body as z.infer<typeof submitBodySchema>;
    // 서버가 판정하는 단계(V1A·V1B·V3)는 이 응답 안에서 이미 끝나 있다.
    const { artifact, verification } = await submitArtifact(agentContextOf(req), { taskId, ...body });
    res.status(201).json({ data: { ...artifact, verification } });
  },
);

// GET /api/tasks/:taskId/artifacts — Executor가 방금 모델이 제출한 산출물의 id를 찾고,
// 웹 UI(사람)가 태스크 상세에서 제출 이력을 본다. 사람 경로가 없으면 프론트가 artifact_id를
// 얻을 방법이 없어 GET /api/artifacts/:id/verifications에 닿지 못한다.
//
// 에이전트는 자기가 담당한 태스크만, 사람은 볼 수 있는 프로젝트의 태스크면 된다(조회뿐이다).
tasksRouter.get(
  '/tasks/:taskId/artifacts',
  authenticateAny,
  validate({ params: taskIdParamsSchema }),
  async (req, res) => {
    const { taskId } = req.params as z.infer<typeof taskIdParamsSchema>;
    const artifacts = req.agent
      ? await listTaskArtifacts(agentContextOf(req), taskId)
      : await listTaskArtifactsForUser(
          { userId: req.user!.id, orgId: orgIdOf(req), orgRole: req.user!.orgRole },
          taskId,
        );
    res.json({ data: { artifacts } });
  },
);

const artifactIdParamsSchema = z.object({ artifactId: z.string().uuid() });

const verificationBodySchema = z.object({
  // 서버가 판정하는 단계는 받지 않는다. 서비스가 한 번 더 막지만 여기서도 좁혀 둔다 —
  // 로컬이 보고한 V3를 서버가 받으면 V3의 전제(로컬을 믿지 않는다)가 무너진다.
  stage: z.enum(VERIFICATION_STAGES),
  result: z.enum(VERIFICATION_RESULTS),
  detail: z.record(z.string(), z.unknown()).default({}),
  durationMs: z.number().int().nonnegative().optional(),
});

// POST /api/artifacts/:artifactId/verifications — 브릿지 단계(V2·V4) 보고.
// 작업공간이 있어야 돌 수 있는 검사라 제출 시점에는 결과가 물리적으로 존재할 수 없다.
tasksRouter.post(
  '/artifacts/:artifactId/verifications',
  authenticateAgent,
  validate({ params: artifactIdParamsSchema, body: verificationBodySchema }),
  async (req, res) => {
    const { artifactId } = req.params as z.infer<typeof artifactIdParamsSchema>;
    const body = req.body as z.infer<typeof verificationBodySchema>;
    const ctx = agentContextOf(req);
    const summary = await recordBridgeVerification({ ...ctx, agentId: ctx.agentId }, artifactId, body);
    res.status(201).json({ data: summary });
  },
);

// GET /api/artifacts/:artifactId/verifications — 무엇이 PASS였고 무엇을 못 돌렸는지 본다.
tasksRouter.get(
  '/artifacts/:artifactId/verifications',
  authenticateAny,
  validate({ params: artifactIdParamsSchema }),
  async (req, res) => {
    const { artifactId } = req.params as z.infer<typeof artifactIdParamsSchema>;
    const viewer = req.agent
      ? ({ kind: 'agent', projectId: agentContextOf(req).projectId } as const)
      : ({
          kind: 'user',
          actor: { userId: req.user!.id, orgId: orgIdOf(req), orgRole: req.user!.orgRole },
        } as const);
    res.json({ data: { verifications: await getArtifactVerifications(viewer, artifactId) } });
  },
);

const taskQuerySchema = z.object({
  state: z.enum(TASK_STATES).optional(),
  teamRole: z.enum(TEAM_ROLES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const projectIdParamsSchema = z.object({ projectId: z.string().uuid() });

// GET /api/projects/:projectId/tasks — 웹 UI(사람)와 Executor 폴링(에이전트)이 함께 쓴다.
// 에이전트 토큰이면 teamRole 질의를 무시하고 자기 역할로 강제 필터한다.
tasksRouter.get(
  '/projects/:projectId/tasks',
  authenticateAny,
  validate({ params: projectIdParamsSchema, query: taskQuerySchema }),
  async (req, res) => {
    const { projectId } = req.params as z.infer<typeof projectIdParamsSchema>;
    const query = req.query as unknown as z.infer<typeof taskQuerySchema>;

    const tasks = req.agent
      ? await listTasksForAgent(agentContextOf(req), projectId, query)
      : await listTasksForUser(
          { userId: req.user!.id, orgId: orgIdOf(req), orgRole: req.user!.orgRole },
          projectId,
          query,
        );
    res.json({ data: { tasks } });
  },
);

// GET /api/tasks/:taskId/briefing — Executor가 프롬프트와 settings.json을 만드는 데 필요한 것 한 번에.
// CLAIM 전에도 받을 수 있다 — 작업공간을 먼저 만들고 claim은 모델이 도구로 하기 때문이다.
tasksRouter.get(
  '/tasks/:taskId/briefing',
  authenticateAgent,
  validate({ params: taskIdParamsSchema }),
  async (req, res) => {
    const { taskId } = req.params as z.infer<typeof taskIdParamsSchema>;
    res.json({ data: await getTaskBriefing(agentContextOf(req), taskId) });
  },
);

const branchBodySchema = z.object({
  branchName: z.string().min(1).max(200).regex(/^[A-Za-z0-9._\/-]+$/, 'branchName has invalid characters'),
});

// PATCH /api/tasks/:taskId/branch — Executor가 만든 브랜치를 서버에 알린다.
// 이미 값이 있으면 그대로 둔다.
tasksRouter.patch(
  '/tasks/:taskId/branch',
  authenticateAgent,
  validate({ params: taskIdParamsSchema, body: branchBodySchema }),
  async (req, res) => {
    const { taskId } = req.params as z.infer<typeof taskIdParamsSchema>;
    const { branchName } = req.body as z.infer<typeof branchBodySchema>;
    res.json({ data: await reportTaskBranch(agentContextOf(req), taskId, branchName) });
  },
);
