// 시드는 TRUNCATE로 시작한다. 로컬에서 실수로 원격 DATABASE_URL을 가리킨 채 돌리면
// 팀 전체 데이터가 날아간다 — 그래서 localhost가 아니면 거부하고, --allow-remote를 명시했을 때만 진행한다.
//
// "원격이면 경고만 찍고 진행"으로 두지 않는 이유: 경고는 스크롤에 묻히고, TRUNCATE는 되돌릴 수 없다.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export type DbTarget = { host: string; local: boolean };

export function describeDatabaseTarget(databaseUrl: string): DbTarget {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    // 읽을 수 없는 주소는 로컬이라고 가정하지 않는다.
    return { host: '(해석 불가)', local: false };
  }
  // postgres:///db?host=/var/run/postgresql 처럼 소켓 경로를 쓰면 로컬이다.
  const socketHost = url.searchParams.get('host');
  if (url.hostname === '' && (socketHost === null || socketHost.startsWith('/'))) {
    return { host: socketHost ?? '(기본 소켓)', local: true };
  }
  const host = socketHost ?? url.hostname;
  return { host, local: LOCAL_HOSTS.has(host.toLowerCase()) };
}

// 운영 migrate가 DB에 박아 두는 표시(src/migrate.ts의 nomos_meta). 호스트명과 무관하게 따라온다 —
// SSM 포트 포워딩으로 RDS를 localhost:15432로 보고 있어도 여기서 걸린다.
// 로컬 DB에는 이 테이블이 없다 — 없으면 "표시 없음"이다.
export type Queryable = { query(sql: string): Promise<{ rows: any[] }> };

export async function readEnvironmentMarker(db: Queryable): Promise<string | null> {
  const { rows: t } = await db.query(`SELECT to_regclass('nomos_meta') IS NOT NULL AS exists`);
  if (!t[0]?.exists) return null;
  const { rows } = await db.query(`SELECT value FROM nomos_meta WHERE key = 'environment'`);
  return rows[0]?.value ?? null;
}

export async function assertNotMarkedProduction(db: Queryable, argv: readonly string[]): Promise<boolean> {
  const production = (await readEnvironmentMarker(db)) === 'production';
  if (production && !argv.includes('--allow-remote')) {
    throw new Error(
      '이 DB는 운영으로 표시돼 있다(nomos_meta.environment = production). localhost로 보여도 포트 포워딩일 수 있다.\n' +
        '시드는 모든 테이블을 TRUNCATE한다. 정말 비우려면 --allow-remote를 붙여라.',
    );
  }
  return production;
}

export function assertSeedTargetAllowed(databaseUrl: string, argv: readonly string[]): DbTarget {
  const target = describeDatabaseTarget(databaseUrl);
  if (!target.local && !argv.includes('--allow-remote')) {
    throw new Error(
      `DATABASE_URL이 로컬이 아니다 (host: ${target.host}). 시드는 모든 테이블을 TRUNCATE한다.\n` +
        '정말 이 DB를 비우려면 --allow-remote를 붙여라: npm run seed -- --allow-remote',
    );
  }
  return target;
}
