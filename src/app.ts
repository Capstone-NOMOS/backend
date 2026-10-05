import express, { type Express } from 'express';
import { pool } from './config/db.js';
import { env } from './config/env.js';
import { compileOriginRules, cors, type OriginRule } from './middleware/cors.js';
import { errorHandler } from './middleware/error-handler.js';
import { agentsRouter } from './routes/agents.js';
import { approvalsRouter } from './routes/approvals.js';
import { authRouter } from './routes/auth.js';
import { docsRouter, type DocsOptions } from './routes/docs.js';
import { invitesRouter } from './routes/invites.js';
import { notesRouter } from './routes/notes.js';
import { oauthRouter } from './routes/oauth.js';
import { orgsRouter } from './routes/orgs.js';
import { projectsRouter } from './routes/projects.js';
import { specsRouter } from './routes/specs.js';
import { pmRouter } from './routes/pm.js';
import { repoPathsRouter } from './routes/repo-paths.js';
import { reposRouter } from './routes/repos.js';
import { tasksRouter } from './routes/tasks.js';

export type AppOptions = {
  corsRules: OriginRule[];
  // null이면 /docs를 마운트하지 않는다.
  docs: DocsOptions | null;
};

// 기본값은 env에서 읽는다. 테스트는 옵션을 직접 넘겨 process.env를 건드리지 않고 조합을 바꾼다.
export function appOptionsFromEnv(): AppOptions {
  return {
    // 잘못된 패턴은 여기서 던진다 — 기동 시점에 죽어야 운영 중에 조용히 막히지 않는다.
    corsRules: compileOriginRules(env.CORS_ALLOWED_ORIGINS),
    docs: env.DOCS_ENABLED
      ? {
          ...(env.DOCS_BASIC_AUTH === undefined ? {} : { basicAuth: env.DOCS_BASIC_AUTH }),
          includeInviteToken: env.NODE_ENV === 'development',
        }
      : null,
  };
}

// 앱 조립만 한다. listen은 server.ts가 한다 — 통합 테스트가 임의 포트로 띄울 수 있어야 하기 때문이다.
export function createApp(options: AppOptions = appOptionsFromEnv()): Express {
  const app = express();
  // 운영은 Caddy 한 단 뒤에 있다. 이 설정이 없으면 req.ip가 Caddy 주소로 찍힌다(브라우저 승인 화면의 요청 IP가 쓸모없어진다).
  // 1단만 믿는다 — X-Forwarded-For의 맨 오른쪽(Caddy가 붙인 값)을 쓰므로 클라이언트가 앞에 끼운 값에 속지 않는다.
  app.set('trust proxy', 1);

  // 사전 요청(OPTIONS)이 body 파싱·라우트보다 먼저 끝나야 한다.
  app.use(cors(options.corsRules));
  app.use(express.json());

  // 배포 스크립트와 컨테이너 헬스체크가 본다. DB까지 닿는지 확인한다 — 프로세스만 살아 있고
  // DB에 못 붙는 상태를 "정상"으로 보고하면 배포가 성공한 것처럼 끝난다.
  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ data: { status: 'ok' } });
    } catch {
      res.status(503).json({ error: { code: 'DB_UNAVAILABLE', message: 'database unreachable' } });
    }
  });

  app.use('/api', authRouter);
  app.use('/api', agentsRouter);
  app.use('/api', orgsRouter);
  app.use('/api', reposRouter);
  app.use('/api', repoPathsRouter);
  app.use('/api', invitesRouter);
  app.use('/api', oauthRouter);
  app.use('/api', approvalsRouter);
  app.use('/api', tasksRouter);
  app.use('/api', notesRouter);
  app.use('/api', projectsRouter);
  app.use('/api', specsRouter);
  app.use('/api', pmRouter);

  // 수동 테스트용 Swagger UI. 켤지와 인증은 DOCS_ENABLED·DOCS_BASIC_AUTH가 정한다(NODE_ENV와 분리).
  if (options.docs !== null) {
    app.use(docsRouter(options.docs));
  }

  // 등록된 라우트 중 어느 것도 매칭되지 않은 요청.
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'route not found' } });
  });

  // AppError -> HTTP 응답 변환은 항상 마지막에 등록한다.
  app.use(errorHandler);

  return app;
}
