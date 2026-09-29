import { Router } from 'express';
import { z } from 'zod';
import { authenticate, orgIdOf, requireRepresentative } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { addRepoPath, getRepoPaths, updatePathOwnership } from '../domain/repo/service.js';
import { PRIORITY_BAND } from '../domain/repo/seed-paths.js';
import { TEAM_ROLES } from '../domain/roles.js';

export const repoPathsRouter = Router();

const repoIdParamsSchema = z.object({ repoId: z.string().uuid() });
const pathIdParamsSchema = repoIdParamsSchema.extend({ pathId: z.string().uuid() });

// GET /api/repos/:repoId/paths — 레포의 경로 규칙 목록(priority DESC). 조직 소속만 조회 가능
// (getRepoPaths 내부에서 CROSS_ORG_ACCESS를 검사한다).
repoPathsRouter.get(
  '/repos/:repoId/paths',
  validate({ params: repoIdParamsSchema }),
  authenticate,
  async (req, res) => {
    const { repoId } = req.params as z.infer<typeof repoIdParamsSchema>;
    const paths = await getRepoPaths(orgIdOf(req), repoId);
    res.status(200).json({ data: { paths } });
  },
);

const addPathBodySchema = z.object({
  pathPattern: z.string().min(1),
  ownerRole: z.enum(TEAM_ROLES).nullable().optional(),
  access: z.enum(['write', 'read', 'denied']),
  priority: z.number().int().min(PRIORITY_BAND.manual.min).max(PRIORITY_BAND.manual.max).optional(),
});

// POST /api/repos/:repoId/paths — 경로 규칙 추가(대표 전용). priority는 manual 대역(200~299)만 허용하고,
// 미지정 시 대역에서 가장 큰 값 + 1로 서비스가 정한다. 레포 안에서 겹치면 409 PATH_PRIORITY_TAKEN.
repoPathsRouter.post(
  '/repos/:repoId/paths',
  validate({ params: repoIdParamsSchema, body: addPathBodySchema }),
  authenticate,
  requireRepresentative,
  async (req, res) => {
    const { repoId } = req.params as z.infer<typeof repoIdParamsSchema>;
    const path = await addRepoPath(orgIdOf(req), req.user!.id, repoId, req.body);
    res.status(201).json({ data: { path } });
  },
);

const updatePathBodySchema = z.object({
  ownerRole: z.enum(TEAM_ROLES).nullable().optional(),
  access: z.enum(['write', 'read', 'denied']).optional(),
});

// PATCH /api/repos/:repoId/paths/:pathId — 경로 소유권 지정(대표 전용, 온보딩의 핵심 산출물).
// actionKey/priority는 이 라우트로 바꿀 수 없고, access='denied' 행의 access는 불변이다.
repoPathsRouter.patch(
  '/repos/:repoId/paths/:pathId',
  validate({ params: pathIdParamsSchema, body: updatePathBodySchema }),
  authenticate,
  requireRepresentative,
  async (req, res) => {
    const { repoId, pathId } = req.params as z.infer<typeof pathIdParamsSchema>;
    const path = await updatePathOwnership(orgIdOf(req), req.user!.id, repoId, pathId, req.body);
    res.status(200).json({ data: { path } });
  },
);
