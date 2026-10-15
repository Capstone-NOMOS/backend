import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  approveContract,
  failContractDraft,
  listContractJobs,
  listProjectContracts,
  reviseContract,
  submitContractDraft,
} from '../domain/contract/service.js';
import { CONTRACT_YAML_MAX } from '../domain/contract/validate.js';
import type { UserContext } from '../domain/project/visibility.js';
import { agentContextOf, authenticateAgent } from '../middleware/agent-auth.js';
import { authenticate, orgIdOf } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

// API 계약(023, 새 계획 흐름 2단계). BE 노트북의 에이전트가 초안을 쓰고(에이전트 토큰), BE 개발자가 확정·수정 요청한다(사람 토큰).
// 이유는 domain/contract/service.ts.
export const contractsRouter = Router();

function actorOf(req: Request): UserContext {
  return { userId: req.user!.id, orgId: orgIdOf(req), orgRole: req.user!.orgRole };
}

const projectParams = z.object({ projectId: z.string().uuid() });
const contractParams = z.object({ contractId: z.string().uuid() });

// GET /api/projects/:projectId/contracts — 프로젝트의 API 계약(프로젝트를 볼 수 있는 사람 누구나).
contractsRouter.get('/projects/:projectId/contracts', validate({ params: projectParams }), authenticate, async (req, res) => {
  const { projectId } = req.params as z.infer<typeof projectParams>;
  res.status(200).json({ data: { contracts: await listProjectContracts(actorOf(req), projectId) } });
});

// POST /api/contracts/:contractId/approve — 확정(BE 담당, 없으면 대표). 초안일 때만.
contractsRouter.post('/contracts/:contractId/approve', validate({ params: contractParams }), authenticate, async (req, res) => {
  const { contractId } = req.params as z.infer<typeof contractParams>;
  res.status(200).json({ data: await approveContract(actorOf(req), contractId) });
});

const reviseBody = z.object({ feedback: z.string().trim().min(1).max(4000).nullable().optional() });

// POST /api/contracts/:contractId/revise — 수정 요청(초안·실패에서). BE 노트북이 다음 회차를 다시 쓴다.
contractsRouter.post(
  '/contracts/:contractId/revise',
  validate({ params: contractParams, body: reviseBody }),
  authenticate,
  async (req, res) => {
    const { contractId } = req.params as z.infer<typeof contractParams>;
    const { feedback } = req.body as z.infer<typeof reviseBody>;
    res.status(200).json({ data: await reviseContract(actorOf(req), contractId, feedback ?? null) });
  },
);

// GET /api/agents/me/contract-jobs — BE 노트북이 쓸 계약 작업(작성 대기)·앞서 확정한 계약·읽을 레포. BACKEND가 아니면 빈 목록.
contractsRouter.get('/agents/me/contract-jobs', authenticateAgent, async (req, res) => {
  res.status(200).json({ data: await listContractJobs(agentContextOf(req)) });
});

const draftBody = z.object({
  attempt: z.number().int().min(1),
  openapiYaml: z.string().min(1).max(CONTRACT_YAML_MAX),
  summary: z.string().trim().min(1).max(4000),
  openQuestions: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
});

// POST /api/contracts/:contractId/draft — 초안 제출(BE 에이전트). 형식이 틀리면 422 CONTRACT_INVALID(위반 목록).
contractsRouter.post(
  '/contracts/:contractId/draft',
  authenticateAgent,
  validate({ params: contractParams, body: draftBody }),
  async (req, res) => {
    const { contractId } = req.params as z.infer<typeof contractParams>;
    res.status(200).json({ data: await submitContractDraft(agentContextOf(req), contractId, req.body as z.infer<typeof draftBody>) });
  },
);

const failBody = z.object({ attempt: z.number().int().min(1), reason: z.string().trim().min(1).max(2000) });

// POST /api/contracts/:contractId/failure — 초안을 못 냈다(BE 에이전트). BE 개발자가 수정 요청으로 다시 시킬 수 있다.
contractsRouter.post(
  '/contracts/:contractId/failure',
  authenticateAgent,
  validate({ params: contractParams, body: failBody }),
  async (req, res) => {
    const { contractId } = req.params as z.infer<typeof contractParams>;
    res.status(200).json({ data: await failContractDraft(agentContextOf(req), contractId, req.body as z.infer<typeof failBody>) });
  },
);
