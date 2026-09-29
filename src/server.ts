import { createApp } from './app.js';
import { pool } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { assertSchemaUpToDate } from './config/migrations.js';

// 서버 기동. 로컬(index.ts, npm run dev)과 운영(boot.ts server)이 같은 경로를 탄다.
// 스키마가 코드보다 뒤처져 있으면 뜨지 않는다 — assertSchemaUpToDate 주석 참고.
export async function startServer(): Promise<void> {
  await assertSchemaUpToDate(pool);
  const app = createApp();
  await new Promise<void>((resolve) => {
    app.listen(env.PORT, () => {
      logger.info(`server listening on port ${env.PORT}`, {
        commitInspector: env.COMMIT_INSPECTOR,
        docs: env.DOCS_ENABLED ? (env.DOCS_BASIC_AUTH ? 'basic-auth' : 'open') : 'off',
      });
      resolve();
    });
  });
}
