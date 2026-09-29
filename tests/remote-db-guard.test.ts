import { afterAll, describe, expect, it } from 'vitest';
import {
  assertNotMarkedProduction,
  assertSeedTargetAllowed,
  describeDatabaseTarget,
} from '../scripts/lib/remote-db-guard.js';
import { pool } from '../src/config/db.js';
import { testPool } from './test-db.js';

afterAll(async () => {
  await pool.end();
  await testPool.end();
});

// SSM 포트 포워딩으로 RDS를 보면 DATABASE_URL이 localhost가 된다. 호스트명 검사는 통과하므로
// 운영 migrate가 DB에 박아 둔 표시(nomos.environment)로 한 번 더 막는다.
// 공유 테스트 DB를 영구히 표시하지 않도록 임시 테이블로 흉내 낸다 — 임시 테이블은 이 연결에서만 보이고
// 같은 이름이면 먼저 찾아지므로, readEnvironmentMarker가 이 테이블을 읽는다.
describe('시드 — 운영 표시가 있는 DB', () => {
  it('localhost로 보여도 운영 표시가 있으면 --allow-remote 없이 거부한다', async () => {
    const client = await pool.connect();
    try {
      await client.query(`CREATE TEMP TABLE nomos_meta (key text PRIMARY KEY, value text NOT NULL)`);
      await client.query(`INSERT INTO nomos_meta (key, value) VALUES ('environment', 'production')`);
      await expect(assertNotMarkedProduction(client, [])).rejects.toThrow(/운영으로 표시.*포트 포워딩/s);
      await expect(assertNotMarkedProduction(client, ['--allow-remote'])).resolves.toBe(true);
    } finally {
      await client.query(`DROP TABLE IF EXISTS pg_temp.nomos_meta`);
      client.release();
    }
  });

  it('표시가 없는 로컬 DB는 그대로 통과한다', async () => {
    await expect(assertNotMarkedProduction(pool, [])).resolves.toBe(false);
  });
});

// 시드는 TRUNCATE로 시작한다. 원격을 가리킨 채 돌리면 팀 전체 데이터가 날아가므로
// "로컬이 확실할 때만" 통과시킨다 — 판단이 안 서면 원격으로 본다.
describe('시드 원격 DB 보호', () => {
  it('localhost·127.0.0.1·::1·소켓은 로컬이다', () => {
    for (const url of [
      'postgres://postgres:postgres@localhost:5432/nomos_dev',
      'postgres://u:p@127.0.0.1:55432/nomos_test',
      'postgres://u:p@[::1]:5432/db',
      'postgres:///nomos_dev?host=/var/run/postgresql',
    ]) {
      expect(describeDatabaseTarget(url).local).toBe(true);
    }
  });

  it('그 밖은 전부 원격이다 — RDS, 호스트명, 읽을 수 없는 주소', () => {
    for (const url of [
      'postgres://u:p@nomos.abc123.ap-northeast-2.rds.amazonaws.com:5432/nomos',
      'postgres://u:p@db:5432/nomos',
      'postgres://u:p@localhost.evil.com/x',
      'postgres:///nomos_dev?host=db.internal',
      'not a url',
    ]) {
      expect(describeDatabaseTarget(url).local).toBe(false);
    }
  });

  it('원격이면 --allow-remote 없이는 거부하고, 호스트를 알려준다', () => {
    const rds = 'postgres://u:p@nomos.abc123.ap-northeast-2.rds.amazonaws.com:5432/nomos';

    expect(() => assertSeedTargetAllowed(rds, [])).toThrow(/nomos\.abc123.*--allow-remote/s);
    expect(assertSeedTargetAllowed(rds, ['--allow-remote'])).toMatchObject({ local: false });
    expect(assertSeedTargetAllowed('postgres://u:p@localhost/db', [])).toMatchObject({ local: true });
  });

  it('비밀번호는 에러 메시지에 나오지 않는다', () => {
    const err = (() => {
      try {
        assertSeedTargetAllowed('postgres://admin:SuperSecret123@rds.example.com/db', []);
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err?.message).not.toContain('SuperSecret123');
  });
});
