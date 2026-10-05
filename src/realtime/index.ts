import type { Server } from 'node:http';
import { env } from '../config/env.js';
import { compileOriginRules } from '../middleware/cors.js';
import { attachAgentStream } from './agent-stream.js';
import { startEventFeed } from './event-feed.js';
import { attachUserStream } from './user-stream.js';

// 실시간 경로를 한 번에 붙인다 — 에이전트 태스크 스트림(/api/agents/stream)과 사람용 신호 스트림(/api/stream).
// 같은 포트·같은 HTTP 서버의 upgrade로 받는다(운영은 Caddy가 그대로 넘긴다). 연결 목록이 메모리라 서버 1대 전제다 —
// 다만 신호원(LISTEN/NOTIFY)은 이미 DB를 거치므로, 여러 대로 늘려도 사람용 스트림은 각 서버가 같은 채널을 들으면 된다.

export type Realtime = { ready: Promise<void>; close(): Promise<void> };

export function attachRealtime(server: Server, options: { databaseUrl?: string } = {}): Realtime {
  const agents = attachAgentStream(server);
  const users = attachUserStream(server, {
    allowedOrigins: compileOriginRules(env.CORS_ALLOWED_ORIGINS),
    selfOrigin: env.API_BASE_URL ? new URL(env.API_BASE_URL).origin : null,
  });
  const feed = startEventFeed({
    onEvent: users.onEvent,
    onResync: users.resync,
    ...(options.databaseUrl ? { connectionString: options.databaseUrl } : {}),
  });
  return {
    ready: feed.ready,
    close: async () => {
      await feed.close();
      await users.close();
      await agents.close();
    },
  };
}
