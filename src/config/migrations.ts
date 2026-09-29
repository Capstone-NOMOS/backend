import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Queryable } from './db.js';

// 마이그레이션 파일 위치. src/config/(tsx)와 dist/config/(빌드 후) 어디서든 저장소 루트의 migrations/다.
// 도커 이미지에서도 /app/dist 옆에 /app/migrations를 둔다.
export function migrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
}

// node-pg-migrate가 기록하는 이름은 확장자를 뺀 파일명이다(001_init).
const MIGRATION_FILE = /^(\d+_[\w-]+)\.(sql|js|ts)$/;

export function listMigrationNames(dir: string = migrationsDir()): string[] {
  return readdirSync(dir)
    .map((file) => MIGRATION_FILE.exec(file)?.[1])
    .filter((name): name is string => name !== undefined)
    .sort();
}

// 서버 기동 전에 부른다. 이미지에 들어 있는 마이그레이션이 DB에 전부 적용됐는지 확인하고,
// 아니면 **뜨지 않는다.** 틀린 스키마로 떠서 요청마다 "relation does not exist"를 내는 것보다
// 기동 로그 한 줄로 멈추는 편이 원인을 바로 보여준다.
//
// 마이그레이션을 자동으로 돌리지는 않는다 — 실패하면 컨테이너가 재시작을 반복하며 서버가 계속 죽어 있다.
// 대신 deploy.sh가 `migrate`를 먼저 돌리고, 잊으면 여기서 막힌다(잊을 여지를 도구로 없앤다).
export async function assertSchemaUpToDate(
  db: Queryable,
  options: { dir?: string; table?: string } = {},
): Promise<void> {
  const table = options.table ?? 'pgmigrations';
  const expected = listMigrationNames(options.dir);

  const exists = await db.query(`SELECT to_regclass($1) AS t`, [table]);
  if (exists.rows[0]?.t === null) {
    throw new Error(
      `마이그레이션이 한 번도 적용되지 않았다(${table} 없음). 먼저 migrate를 돌려라 — 배포는 deploy.sh, 로컬은 npm run migrate up`,
    );
  }

  // 테이블 이름은 바인딩할 수 없다. 호출부가 넘기는 상수이고 위에서 존재도 확인했다.
  const { rows } = await db.query(`SELECT name FROM ${table}`);
  const applied = new Set(rows.map((r) => r.name as string));
  const missing = expected.filter((name) => !applied.has(name));
  if (missing.length > 0) {
    throw new Error(
      `마이그레이션 미적용: ${missing.join(', ')}. 서버를 띄우기 전에 migrate를 돌려라 — 배포는 deploy.sh, 로컬은 npm run migrate up`,
    );
  }
}
