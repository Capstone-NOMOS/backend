import { Router } from 'express';
import { z } from 'zod';
import { completeGithubDeviceFlow, startGithubDeviceFlow } from '../domain/oauth/service.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

export const oauthRouter = Router();

// POST /api/auth/github/device/start — 사용자 코드와 인증 URL을 받아온다.
// device_code는 응답으로 내보내고 서버에 남기지 않는다. CLI가 poll 때 되돌려준다.
oauthRouter.post('/auth/github/device/start', authenticate, async (_req, res) => {
  const code = await startGithubDeviceFlow();
  res.set('Cache-Control', 'no-store').json({ data: code });
});

const pollBodySchema = z.object({ deviceCode: z.string().min(1) });

// POST /api/auth/github/device/poll — CLI가 interval마다 부른다.
// pending·slow_down·expired·denied도 200으로 답한다. 폴링의 정상적인 중간 상태이기 때문이다.
oauthRouter.post(
  '/auth/github/device/poll',
  authenticate,
  validate({ body: pollBodySchema }),
  async (req, res) => {
    const result = await completeGithubDeviceFlow(req.user!.id, req.body.deviceCode);
    res.set('Cache-Control', 'no-store').json({ data: result });
  },
);
