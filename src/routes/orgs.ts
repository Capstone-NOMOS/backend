import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRepresentative, requireSameOrg } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { createOrganization, dissolveOrganization, listAvailableGithubRepos, listMembers, removeOrgMember } from '../domain/org/service.js';

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

const memberParamsSchema = z.object({ orgId: z.string().uuid(), userId: z.string().uuid() });

// DELETE /api/orgs/:orgId/members/:userId — 조직에서 멤버 내보내기(대표) 또는 본인 탈퇴(userId = 나, 021).
// 계정은 남고 조직만 빠진다. 그 사람의 에이전트는 진행 중 프로젝트에서 빠지고 연결이 해제된다(진행 중 태스크가 있으면 409 ACTIVE_TASKS_HELD).
// 대표는 나갈 수 없다(409 REPRESENTATIVE_CANNOT_LEAVE).
orgsRouter.delete(
  '/orgs/:orgId/members/:userId',
  validate({ params: memberParamsSchema }),
  authenticate,
  requireSameOrg,
  async (req, res) => {
    const { orgId, userId } = req.params as z.infer<typeof memberParamsSchema>;
    const user = req.user!;
    res.status(200).json({ data: await removeOrgMember({ userId: user.id, orgId, orgRole: user.orgRole }, orgId, userId) });
  },
);

// DELETE /api/orgs/:orgId — 조직 해산(대표 전용, 029). 대표가 조직을 떠나는 길은 이것 하나다(대표 단독 탈퇴는 409 REPRESENTATIVE_CANNOT_LEAVE).
// 진행 중 프로젝트 중단·초대 취소·레포 해제·멤버 전원(대표 포함) 빼기를 한 트랜잭션에서 한다. 행은 지우지 않는다.
// 진행 중 태스크를 잡은 에이전트가 있으면 409 ACTIVE_TASKS_HELD(아무것도 바뀌지 않는다). 해산 뒤 이 조직 id로 오는 API는 404 ORG_NOT_FOUND.
orgsRouter.delete(
  '/orgs/:orgId',
  validate({ params: orgIdParamsSchema }),
  authenticate,
  requireSameOrg,
  requireRepresentative,
  async (req, res) => {
    const { orgId } = req.params as z.infer<typeof orgIdParamsSchema>;
    const user = req.user!;
    res.status(200).json({ data: await dissolveOrganization({ userId: user.id, orgId, orgRole: user.orgRole }, orgId) });
  },
);
