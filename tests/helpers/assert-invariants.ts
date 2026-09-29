import pg from 'pg';

const { Pool } = pg;

// 검사 전용 풀. 테스트 파일들이 afterAll에서 자기 풀을 닫으므로 그것과 섞이면 안 된다.
let pool: pg.Pool | null = null;

function db(): pg.Pool {
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  return pool;
}

// CHECK·유니크 인덱스로는 표현할 수 없는 불변식들. 표현할 수 있는 것은 이미 DB가 막고 있으므로
// 여기 있을 이유가 없다 — 여기 있는 건 "테이블 여러 개를 가로질러야 알 수 있는 것"뿐이다.
//
// 왕복 한 번으로 끝낸다. 테스트마다 도는 비용이라 쿼리 수가 곧 실행 시간이다.
const INVARIANT_SQL = `
SELECT 'repo_paths: priority 대역 ↔ source' AS invariant,
       (SELECT count(*)::int FROM repo_paths
         WHERE NOT ((source = 'seed'   AND (priority BETWEEN 0 AND 99 OR priority >= 900))
                 OR (source = 'scan'   AND priority BETWEEN 100 AND 199)
                 OR (source = 'manual' AND priority BETWEEN 200 AND 299))) AS violations
UNION ALL
SELECT 'repo_paths: priority는 레포 안에서 유일',
       (SELECT count(*)::int FROM (
          SELECT repo_id FROM repo_paths GROUP BY repo_id, priority HAVING count(*) > 1) d)
UNION ALL
SELECT 'project_members: 역할당 1명',
       (SELECT count(*)::int FROM (
          SELECT project_id FROM project_members GROUP BY project_id, team_role HAVING count(*) > 1) d)
UNION ALL
SELECT 'events.on_behalf_of: 실재 사용자이거나 system:*',
       (SELECT count(*)::int FROM events e
         WHERE e.on_behalf_of NOT LIKE 'system:%'
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id::text = e.on_behalf_of))
UNION ALL
SELECT 'tasks: BLOCKED ⟺ blocked_reason',
       (SELECT count(*)::int FROM tasks WHERE (state = 'BLOCKED') <> (blocked_reason IS NOT NULL))
UNION ALL
SELECT 'agents.org_id = users.org_id',
       (SELECT count(*)::int FROM agents a JOIN users u ON u.id = a.user_id
         WHERE a.org_id IS DISTINCT FROM u.org_id)
`;

export async function assertInvariants(): Promise<void> {
  let rows: { invariant: string; violations: number }[];
  try {
    ({ rows } = await db().query(INVARIANT_SQL));
  } catch (err) {
    // 스키마가 아직 없거나 내려간 순간(마이그레이션 down 테스트 도중)은 검사할 대상이 없다.
    if (err instanceof Error && 'code' in err && (err as { code?: string }).code === '42P01') return;
    throw err;
  }

  const broken = rows.filter((r) => r.violations > 0);
  if (broken.length > 0) {
    const detail = broken.map((r) => `  - ${r.invariant}: ${r.violations}행`).join('\n');
    throw new Error(`DB 불변식이 깨졌습니다:\n${detail}`);
  }
}

export async function closeInvariantPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
