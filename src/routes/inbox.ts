import { Router, type Request } from 'express';
import { z } from 'zod';
import { listInbox, listNotifications, markNotificationsRead } from '../domain/inbox/service.js';
import type { UserContext } from '../domain/project/visibility.js';
import { authenticate, orgIdOf } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

// 받은 편지함 — 알림(일어난 일, events에서 계산)과 처리할 일(지금 상태에서 계산). 이유는 domain/inbox/service.ts.

export const inboxRouter = Router();

function actorOf(req: Request): UserContext {
  return { userId: req.user!.id, orgId: orgIdOf(req), orgRole: req.user!.orgRole };
}

// 이벤트 id(bigint) — 문자열로 주고받는다(JS number로는 2^53을 넘으면 틀린다).
const eventId = z.union([z.string().regex(/^\d{1,18}$/), z.number().int().nonnegative().transform((n) => String(n))]);

const notificationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().regex(/^\d{1,18}$/).optional(),
});

// GET /api/me/notifications — 최신순, before(이벤트 id)로 더 보기.
inboxRouter.get('/me/notifications', validate({ query: notificationsQuery }), authenticate, async (req, res) => {
  const { limit, before } = req.query as unknown as z.infer<typeof notificationsQuery>;
  res.status(200).json({ data: await listNotifications(actorOf(req), { limit, before: before ?? null }) });
});

// POST /api/me/notifications/read — 읽음 커서를 앞으로 민다(없으면 지금 최신까지). 이벤트를 남기지 않는다.
const readBody = z.object({ upToEventId: eventId.optional() }).strict().optional();

inboxRouter.post('/me/notifications/read', validate({ body: readBody }), authenticate, async (req, res) => {
  const body = req.body as z.infer<typeof readBody>;
  res.status(200).json({ data: await markNotificationsRead(actorOf(req), body?.upToEventId ?? null) });
});

// GET /api/me/inbox — 처리할 일. 오래된 것부터.
inboxRouter.get('/me/inbox', authenticate, async (req, res) => {
  res.status(200).json({ data: await listInbox(actorOf(req)) });
});
