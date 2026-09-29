// 수동 조회용. 컨테이너 이름도 포트도 외우지 않게 한다 — .env의 DATABASE_URL 하나만 본다.
//
// 이게 있는 이유: 도커 컨테이너(55432)와 호스트 PostgreSQL(5432) 양쪽에 nomos_dev라는 DB가 있을 수 있어서,
// `docker exec <컨테이너> psql -d nomos_dev`로 조회하면 앱이 실제로 쓰는 DB가 아닌 쪽을 보게 된다.
// 문서에 경고를 적어도 걸린다. 그래서 고를 여지를 없앴다.
//
// 사용법:
//   npm run db:psql                          -- 접속 대상과 테이블 목록
//   npm run db:psql -- "SELECT * FROM users" -- 임의 SQL
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';

const DEFAULT_SQL = `
SELECT table_name AS "테이블",
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', table_name),
                                            false, true, '')))[1]::text::int AS "행"
  FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
 ORDER BY table_name`;

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

// 열 너비를 맞춰 psql처럼 보이게 찍는다. 의존성을 늘리지 않으려고 직접 만든다.
function printRows(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    out('(0 rows)');
    return;
  }
  const columns = Object.keys(rows[0]!);
  const cell = (value: unknown): string =>
    value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const width = (name: string): number =>
    Math.max(name.length, ...rows.map((r) => cell(r[name]).length));

  out(columns.map((c) => c.padEnd(width(c))).join(' | '));
  out(columns.map((c) => '-'.repeat(width(c))).join('-+-'));
  for (const row of rows) out(columns.map((c) => cell(row[c]).padEnd(width(c))).join(' | '));
  out(`(${rows.length} rows)`);
}

async function main(): Promise<void> {
  const sql = process.argv.slice(2).join(' ').trim();
  const target = new URL(env.DATABASE_URL);

  // 어디에 붙었는지 항상 먼저 찍는다. 이 한 줄이 이 스크립트의 핵심이다.
  out(`-- ${target.hostname}:${target.port || '5432'}${target.pathname}  (.env의 DATABASE_URL)`);
  out();

  const result = await pool.query(sql || DEFAULT_SQL);
  // 여러 문장을 넣으면 pg가 결과 배열을 돌려준다.
  for (const part of Array.isArray(result) ? result : [result]) {
    printRows(part.rows as Record<string, unknown>[]);
    out();
  }
}

main()
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
