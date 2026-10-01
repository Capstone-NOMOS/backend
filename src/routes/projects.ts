import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  assignMember,
  startProject,
  createProject,
  getProject,
  listProjects,
  unassignMember,
  type Actor,
} from '../domain/project/service.js';
import { TEAM_ROLES } from '../domain/roles.js';
import { AppError } from '../errors.js';
import { authenticate, orgIdOf, requireRepresentative, requireSameOrg } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

export const projectsRouter = Router();

// 멤버 배정 전에 발급된 에이전트 토큰에는 project_id가 없다. 배정 뒤 반드시 재발급해야
// 태스크·노트 API를 쓸 수 있다 — 안 하면 403 NOT_PROJECT_MEMBER가 난다.
const REFRESH_NOTICE =
  '배정된 에이전트는 POST /api/agents/token/refresh로 토큰을 재발급해야 태스크·노트 API를 쓸 수 있습니다.';

function actorOf(req: Request): Actor {
  if (!req.user) throw new AppError('UNAUTHENTICATED', 'authentication required');
  return { userId: req.user.id, orgId: orgIdOf(req), orgRole: req.user.orgRole };
}

const orgIdParamsSchema = z.object({ orgId: z.string().uuid() });
const projectIdParamsSchema = z.object({ projectId: z.string().uuid() });
const memberParamsSchema = projectIdParamsSchema.extend({ agentId: z.string().uuid() });

// autonomyPreset은 여기서 enum으로 막지 않는다 — 서비스가 422로 "무엇이 허용되는지"까지 답한다.
const createProjectBodySchema = z.object({
  name: z.string().trim().min(1).max(128),
  autonomyPreset: z.string().min(1),
  pmBudgetUsd: z.number().positive(),
  budgetUsd: z.number().positive().optional(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'deadline must be YYYY-MM-DD').optional(),
  repoIds: z.array(z.string().uuid()).min(1).max(20),
});

// POST /api/orgs/:orgId/projects — 프로젝트 생성(대표 전용).
// 한 트랜잭션에서 프로젝트·레포 연결·정책 사본 17행·헌법 스냅샷·policy_hash가 함께 만들어진다.
projectsRouter.post(
  '/orgs/:orgId/projects',
  validate({ params: orgIdParamsSchema, body: createProjectBodySchema }),
  authenticate,
  requireSameOrg,
  requireRepresentative,
  async (req, res) => {
    const { orgId } = req.params as z.infer<typeof orgIdParamsSchema>;
    const body = req.body as z.infer<typeof createProjectBodySchema>;
    const detail = await createProject(orgId, req.user!.id, body);
    res.status(201).json({ data: detail });
  },
);

// GET /api/orgs/:orgId/projects — 프로젝트 목록. 대표는 전체, 팀원은 자기 에이전트가 배정된 것만.
projectsRouter.get(
  '/orgs/:orgId/projects',
  validate({ params: orgIdParamsSchema }),
  authenticate,
  requireSameOrg,
  async (req, res) => {
    res.status(200).json({ data: { projects: await listProjects(actorOf(req)) } });
  },
);

const assignMemberBodySchema = z.object({
  agentId: z.string().uuid(),
  teamRole: z.enum(TEAM_ROLES),
});

// POST /api/projects/:projectId/members — 역할 배정(대표 전용). G1 이후에는 403.
projectsRouter.post(
  '/projects/:projectId/members',
  validate({ params: projectIdParamsSchema, body: assignMemberBodySchema }),
  authenticate,
  requireRepresentative,
  async (req, res) => {
    const { projectId } = req.params as z.infer<typeof projectIdParamsSchema>;
    const body = req.body as z.infer<typeof assignMemberBodySchema>;
    const members = await assignMember(actorOf(req), projectId, body.agentId, body.teamRole);
    res.status(201).json({ data: { members, notice: REFRESH_NOTICE } });
  },
);

// DELETE /api/projects/:projectId/members/:agentId — 배정 해제(대표 전용).
// 역할 교체는 해제 후 재배정으로 한다.
projectsRouter.delete(
  '/projects/:projectId/members/:agentId',
  validate({ params: memberParamsSchema }),
  authenticate,
  requireRepresentative,
  async (req, res) => {
    const { projectId, agentId } = req.params as z.infer<typeof memberParamsSchema>;
    const members = await unassignMember(actorOf(req), projectId, agentId);
    res.status(200).json({ data: { members } });
  },
);

// POST /api/projects/:projectId/start — 프로젝트 시작(G1, 대표 전용). 이때부터 에이전트가 태스크를 받는다.
// 태스크가 없거나 담당이 빈 역할이 있으면 422 PROJECT_START_INVALID(details에 전부). 시작 뒤에는 멤버를 바꿀 수 없다.
projectsRouter.post(
  '/projects/:projectId/start',
  validate({ params: projectIdParamsSchema }),
  authenticate,
  requireRepresentative,
  async (req, res) => {
    const { projectId } = req.params as z.infer<typeof projectIdParamsSchema>;
    res.status(200).json({ data: await startProject(actorOf(req), projectId) });
  },
);

// GET /api/projects/:projectId — 대표 또는 이 프로젝트에 배정된 에이전트의 주인만.
projectsRouter.get(
  '/projects/:projectId',
  validate({ params: projectIdParamsSchema }),
  authenticate,
  async (req, res) => {
    const { projectId } = req.params as z.infer<typeof projectIdParamsSchema>;
    res.status(200).json({ data: await getProject(actorOf(req), projectId) });
  },
);
