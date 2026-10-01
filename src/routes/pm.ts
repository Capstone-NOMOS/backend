import { Router } from 'express';
import { z } from 'zod';
import {
  applyPlan,
  getPlan,
  listProjectPlans,
  requestPlan,
  revisePlan,
  failRelayJob,
  rejectPlan,
  submitRelayResult,
  takeRelayJob,
} from '../domain/pm/service.js';
import { authenticateAgent } from '../middleware/agent-auth.js';
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

// 본문은 없어도 된다(사유는 선택). 본문 없이 보내면 req.body가 undefined라 빈 객체로 받는다.
const rejectBody = z
  .object({ reason: z.string().trim().min(1).max(1000).optional() })
  .strict()
  .optional()
  .transform((b) => b ?? {});

// POST /api/projects/:projectId/pm/plans/:planId/reject — ready 초안을 버린다. 다시 받으려면 revise(수정 요청)를 쓴다.
pmRouter.post(
  '/projects/:projectId/pm/plans/:planId/reject',
  validate({ params: planParams, body: rejectBody }),
  authenticate,
  requireRepresentative,
  async (req, res) => {
    const { projectId, planId } = req.params as z.infer<typeof planParams>;
    const { reason } = req.body as z.infer<typeof rejectBody>;
    res.status(200).json({ data: await rejectPlan(req.user!.id, projectId, planId, reason ?? null) });
  },
);

// ── 중계 모드(PM_PROVIDER=relay) — 대표 노트북의 `executor pm-worker`가 부른다. API 모드에서는 409 PM_RELAY_DISABLED.

// GET /api/pm/jobs/next — 그 조직의 다음 모델 호출 작업을 가져간다(대표 본인의 에이전트만). 없으면 job: null.
pmRouter.get('/pm/jobs/next', authenticateAgent, async (req, res) => {
  res.status(200).json({ data: { job: await takeRelayJob(req.agent!) } });
});

const jobParams = z.object({ jobId: z.string().uuid() });
const relayResultBody = z
  .object({
    // 모델의 종료 사유. refusal·max_tokens면 서버가 refused·truncated로 처리한다(교정하지 않는다).
    stopReason: z.string().max(64).nullable(),
    servedModel: z.string().max(128).nullable(),
    // 모델이 낸 JSON 텍스트 그대로. 해석·검증은 서버가 한다.
    text: z.string().max(2_000_000),
    usage: z.object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cacheWriteTokens: z.number().int().nonnegative(),
      cacheReadTokens: z.number().int().nonnegative(),
    }),
  })
  .strict();

// POST /api/pm/jobs/:jobId/result — 실행 결과를 돌려준다. 이후 흐름(해석·검증·교정·저장)은 API 모드와 같다.
pmRouter.post(
  '/pm/jobs/:jobId/result',
  authenticateAgent,
  validate({ params: jobParams, body: relayResultBody }),
  async (req, res) => {
    const { jobId } = req.params as z.infer<typeof jobParams>;
    await submitRelayResult(req.agent!, jobId, req.body as z.infer<typeof relayResultBody>);
    res.status(200).json({ data: { accepted: true } });
  },
);

const relayFailureBody = z.object({ message: z.string().min(1).max(2000) }).strict();

// POST /api/pm/jobs/:jobId/failure — 노트북에서 실행이 실패했다. 시간 제한까지 기다리지 않고 계획을 failed(api_error)로 닫는다.
pmRouter.post(
  '/pm/jobs/:jobId/failure',
  authenticateAgent,
  validate({ params: jobParams, body: relayFailureBody }),
  async (req, res) => {
    const { jobId } = req.params as z.infer<typeof jobParams>;
    await failRelayJob(req.agent!, jobId, (req.body as z.infer<typeof relayFailureBody>).message);
    res.status(200).json({ data: { accepted: true } });
  },
);
