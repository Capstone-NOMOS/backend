import { Router } from 'express';
import { z } from 'zod';
import { connectAgent, listOrgAgents, refreshAgentToken } from '../domain/agent/service.js';
import {
  decideDeviceRequestByUser,
  getDeviceRequest,
  pollDeviceFlow,
  startDeviceFlow,
} from '../domain/agent/device-service.js';
import { describeSelf } from '../domain/agent/service.js';
import { agentContextOf, authenticateAgent } from '../middleware/agent-auth.js';
import { authenticate, requireSameOrg } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

export const agentsRouter = Router();

// 에이전트 자체의 정보. 연결 키 경로와 브라우저 승인 경로가 같다.
const agentSpecSchema = z.object({
  agentName: z.string().trim().min(1).max(64),
  harness: z.string().min(1).max(128),
  skills: z.array(z.string().min(1).max(64)).max(50).default([]),
  maxConcurrent: z.number().int().min(1).max(16).default(2),
});

const connectBodySchema = agentSpecSchema.extend({ connectKey: z.string().min(1) });

// POST /api/agents/connect — CLI 연결. 사람 로그인 대신 개인 연결 키로 인증한다.
agentsRouter.post('/agents/connect', validate({ body: connectBodySchema }), async (req, res) => {
  const result = await connectAgent(req.body);
  res.set('Cache-Control', 'no-store').status(201).json({ data: result });
});

const refreshBodySchema = z.object({ refreshToken: z.string().min(1) });

// POST /api/agents/token/refresh
agentsRouter.post('/agents/token/refresh', validate({ body: refreshBodySchema }), async (req, res) => {
  const result = await refreshAgentToken(req.body.refreshToken);
  res.set('Cache-Control', 'no-store').status(200).json({ data: result });
});

// GET /api/agents/me — Executor가 자기 설정(동시 실행 상한·프로젝트·역할)을 읽는다.
// 토큰에 담지 않는 이유는 max_concurrent가 바뀌어도 만료를 기다리지 않게 하기 위해서다.
agentsRouter.get('/agents/me', authenticateAgent, async (req, res) => {
  res.json({ data: await describeSelf(agentContextOf(req)) });
});

const orgIdParamsSchema = z.object({ orgId: z.string().uuid() });

// GET /api/orgs/:orgId/agents — 조직의 에이전트 목록(사람 토큰, 조직 멤버 누구나).
// 역할 배정 화면이 고를 agentId와 "이미 다른 프로젝트에 배정됨"을 여기서 읽는다.
agentsRouter.get(
  '/orgs/:orgId/agents',
  validate({ params: orgIdParamsSchema }),
  authenticate,
  requireSameOrg,
  async (req, res) => {
    const { orgId } = req.params as z.infer<typeof orgIdParamsSchema>;
    res.status(200).json({ data: { agents: await listOrgAgents(orgId) } });
  },
);

// ── 브라우저 승인(device flow, RFC 8628) ─────────────────────────────────
// CLI: start → 코드 출력·브라우저 열기 → poll. 웹: 로그인된 사람이 확인하고 승인·거부. 연결 키 경로는 SSH 등 브라우저가 없는 환경용으로 남는다.

// POST /api/agents/device/start — 인증 없음(CLI는 아직 자격 증명이 없다). deviceCode는 이 응답에서 한 번만 나간다.
agentsRouter.post('/agents/device/start', validate({ body: agentSpecSchema }), async (req, res) => {
  // 승인 화면에 보여 줄 요청 IP. 운영은 Caddy 뒤라 app의 trust proxy 설정이 있어야 실제 클라이언트 IP가 잡힌다.
  const result = await startDeviceFlow(req.body as z.infer<typeof agentSpecSchema>, req.ip ?? null);
  res.set('Cache-Control', 'no-store').status(201).json({ data: result });
});

// POST /api/agents/device/poll — 인증 없음. pending·slow_down·expired·denied도 200(폴링의 정상적인 중간 상태).
agentsRouter.post(
  '/agents/device/poll',
  validate({ body: z.object({ deviceCode: z.string().min(1).max(256) }) }),
  async (req, res) => {
    res.set('Cache-Control', 'no-store').status(200).json({ data: await pollDeviceFlow(req.body.deviceCode as string) });
  },
);

const userCodeParamsSchema = z.object({ userCode: z.string().min(1).max(32) });

// GET /api/agents/device/requests/:userCode — 승인 화면이 보여 줄 정보(사람 토큰).
agentsRouter.get(
  '/agents/device/requests/:userCode',
  validate({ params: userCodeParamsSchema }),
  authenticate,
  async (req, res) => {
    const { userCode } = req.params as z.infer<typeof userCodeParamsSchema>;
    res.status(200).json({ data: await getDeviceRequest(userCode) });
  },
);

// POST /api/agents/device/requests/:userCode/approve · /deny — 사람 토큰. 조직이 없어도 된다.
for (const [action, decision] of [
  ['approve', 'APPROVED'],
  ['deny', 'DENIED'],
] as const) {
  agentsRouter.post(
    `/agents/device/requests/:userCode/${action}`,
    validate({ params: userCodeParamsSchema }),
    authenticate,
    async (req, res) => {
      const { userCode } = req.params as z.infer<typeof userCodeParamsSchema>;
      res.status(200).json({ data: await decideDeviceRequestByUser(req.user!.id, userCode, decision) });
    },
  );
}
