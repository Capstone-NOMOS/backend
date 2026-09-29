import { Router } from 'express';
import { z } from 'zod';
import { login, rotateConnectKey, signup } from '../domain/auth/service.js';
import { getMe } from '../domain/org/service.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

export const authRouter = Router();

const signupBodySchema = z.object({
  loginId: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/),
  password: z.string().min(8).max(256),
  nickname: z.string().trim().min(1).max(64),
});

// POST /api/auth/signup — 로컬 계정 가입. 연결 키 평문은 이 응답에서 한 번만 나간다.
authRouter.post('/auth/signup', validate({ body: signupBodySchema }), async (req, res) => {
  const result = await signup(req.body);
  res.set('Cache-Control', 'no-store').status(201).json({ data: result });
});

const loginBodySchema = z.object({
  loginId: z.string().min(1),
  password: z.string().min(1),
});

// POST /api/auth/login
authRouter.post('/auth/login', validate({ body: loginBodySchema }), async (req, res) => {
  const result = await login(req.body);
  res.set('Cache-Control', 'no-store').status(200).json({ data: result });
});

// GET /api/me — 내 계정·조직·조직 역할. 조직이 없으면 orgId·orgName·orgRole이 null이다.
authRouter.get('/me', authenticate, async (req, res) => {
  res.set('Cache-Control', 'no-store').status(200).json({ data: await getMe(req.user!.id) });
});

// POST /api/me/connect-key/rotate — 새 키 발급, 기존 키 즉시 무효.
authRouter.post('/me/connect-key/rotate', authenticate, async (req, res) => {
  const result = await rotateConnectKey(req.user!.id);
  res.set('Cache-Control', 'no-store').status(200).json({ data: result });
});
