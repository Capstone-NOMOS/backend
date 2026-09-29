import { Router } from 'express';
import { z } from 'zod';
import { connectAgent, refreshAgentToken } from '../domain/agent/service.js';
import { describeSelf } from '../domain/agent/service.js';
import { agentContextOf, authenticateAgent } from '../middleware/agent-auth.js';
import { validate } from '../middleware/validate.js';

export const agentsRouter = Router();

const connectBodySchema = z.object({
  connectKey: z.string().min(1),
  agentName: z.string().trim().min(1).max(64),
  harness: z.string().min(1).max(128),
  skills: z.array(z.string().min(1).max(64)).max(50).default([]),
  maxConcurrent: z.number().int().min(1).max(16).default(2),
});

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
