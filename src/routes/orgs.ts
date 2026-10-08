import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireSameOrg } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { createOrganization, listAvailableGithubRepos, listMembers } from '../domain/org/service.js';

export const orgsRouter = Router();

const orgIdParamsSchema = z.object({ orgId: z.string().uuid() });

const createOrgBodySchema = z.object({
  name: z.string().max(128),
});

// POST /api/orgs — 로그인한 사용자가 조직을 만들고 대표가 된다. 이미 조직이 있으면 409.
orgsRouter.post('/orgs', validate({ body: createOrgBodySchema }), authenticate, async (req, res) => {
  const { orgId, userId } = await createOrganization(req.user!.id, req.body.name);
  res.status(201).json({ data: { orgId, userId } });
});

// GET /api/orgs/:orgId/github/repos — 연결할 수 있는 GitHub 레포 목록(조직 멤버 누구나).
// 레포 연결을 팀원에게 열었으므로 그 드롭다운을 채우는 이 목록도 함께 열려 있어야 한다.
// 그 조직 대표의 GitHub 토큰으로 읽는다. 대표가 GitHub를 연결하지 않았으면 빈 배열(500을 던지지 않음).
orgsRouter.get(
  '/orgs/:orgId/github/repos',
  validate({ params: orgIdParamsSchema }),
  authenticate,
  requireSameOrg,
  async (req, res) => {
    const { orgId } = req.params as z.infer<typeof orgIdParamsSchema>;
    const repos = await listAvailableGithubRepos(orgId);
    res.status(200).json({ data: { repos } });
  },
);

// GET /api/orgs/:orgId/members — 조직 멤버 목록 + (가능하면) GitHub collaborator 여부.
orgsRouter.get(
  '/orgs/:orgId/members',
  validate({ params: orgIdParamsSchema }),
  authenticate,
  requireSameOrg,
  async (req, res) => {
    // validate 미들웨어가 이미 orgIdParamsSchema로 검증했으므로 여기서는 형태를 신뢰한다.
    const { orgId } = req.params as z.infer<typeof orgIdParamsSchema>;
    const members = await listMembers(orgId);
    res.status(200).json({ data: { members } });
  },
);
