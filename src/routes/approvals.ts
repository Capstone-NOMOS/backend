import { Router, type Request } from 'express';
import { z } from 'zod';
import { decide, listMyApprovals, listOrgApprovals, listProjectApprovals } from '../domain/approval/service.js';
import type { UserContext } from '../domain/project/visibility.js';
import { authenticate, orgIdOf, requireRepresentative, requireSameOrg } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

// 승인 대기열(ACTION 게이트 + G3). ACTION은 두 단계다(030) — 역할 담당의 1차 검토(role_review) → 대표 최종(final).
// 누가 결정할 수 있는지는 카드의 단계로 서비스가 정한다(domain/approval/service.ts) — 라우트는 로그인만 본다.

export const approvalsRouter = Router();

function actorOf(req: Request): UserContext {
  return { userId: req.user!.id, orgId: orgIdOf(req), orgRole: req.user!.orgRole };
}

const listQuery = z.object({
  status: z.enum(['pending', 'decided', 'all']).default('pending'),
  stage: z.enum(['role_review', 'final', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// GET /api/orgs/:orgId/approvals — 조직 전체 대기열(대시보드 "승인 · 결정 대기", 받은 편지함). 대표 전용.
// 1차 검토 대기(role_review)도 보인다 — 역할 담당이 응답하지 않으면 대표가 대신 처리한다.
approvalsRouter.get(
  '/orgs/:orgId/approvals',
  validate({ params: z.object({ orgId: z.string().uuid() }), query: listQuery }),
  authenticate,
  requireSameOrg,
  requireRepresentative,
  async (req, res) => {
    const { status, stage, limit } = req.query as unknown as z.infer<typeof listQuery>;
    res.status(200).json({ data: { approvals: await listOrgApprovals(orgIdOf(req), status, stage, limit) } });
  },
);

// GET /api/me/approvals — 내가 검토할 1차 검토 대기 카드(팀원의 "검토 요청"). 결정되면 빠진다.
const myQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

approvalsRouter.get('/me/approvals', validate({ query: myQuery }), authenticate, async (req, res) => {
  const { limit } = req.query as unknown as z.infer<typeof myQuery>;
  res.status(200).json({ data: { approvals: await listMyApprovals(actorOf(req), limit) } });
});

// GET /api/projects/:projectId/approvals — 프로젝트의 승인 이력. 볼 수 있는 범위는 태스크·노트와 같다.
approvalsRouter.get(
  '/projects/:projectId/approvals',
  validate({ params: z.object({ projectId: z.string().uuid() }), query: listQuery }),
  authenticate,
  async (req, res) => {
    const { projectId } = req.params as { projectId: string };
    const { status, stage, limit } = req.query as unknown as z.infer<typeof listQuery>;
    res.status(200).json({ data: { approvals: await listProjectApprovals(actorOf(req), projectId, status, stage, limit) } });
  },
);

const approvalParams = z.object({ approvalId: z.string().uuid() });

// POST /api/approvals/:approvalId/approve — 1차 검토 승인이면 대표의 최종 카드가 생기고(태스크는 승인 대기 그대로),
// 최종 승인이면 태스크 DONE. 메모(note)는 선택 — 1차 검토 결과(roleReview.note)에 남는다.
const approveBody = z.object({ note: z.string().trim().min(1).max(2000).optional() }).strict().optional();

approvalsRouter.post(
  '/approvals/:approvalId/approve',
  validate({ params: approvalParams, body: approveBody }),
  authenticate,
  async (req, res) => {
    const { approvalId } = req.params as z.infer<typeof approvalParams>;
    const body = req.body as z.infer<typeof approveBody>;
    res.status(200).json({ data: await decide(actorOf(req), approvalId, 'APPROVE', body?.note ?? null) });
  },
);

// POST /api/approvals/:approvalId/reject — 반려 → 태스크 READY(재시도 +1, 3회째 ESCALATED). 어느 단계든 같다. 사유 필수 — 다음 시도의 브리핑에 들어간다.
const rejectBody = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();

approvalsRouter.post(
  '/approvals/:approvalId/reject',
  validate({ params: approvalParams, body: rejectBody }),
  authenticate,
  async (req, res) => {
    const { approvalId } = req.params as z.infer<typeof approvalParams>;
    const { reason } = req.body as z.infer<typeof rejectBody>;
    res.status(200).json({ data: await decide(actorOf(req), approvalId, 'REJECT', reason) });
  },
);
