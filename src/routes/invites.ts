import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRepresentative, requireSameOrg } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { acceptInvite, createInvite, previewInvite } from '../domain/invite/service.js';
import { TEAM_ROLES } from '../domain/roles.js';

export const invitesRouter = Router();

const orgIdParamsSchema = z.object({ orgId: z.string().uuid() });
const createInviteBodySchema = z.object({
  expiresInDays: z.number().int().positive().optional(),
  teamRole: z.enum(TEAM_ROLES).optional(),
});

// POST /api/orgs/:orgId/invites — 초대 링크 생성(대표 전용).
invitesRouter.post(
  '/orgs/:orgId/invites',
  validate({ params: orgIdParamsSchema, body: createInviteBodySchema }),
  authenticate,
  requireSameOrg,
  requireRepresentative,
  async (req, res) => {
    const { orgId } = req.params as z.infer<typeof orgIdParamsSchema>;
    const invite = await createInvite(orgId, req.user!.id, req.body);
    res.status(201).json({ data: invite });
  },
);

const tokenParamsSchema = z.object({ token: z.string().min(1) });

// GET /api/invites/:token — 수락 전 미리보기. 인증 불필요. 토큰이 유효하지 않아도 항상 200 +
// valid:false로 응답한다 (404를 쓰면 토큰 존재 여부가 노출된다).
invitesRouter.get('/invites/:token', validate({ params: tokenParamsSchema }), async (req, res) => {
  const { token } = req.params as z.infer<typeof tokenParamsSchema>;
  const preview = await previewInvite(token);
  res.status(200).json({ data: preview });
});

// POST /api/invites/:token/accept — 로그인한 사용자가 초대를 수락한다.
// users.org_id와 그 사용자의 agents.org_id가 함께 채워진다.
invitesRouter.post(
  '/invites/:token/accept',
  validate({ params: tokenParamsSchema }),
  authenticate,
  async (req, res) => {
    const { token } = req.params as z.infer<typeof tokenParamsSchema>;
    const result = await acceptInvite(token, req.user!.id);
    res.status(200).json({ data: result });
  },
);
