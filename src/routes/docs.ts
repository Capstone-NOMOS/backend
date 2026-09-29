import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { pool } from '../config/db.js';
import { basicAuth } from '../middleware/basic-auth.js';
import { openApiSpec } from '../openapi/spec.js';

export type DocsOptions = {
  // 원격에서 켤 때는 필수다(env.ts가 운영에서 강제한다). 로컬 개발에서는 없어도 된다.
  basicAuth?: string;
  // 미사용 초대 토큰을 example에 채울지. 채우면 문서를 보는 사람 누구나 조직에 들어올 수 있다 —
  // Basic Auth 비밀번호는 팀이 공유하므로 그 비밀번호가 곧 조직 가입 자격이 된다. 로컬 개발에서만 켠다.
  includeInviteToken: boolean;
};

// 수동 테스트용 Swagger UI. 켤지 말지는 app.ts가 DOCS_ENABLED로 정한다.
export function docsRouter(options: DocsOptions): Router {
  const router = Router();

  // /docs 아래 전부(UI·openapi.json)를 같은 문지기 뒤에 둔다. 브라우저는 같은 경로 공간에
  // 캐시된 Basic 자격을 openapi.json 요청에도 붙이므로 UI가 따로 로그인을 묻지 않는다.
  if (options.basicAuth !== undefined) {
    router.use('/docs', basicAuth(options.basicAuth));
  }

  // setup보다 먼저 등록해야 한다 — swaggerUi.serve가 /docs 아래를 모두 가져간다.
  // 요청마다 DB에서 id를 읽어 example을 채운다. 시드를 다시 돌린 뒤엔 새로고침만 하면 된다.
  router.get('/docs/openapi.json', async (_req, res) => {
    res
      .set('Cache-Control', 'no-store')
      .json(await openApiSpec(pool, { includeInviteToken: options.includeInviteToken }));
  });

  router.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(undefined, {
      // persistAuthorization: 새로고침해도 Authorize에 넣은 토큰이 유지된다.
      swaggerOptions: { url: '/docs/openapi.json', persistAuthorization: true, displayRequestDuration: true },
      customSiteTitle: 'NOMOS API (수동 테스트)',
    }),
  );

  return router;
}
