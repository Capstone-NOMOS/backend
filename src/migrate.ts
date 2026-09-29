import { runner } from 'node-pg-migrate';
import { pool } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { migrationsDir } from './config/migrations.js';

// 운영 DB에 "이건 운영이다" 표시를 남긴다. 시드(scripts/seed-manual.ts)가 TRUNCATE 전에 이걸 읽고 거부한다.
//
// 호스트명 검사만으로는 부족하다: SSM 포트 포워딩으로 RDS를 보면 DATABASE_URL이 localhost:15432가 되어
// "로컬"로 통과한다. 표시는 DB 쪽에 있어야 어떤 경로로 붙든 따라온다. migrate가 매번 박으므로 잊을 수 없다.
//
// DB 파라미터(ALTER DATABASE ... SET nomos.environment)가 아니라 테이블 한 줄로 남긴다.
// PG15+에서 사용자 정의 파라미터를 DB 단위로 설정하려면 superuser가 필요한데, RDS 마스터 사용자는
// superuser가 아니라서 거부된다("permission denied to set parameter").
// 이 테이블을 시드의 TRUNCATE 목록에 넣지 말 것 — 표시가 스스로 지워진다.
export const ENVIRONMENT_TABLE = 'nomos_meta';

async function markProductionDatabase(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS nomos_meta (key text PRIMARY KEY, value text NOT NULL)`);
  await pool.query(
    `INSERT INTO nomos_meta (key, value) VALUES ('environment', 'production')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  await pool.end();
}

// 운영용 마이그레이션. `npm run migrate`(CLI)와 같은 파일·같은 기록 테이블을 쓴다.
//
// CLI를 따로 부르지 않고 같은 프로세스에서 돌리는 이유: 비밀값은 boot.ts가 SSM에서 process.env로
// 적재하는데, 별도 프로세스로 띄운 CLI는 그 값을 받지 못한다. 로컬에서 `npm run migrate`가
// env.ts를 거치지 않아 .env를 따로 읽혀야 했던 것과 같은 사고다.
//
// node-pg-migrate는 advisory lock을 잡고, 파일마다 트랜잭션으로 감싼다. 중간에 실패하면
// 그 파일은 롤백되고 앞선 파일들만 적용된 채로 남는다.
export async function runMigrations(): Promise<void> {
  const applied = await runner({
    databaseUrl: env.DATABASE_URL,
    dir: migrationsDir(),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    log: (msg: string) => logger.info(msg),
  });
  logger.info('migrations applied', { count: applied.length, names: applied.map((m) => m.name) });

  if (env.NODE_ENV === 'production') {
    await markProductionDatabase();
    logger.info('database marked as production', { table: ENVIRONMENT_TABLE });
  }
}
