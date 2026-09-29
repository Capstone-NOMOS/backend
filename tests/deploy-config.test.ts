import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppOptions } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { parseEnv } from '../src/config/env.js';
import { assertSchemaUpToDate, listMigrationNames } from '../src/config/migrations.js';
import { loadParametersFromSsm, type SsmLike } from '../src/config/ssm.js';
import { createInvite } from '../src/domain/invite/service.js';
import { compileOriginRules } from '../src/middleware/cors.js';
import { createTestOrg } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

beforeAll(async () => {
  await resetSchema();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await pool.end();
  await testPool.end();
});

// 배포 설정은 "켜면 안전한 쪽으로, 빠지면 조용히 넘어가지 않는 쪽으로"가 원칙이다.
// 여기 테스트는 전부 그 원칙이 코드로 지켜지는지 본다.

let server: Server | null = null;

async function start(options: AppOptions): Promise<string> {
  server = createApp(options).listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

const BASE_ENV = {
  DATABASE_URL: 'postgres://x@localhost/db',
  JWT_SECRET: 'x'.repeat(32),
  COMMIT_INSPECTOR: 'github',
};

describe('env — 운영에서 빠지면 조용히 넘어가지 않는다', () => {
  it('COMMIT_INSPECTOR는 기본값이 없다', () => {
    const { COMMIT_INSPECTOR: _omit, ...rest } = BASE_ENV;
    expect(() => parseEnv(rest)).toThrow(/COMMIT_INSPECTOR/);
  });

  it('APP_BASE_URL이 남아 있으면 거부한다 — 두 값으로 나뉘었다', () => {
    expect(() => parseEnv({ ...BASE_ENV, APP_BASE_URL: 'http://localhost:3000' })).toThrow(/API_BASE_URL.*FRONTEND_BASE_URL/);
  });

  it('운영에서는 두 주소를 https로 명시해야 한다 — 초대 링크가 localhost로 나가지 않게', () => {
    expect(() => parseEnv({ ...BASE_ENV, NODE_ENV: 'production' })).toThrow(/API_BASE_URL.*https/);
    expect(() =>
      parseEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        API_BASE_URL: 'https://example.duckdns.org',
        FRONTEND_BASE_URL: 'http://nomos.vercel.app',
      }),
    ).toThrow(/FRONTEND_BASE_URL/);
  });

  it('운영에서 Swagger를 켜려면 Basic Auth가 필수다', () => {
    const prod = {
      ...BASE_ENV,
      NODE_ENV: 'production',
      API_BASE_URL: 'https://example.duckdns.org',
      FRONTEND_BASE_URL: 'https://nomos.vercel.app',
    };
    expect(parseEnv(prod).DOCS_ENABLED).toBe(false); // 운영 기본값은 꺼짐
    expect(() => parseEnv({ ...prod, DOCS_ENABLED: 'true' })).toThrow(/DOCS_BASIC_AUTH/);
    expect(() => parseEnv({ ...prod, DOCS_ENABLED: 'true', DOCS_BASIC_AUTH: 'team:short' })).toThrow(/12\+/);
    expect(parseEnv({ ...prod, DOCS_ENABLED: 'true', DOCS_BASIC_AUTH: 'team:long-enough-pass' }).DOCS_ENABLED).toBe(true);
  });

  it('로컬 개발은 지금처럼 동작한다 — 기본 주소, Swagger 켜짐', () => {
    const dev = parseEnv({ ...BASE_ENV, NODE_ENV: 'development' });
    expect(dev).toMatchObject({
      API_BASE_URL: 'http://localhost:3000',
      FRONTEND_BASE_URL: 'http://localhost:3001',
      DOCS_ENABLED: true,
    });
  });
});

describe('CORS', () => {
  it('프리뷰 와일드카드는 첫 라벨의 접두어로만, 고정 접미사와 함께만 허용한다', () => {
    expect(() => compileOriginRules('https://*.vercel.app')).toThrow(/wildcard/);
    expect(() => compileOriginRules('https://app.*.vercel.app')).toThrow(/wildcard/);
    expect(() => compileOriginRules('https://*-a-*.vercel.app')).toThrow(/wildcard/);
    expect(() => compileOriginRules('https://nomos.vercel.app/path')).toThrow(/not an origin/);
    expect(compileOriginRules(undefined)).toEqual([]);
  });

  it('허용 오리진에만 헤더를 붙이고, 와일드카드는 점을 넘지 않는다', async () => {
    const base = await start({
      corsRules: compileOriginRules('https://nomos.vercel.app, https://*-myteam.vercel.app'),
      docs: null,
    });
    const originOf = async (origin: string) =>
      (await fetch(`${base}/api/invites/nope`, { headers: { Origin: origin } })).headers.get('access-control-allow-origin');

    expect(await originOf('https://nomos.vercel.app')).toBe('https://nomos.vercel.app');
    expect(await originOf('https://nomos-git-feat-x-myteam.vercel.app')).toBe('https://nomos-git-feat-x-myteam.vercel.app');
    // 남의 팀 프리뷰, 점으로 라벨을 넘는 시도, 스킴 바꿔치기는 전부 거부.
    expect(await originOf('https://nomos-otherteam.vercel.app')).toBeNull();
    expect(await originOf('https://evil.com.x-myteam.vercel.app')).toBeNull();
    expect(await originOf('http://nomos.vercel.app')).toBeNull();
  });

  it('사전 요청은 라우트까지 가지 않고 204로 끝난다 — 쿠키를 쓰지 않으므로 credentials 헤더는 없다', async () => {
    const base = await start({ corsRules: compileOriginRules('https://nomos.vercel.app'), docs: null });
    const preflight = (origin: string) =>
      fetch(`${base}/api/orgs`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
      });

    const ok = await preflight('https://nomos.vercel.app');
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull();

    const denied = await preflight('https://evil.example');
    expect(denied.status).toBe(204);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('Swagger — DOCS_ENABLED + Basic Auth', () => {
  const CREDS = 'team:long-enough-pass';
  const basic = (creds: string) => `Basic ${Buffer.from(creds).toString('base64')}`;

  it('자격 없이 /docs와 openapi.json 모두 401이다', async () => {
    const base = await start({ corsRules: [], docs: { basicAuth: CREDS, includeInviteToken: false } });

    for (const p of ['/docs/', '/docs/openapi.json']) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Basic');
    }
    expect((await fetch(`${base}/docs/openapi.json`, { headers: { Authorization: basic('team:wrong-password!') } })).status).toBe(401);
    expect((await fetch(`${base}/docs/openapi.json`, { headers: { Authorization: basic(CREDS) } })).status).toBe(200);
  });

  // 초대 토큰은 id가 아니라 조직 가입 자격이다. Basic Auth 비밀번호는 팀이 공유하므로
  // 채우면 그 비밀번호가 곧 가입 자격이 된다.
  it('원격 설정에서는 미사용 초대 토큰을 example에 채우지 않는다', async () => {
    const { userId, orgId } = await createTestOrg('rep');
    const { token } = await createInvite(orgId, userId, { teamRole: 'BACKEND' });

    const remote = await start({ corsRules: [], docs: { basicAuth: CREDS, includeInviteToken: false } });
    const spec = await (await fetch(`${remote}/docs/openapi.json`, { headers: { Authorization: basic(CREDS) } })).text();
    expect(spec).not.toContain(token);
    expect(spec).toContain('{{INVITE_TOKEN}}');
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    const local = await start({ corsRules: [], docs: { includeInviteToken: true } });
    expect(await (await fetch(`${local}/docs/openapi.json`)).text()).toContain(token);
  });

  it('DOCS_ENABLED가 꺼져 있으면 /docs는 없다', async () => {
    const base = await start({ corsRules: [], docs: null });
    expect((await fetch(`${base}/docs/openapi.json`)).status).toBe(404);
  });
});

describe('/health', () => {
  it('DB까지 닿으면 ok다', async () => {
    const base = await start({ corsRules: [], docs: null });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'ok' } });
  });
});

describe('SSM 적재', () => {
  function fakeSsm(pages: { Name: string; Value: string }[][]): SsmLike & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      async send(command: GetParametersByPathCommand) {
        const token = command.input.NextToken;
        calls.push(`${command.input.Path}|${token ?? ''}|${command.input.WithDecryption}`);
        const index = token === undefined ? 0 : Number(token);
        return {
          Parameters: pages[index],
          ...(index + 1 < pages.length ? { NextToken: String(index + 1) } : {}),
        };
      },
    };
  }

  it('경로 아래 값을 페이지 끝까지 읽고, 이미 설정된 값은 덮어쓰지 않는다', async () => {
    const client = fakeSsm([
      [
        { Name: '/nomos/prod/JWT_SECRET', Value: 'from-ssm' },
        { Name: '/nomos/prod/DATABASE_URL', Value: 'postgres://rds/db' },
      ],
      [{ Name: '/nomos/prod/KMS_KEY_ID', Value: 'arn:key' }],
    ]);
    const target: NodeJS.ProcessEnv = { DATABASE_URL: 'postgres://override/db' };

    const loaded = await loadParametersFromSsm('/nomos/prod', client, target);

    expect(loaded.sort()).toEqual(['JWT_SECRET', 'KMS_KEY_ID']);
    expect(target).toEqual({
      JWT_SECRET: 'from-ssm',
      KMS_KEY_ID: 'arn:key',
      DATABASE_URL: 'postgres://override/db', // 명시한 값이 이긴다
    });
    // SecureString을 복호화해서 받는다.
    expect(client.calls).toEqual(['/nomos/prod/||true', '/nomos/prod/|1|true']);
  });

  it('환경변수 이름이 아닌 파라미터는 조용히 건너뛰지 않고 멈춘다', async () => {
    const client = fakeSsm([[{ Name: '/nomos/prod/jwt-secret', Value: 'x' }]]);
    await expect(loadParametersFromSsm('/nomos/prod/', client, {})).rejects.toThrow(/not a valid env var name/);
  });
});

describe('기동 시 스키마 버전 검사', () => {
  const TABLE = 'schema_check_test';

  function migrationsIn(names: string[]): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'nomos-migrations-'));
    for (const name of names) writeFileSync(path.join(dir, `${name}.sql`), '-- Up Migration\n');
    writeFileSync(path.join(dir, 'README.md'), 'not a migration');
    return dir;
  }

  it('저장소의 마이그레이션 목록을 번호 순서대로 읽는다', () => {
    const names = listMigrationNames();
    expect(names[0]).toBe('001_init');
    expect(names).toEqual([...names].sort());
  });

  it('기록 테이블이 없으면 뜨지 않는다', async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await expect(assertSchemaUpToDate(pool, { dir: migrationsIn(['001_a']), table: TABLE })).rejects.toThrow(
      /한 번도 적용되지 않았다/,
    );
  });

  it('이미지에 있는데 DB에 없는 마이그레이션이 있으면 이름을 대며 뜨지 않는다', async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await pool.query(`CREATE TABLE ${TABLE} (name text)`);
    await pool.query(`INSERT INTO ${TABLE} (name) VALUES ('001_a')`);
    const dir = migrationsIn(['001_a', '002_b', '003_c']);

    await expect(assertSchemaUpToDate(pool, { dir, table: TABLE })).rejects.toThrow(/002_b, 003_c/);

    await pool.query(`INSERT INTO ${TABLE} (name) VALUES ('002_b'), ('003_c')`);
    await expect(assertSchemaUpToDate(pool, { dir, table: TABLE })).resolves.toBeUndefined();
    await pool.query(`DROP TABLE ${TABLE}`);
  });
});
