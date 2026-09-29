import { Router } from 'express';
import { z } from 'zod';
import { createSpec, listProjectSpecs } from '../domain/authoring/service.js';
import { specInputSchema } from '../domain/authoring/schema.js';
import { agentContextOf, authenticateAny } from '../middleware/agent-auth.js';
import { authenticate, orgIdOf, requireRepresentative } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

export const specsRouter = Router();

const projectIdParamsSchema = z.object({ projectId: z.string().uuid() });

// POST /api/projects/:projectId/specs — 명세 + 시험지 생성(대표 전용). 시험지의 locked는 필수이고 만들 때만 정한다.
specsRouter.post(
  '/projects/:projectId/specs',
  validate({ params: projectIdParamsSchema, body: specInputSchema }),
  authenticate,
  requireRepresentative,
  async (req, res) => {
    const { projectId } = req.params as z.infer<typeof projectIdParamsSchema>;
    const body = req.body as z.infer<typeof specInputSchema>;
    res.status(201).json({ data: await createSpec(req.user!.id, projectId, body) });
  },
);

// GET /api/projects/:projectId/specs — 명세 목록. 태스크 목록과 같은 범위(사람은 볼 수 있는 프로젝트, 에이전트는 자기 프로젝트).
specsRouter.get(
  '/projects/:projectId/specs',
  authenticateAny,
  validate({ params: projectIdParamsSchema }),
  async (req, res) => {
    const { projectId } = req.params as z.infer<typeof projectIdParamsSchema>;
    const viewer = req.agent
      ? ({ kind: 'agent', projectId: agentContextOf(req).projectId } as const)
      : ({
          kind: 'user',
          actor: { userId: req.user!.id, orgId: orgIdOf(req), orgRole: req.user!.orgRole },
        } as const);
    res.status(200).json({ data: { specs: await listProjectSpecs(viewer, projectId) } });
  },
);
