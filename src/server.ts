import { createApp } from './app.js';
import { pool } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { assertSchemaUpToDate } from './config/migrations.js';
import { recoverInterruptedPlans } from './domain/pm/service.js';
import { closeOrphanedRuns } from './domain/room/runs.js';
import { startStallWatchdog } from './domain/task/stall.js';
import { startQuestionExpirySweep } from './domain/question/service.js';
import { warnUnavailableShadowRouters } from './domain/question/router-registry.js';
import { startExperimentSweep } from './domain/experiment/sweep.js';
import { attachRealtime } from './realtime/index.js';

// 서버 기동. 로컬(index.ts, npm run dev)과 운영(boot.ts server)이 같은 경로를 탄다.
// 스키마가 코드보다 뒤처져 있으면 뜨지 않는다 — assertSchemaUpToDate 주석 참고.
export async function startServer(): Promise<void> {
  await assertSchemaUpToDate(pool);
  // 서버로 뜰 때만 — migrate 단계(boot.ts migrate)에서는 옛 서버가 아직 PM 작업 중일 수 있어 건드리지 않는다.
  await recoverInterruptedPlans();
  // 연결 해제된 에이전트의 열린 실행(고아 실행)을 닫는다 — 룸에 "생각 중"이 영원히 남지 않게. 같은 이유로 서버로 뜰 때만.
  await closeOrphanedRuns();
  // 응답이 끊긴 에이전트가 잡고 있는 태스크를 멈춤(BLOCKED)으로 바꾼다 — Executor가 꺼지면 종료 보고조차 오지 않는다.
  startStallWatchdog();
  // 아무도 읽지 않은 질문도 기한이 지나면 만료시킨다 — 묻는 쪽 태스크가 "답을 기다림"에 영원히 남지 않게.
  startQuestionExpirySweep();
  // 실험 모드(034): 자동 답이 빠진 질문·검증 보고 없는 VERIFYING을 정리하고 놓친 자동 진행 신호를 메운다. 기본 모드 프로젝트는 건드리지 않는다.
  startExperimentSweep();
  warnUnavailableShadowRouters();
  const app = createApp();
  await new Promise<void>((resolve, reject) => {
    // Express 5는 포트를 열지 못해도(EADDRINUSE·EACCES) 이 콜백을 오류와 함께 부른다 — 오류를 보지 않으면 "listening"을 찍고 아무것도 받지 않는 서버가 된다.
    // Windows는 WinNAT/Hyper-V가 부팅마다 포트 구간을 예약해 EACCES가 난다(실측: 2944~3043) — `netsh interface ipv4 show excludedportrange protocol=tcp`로 보고 PORT를 바꾼다.
    const server = app.listen(env.PORT, (err?: Error) => {
      if (err) {
        logger.error(`port ${env.PORT} could not be opened`, { error: String(err) });
        reject(err);
        return;
      }
      logger.info(`server listening on port ${env.PORT}`, {
        commitInspector: env.COMMIT_INSPECTOR,
        questionRouter: env.QUESTION_ROUTER,
        shadowRouters: env.QUESTION_SHADOW_ROUTERS || 'off',
        docs: env.DOCS_ENABLED ? (env.DOCS_BASIC_AUTH ? 'basic-auth' : 'open') : 'off',
      });
      resolve();
    });
    // 웹소켓 — 에이전트 태스크 스트림과 사람용 신호 스트림. 같은 포트·같은 HTTP 서버의 upgrade로 받는다 — 운영은 Caddy가 그대로 넘긴다.
    attachRealtime(server);
  });
}
