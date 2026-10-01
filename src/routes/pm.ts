import { Router } from 'express';
import { z } from 'zod';
import { applyPlan, getPlan, listProjectPlans, requestPlan, revisePlan } from '../domain/pm/service.js';
import { authenticate, requireRepresentative } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

// 내장 PM(계획 수립). 전부 대표 전용 — 설계상 PM과의 대화는 대표만 한다.
// 초안 생성은 수십 초~수 분이라 요청은 202로 바로 답하고, 클라이언트는 GET으로 상태를 폴링한다.
export const pmRouter = Router();

const projectParams = z.object({ projectId: z.string().uuid() });
const planParams = projectParams.extend({ planId: z.string().uuid() });

// POST /api/projects/:projectId/pm/plans — 대표의 지시로 계획 초안을 요청한다.
pmRouter.post(
  '/projects/:projectId/pm/plans',
  validate({ params: projectParams, body: z.object({ instruction: z.string().trim().min(1).max(8000) }).strict() }),
  authenticate,
  requireRepresentative,
  async (req, res) => {
    const { projectId } = req.params as z.infer<typeof projectParams>;
    res.status(202).json({ data: await requestPlan(req.user!.id, projectId, req.body.instruction as string) });
  },
);

// GET /api/projects/:projectId/pm/plans — 요청 이력(최근 순).
pmRouter.get(
  '/projects/:projectId/pm/plans',
  validate({ params: projectParams }),
  authenticate,
  requireRepresentative,
  async (req, res) => {
    const { projectId } = req.params as z.infer<typeof projectParams>;
    res.status(200).json({ data: { plans: await listProjectPlans(req.user!.id, projectId) } });
  },
);

// GET /api/projects/:projectId/pm/plans/:planId — 상태와 초안. pending이면 몇 초 뒤 다시 부른다.
pmRouter.get(
  '/projects/:projectId/pm/plans/:planId',
  validate({ params: planParams }),
  authenticate,
  requireRepresentative,
  async (req, res) => {
    const { projectId, planId } = req.params as z.infer<typeof planParams>;
    res.status(200).json({ data: await getPlan(req.user!.id, projectId, planId) });
  },
);

// POST /api/projects/:projectId/pm/plans/:planId/revise — 수정 요청. 이전 초안 + 피드백으로 새 초안을 만든다.
pmRouter.post(
  '/projects/:projectId/pm/plans/:planId/revise',
  validate({ params: planParams, body: z.object({ feedback: z.string().trim().min(1).max(8000) }).strict() }),
  authenticate,
  requireRepresentative,
  async (req, res) => {
    const { projectId, planId } = req.params as z.infer<typeof planParams>;
    res.status(202).json({ data: await revisePlan(req.user!.id, projectId, planId, req.body.feedback as string) });
  },
);

// POST /api/projects/:projectId/pm/plans/:planId/apply — 초안을 그대로 적용(명세·태스크 생성). G1(프로젝트 시작)이 아니다.
pmRouter.post(
  '/projects/:projectId/pm/plans/:planId/apply',
  validate({ params: planParams }),
  authenticate,
  requireRepresentative,
  async (req, res) => {
    const { projectId, planId } = req.params as z.infer<typeof planParams>;
    res.status(200).json({ data: await applyPlan(req.user!.id, projectId, planId) });
  },
);
