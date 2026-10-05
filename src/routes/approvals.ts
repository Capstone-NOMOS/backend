import { Router, type Request } from 'express';
import { z } from 'zod';
import { decide, listOrgApprovals, listProjectApprovals } from '../domain/approval/service.js';
import type { UserContext } from '../domain/project/visibility.js';
import { authenticate, orgIdOf, requireRepresentative, requireSameOrg } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

// 승인 대기열(ACTION 게이트). 결정은 대표만 한다 — 이유는 domain/approval/service.ts.

export const approvalsRouter = Router();

function actorOf(req: Request): UserContext {
  return { userId: req.user!.id, orgId: orgIdOf(req), orgRole: req.user!.orgRole };
}

const listQuery = z.object({
  status: z.enum(['pending', 'decided', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// GET /api/orgs/:orgId/approvals — 조직 전체 대기열(대시보드 "승인 · 결정 대기", 받은 편지함). 대표 전용.
approvalsRouter.get(
  '/orgs/:orgId/approvals',
  validate({ params: z.object({ orgId: z.string().uuid() }), query: listQuery }),
  authenticate,
  requireSameOrg,
  requireRepresentative,
  async (req, res) => {
    const { status, limit } = req.query as unknown as z.infer<typeof listQuery>;
    res.status(200).json({ data: { approvals: await listOrgApprovals(orgIdOf(req), status, limit) } });
  },
);

// GET /api/projects/:projectId/approvals — 프로젝트의 승인 이력. 볼 수 있는 범위는 태스크·노트와 같다.
approvalsRouter.get(
  '/projects/:projectId/approvals',
  validate({ params: z.object({ projectId: z.string().uuid() }), query: listQuery }),
  authenticate,
  async (req, res) => {
    const { projectId } = req.params as { projectId: string };
    const { status, limit } = req.query as unknown as z.infer<typeof listQuery>;
    res.status(200).json({ data: { approvals: await listProjectApprovals(actorOf(req), projectId, status, limit) } });
  },
);

const approvalParams = z.object({ approvalId: z.string().uuid() });

// POST /api/approvals/:approvalId/approve — 승인 → 태스크 DONE. 대표 전용.
approvalsRouter.post(
  '/approvals/:approvalId/approve',
  validate({ params: approvalParams }),
  authenticate,
  requireRepresentative,
  async (req, res) => {
    const { approvalId } = req.params as z.infer<typeof approvalParams>;
    res.status(200).json({ data: await decide(actorOf(req), approvalId, 'APPROVE', null) });
  },
);

// POST /api/approvals/:approvalId/reject — 반려 → 태스크 READY(재시도 +1, 3회째 ESCALATED). 사유 필수 — 다음 시도의 브리핑에 들어간다.
const rejectBody = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();

approvalsRouter.post(
  '/approvals/:approvalId/reject',
  validate({ params: approvalParams, body: rejectBody }),
  authenticate,
  requireRepresentative,
  async (req, res) => {
    const { approvalId } = req.params as z.infer<typeof approvalParams>;
    const { reason } = req.body as z.infer<typeof rejectBody>;
    res.status(200).json({ data: await decide(actorOf(req), approvalId, 'REJECT', reason) });
  },
);
