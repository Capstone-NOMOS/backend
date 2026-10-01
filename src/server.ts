import { createApp } from './app.js';
import { pool } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { assertSchemaUpToDate } from './config/migrations.js';
import { recoverInterruptedPlans } from './domain/pm/service.js';
import { attachAgentStream } from './realtime/agent-stream.js';

// 서버 기동. 로컬(index.ts, npm run dev)과 운영(boot.ts server)이 같은 경로를 탄다.
// 스키마가 코드보다 뒤처져 있으면 뜨지 않는다 — assertSchemaUpToDate 주석 참고.
export async function startServer(): Promise<void> {
  await assertSchemaUpToDate(pool);
  // 서버로 뜰 때만 — migrate 단계(boot.ts migrate)에서는 옛 서버가 아직 PM 작업 중일 수 있어 건드리지 않는다.
  await recoverInterruptedPlans();
  const app = createApp();
  await new Promise<void>((resolve) => {
    const server = app.listen(env.PORT, () => {
      logger.info(`server listening on port ${env.PORT}`, {
        commitInspector: env.COMMIT_INSPECTOR,
        docs: env.DOCS_ENABLED ? (env.DOCS_BASIC_AUTH ? 'basic-auth' : 'open') : 'off',
      });
      resolve();
    });
    // 에이전트 태스크 스트림(웹소켓). 같은 포트·같은 HTTP 서버의 upgrade로 받는다 — 운영은 Caddy가 그대로 넘긴다.
    attachAgentStream(server);
  });
}
