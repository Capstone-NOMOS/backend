import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/config/db.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { createTestOrg } from './fixtures.js';
import { readMigration, reapplyFrom, resetSchema, rollbackFrom, testPool, truncateAll } from './test-db.js';

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

async function isNullable(table: string, column: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows[0]?.is_nullable === 'YES';
}

async function tableExists(table: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT to_regclass($1) AS t`, [table]);
  return rows[0]?.t !== null;
}

describe('003_local_accounts_and_agents', () => {
  it('users.org_id, github_id, github_login이 NULL을 허용한다', async () => {
    expect(await isNullable('users', 'org_id')).toBe(true);
    expect(await isNullable('users', 'github_id')).toBe(true);
    expect(await isNullable('users', 'github_login')).toBe(true);
  });

  it('events에 실험 컬럼 8개가 있다', async () => {
    const columns = [
      'run_id',
      'arm',
      'injected_fault',
      'policy_hash',
      'token_cost',
      'latency_ms',
      'path_violation',
      'owner_role',
    ];
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'events' AND column_name = ANY($1)`,
      [columns],
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual([...columns].sort());
  });

  it('repo_paths.owner_role에 QA를 넣으면 CHECK 위반이다', async () => {
    const { userId, orgId } = await createTestOrg('rep');
    const [repo] = await connectRepos({ orgId, actorUserId: userId, repos: [{ fullName: 'acme/web' }] });

    await expect(
      pool.query(`UPDATE repo_paths SET owner_role = 'QA' WHERE repo_id = $1`, [repo!.id]),
    ).rejects.toThrow(/repo_paths_owner_role_chk/);
  });

  it('invites.team_role에 QA를 넣으면 CHECK 위반이다', async () => {
    const { userId, orgId } = await createTestOrg('rep');

    await expect(
      pool.query(
        `INSERT INTO invites (id, org_id, token, team_role, created_by, expires_at)
         VALUES (gen_random_uuid(), $1, 'tok', 'QA', $2, now() + interval '1 day')`,
        [orgId, userId],
      ),
    ).rejects.toThrow(/invites_role_chk/);
  });

  // 스키마를 바꾸는 테스트라 마지막에 둔다.
  it('down으로 되돌렸다가 다시 up 할 수 있다', async () => {
    // 뒤 마이그레이션이 agents·users를 참조하므로 003까지 역순으로 함께 내린다.
    await rollbackFrom('003_local_accounts_and_agents.sql');
    expect(await tableExists('agents')).toBe(false);
    expect(await isNullable('users', 'org_id')).toBe(false);

    await reapplyFrom('003_local_accounts_and_agents.sql');
    expect(await tableExists('agents')).toBe(true);
    expect(await tableExists('project_members')).toBe(true);
    expect(await isNullable('users', 'org_id')).toBe(true);
  });
});

describe('004_policy_levels', () => {
  it('action_catalog에 정책표 17행이 있고 통합 브랜치 머지는 없다', async () => {
    const { rows } = await pool.query(`SELECT action_key FROM action_catalog ORDER BY rung`);
    expect(rows).toHaveLength(17);
    expect(rows.map((r) => r.action_key)).not.toContain('git:merge_integration');
    expect(rows[0]!.action_key).toBe('code:own_path');
    expect(rows[16]!.action_key).toBe('deploy');
  });

  it('🔒 행은 5개다', async () => {
    const { rows } = await pool.query(
      `SELECT action_key, locked_mode FROM action_catalog WHERE locked_mode IS NOT NULL ORDER BY rung`,
    );
    expect(rows).toEqual([
      { action_key: 'human:ask', locked_mode: 'AUTO' },
      { action_key: 'git:merge_main', locked_mode: 'HUMAN' },
      { action_key: 'scope:violation', locked_mode: 'FORBIDDEN' },
      { action_key: 'secret:touch', locked_mode: 'FORBIDDEN' },
      { action_key: 'deploy', locked_mode: 'FORBIDDEN' },
    ]);
  });

  it('레벨별 판정이 정책표와 같다', async () => {
    const { rows } = await pool.query(
      `SELECT action_key, mode_l1, mode_l2, mode_l3, mode_l4 FROM action_catalog
        WHERE action_key IN ('contract:propose', 'git:pr_open', 'file:delete', 'db:migration', 'budget:exceed')
        ORDER BY rung`,
    );
    const modes = Object.fromEntries(rows.map((r) => [r.action_key, [r.mode_l1, r.mode_l2, r.mode_l3, r.mode_l4]]));
    expect(modes).toEqual({
      'contract:propose': ['HUMAN', 'PM_REVIEW', 'PM_REVIEW', 'AUTO'],
      'git:pr_open': ['PM_REVIEW', 'AUTO', 'AUTO', 'AUTO'],
      'file:delete': ['HUMAN', 'PM_REVIEW', 'AUTO', 'AUTO'],
      'db:migration': ['HUMAN', 'HUMAN', 'HUMAN', 'PM_REVIEW'],
      'budget:exceed': ['HUMAN', 'HUMAN', 'HUMAN', 'HUMAN'],
    });
  });

  it('🔒 행의 레벨 판정을 바꾸면 CHECK 위반이다', async () => {
    await expect(
      pool.query(`UPDATE action_catalog SET mode_l4 = 'AUTO' WHERE action_key = 'deploy'`),
    ).rejects.toThrow(/action_catalog_locked_chk/);
  });

  it('down 후 다시 up 하면 이미 연결된 레포의 시드 규칙도 보강된다', async () => {
    const { userId, orgId } = await createTestOrg('rep');
    const [repo] = await connectRepos({ orgId, actorUserId: userId, repos: [{ fullName: 'acme/web' }] });
    const countPaths = async () =>
      (await pool.query(`SELECT count(*)::int AS n FROM repo_paths WHERE repo_id = $1`, [repo!.id])).rows[0]!.n;
    const m004 = readMigration('004_policy_levels.sql');
    const m005 = readMigration('005_path_priority_bands.sql');

    // 005가 004 위에 올라가 있으므로 역순으로 내린다.
    await pool.query(m005.down);
    expect(await countPaths()).toBe(13);
    await pool.query(m004.down);
    expect(await countPaths()).toBe(7);
    const legacy = await pool.query(`SELECT count(*)::int AS n FROM action_catalog`);
    expect(legacy.rows[0]!.n).toBe(13);

    await pool.query(m004.up);
    expect(await countPaths()).toBe(13);
    const secret = await pool.query(
      `SELECT action_key FROM repo_paths WHERE repo_id = $1 AND path_pattern = '**/.env*'`,
      [repo!.id],
    );
    expect(secret.rows[0]!.action_key).toBe('secret:touch');

    await pool.query(m005.up);
    expect(await countPaths()).toBe(15);
  });
});

describe('005_path_priority_bands', () => {
  const patternsOf = async (repoId: string) =>
    (
      await pool.query(`SELECT path_pattern, priority, source FROM repo_paths WHERE repo_id = $1 ORDER BY priority`, [
        repoId,
      ])
    ).rows;

  it('구 시드·오탐 행을 지우고, manual 행을 대역으로 옮기고, priority를 유일하게 만든다', async () => {
    const { userId, orgId } = await createTestOrg('rep');
    const [repo] = await connectRepos({ orgId, actorUserId: userId, repos: [{ fullName: 'acme/web' }] });
    const m005 = readMigration('005_path_priority_bands.sql');

    // 004 시점 상태를 재현: 005를 내리고, 004가 무손실로 남겼던 구 시드 행과 대역 밖 manual 행을 넣는다.
    await pool.query(m005.down);
    await pool.query(
      `INSERT INTO repo_paths (id, repo_id, path_pattern, owner_role, access, action_key, priority, source) VALUES
         (gen_random_uuid(), $1, '.env',   NULL, 'denied', 'secret:touch', 99, 'seed'),
         (gen_random_uuid(), $1, '.env.*', NULL, 'denied', 'secret:touch', 99, 'seed'),
         (gen_random_uuid(), $1, 'api/**', 'BACKEND', 'write', NULL, 14, 'manual')`,
      [repo!.id],
    );

    await pool.query(m005.up);

    const rows = await patternsOf(repo!.id);
    const patterns = rows.map((r) => r.path_pattern);
    expect(patterns).not.toContain('.env');
    expect(patterns).not.toContain('.env.*');
    expect(patterns).not.toContain('**/*secret*');
    expect(patterns).not.toContain('package.json');
    expect(patterns).not.toContain('package-lock.json');
    expect(patterns).toEqual(expect.arrayContaining(['**/.env.example', '**/secrets/**', '**/*.key', '**/id_rsa*']));
    expect(rows).toHaveLength(16); // 시드 15 + manual 1
    expect(rows.find((r) => r.path_pattern === 'api/**')).toEqual({ path_pattern: 'api/**', priority: 200, source: 'manual' });
    expect(new Set(rows.map((r) => r.priority)).size).toBe(rows.length);
  });

  it('레포 안에서 priority가 겹치면 유니크 인덱스 위반이다', async () => {
    const { userId, orgId } = await createTestOrg('rep');
    const [repo] = await connectRepos({ orgId, actorUserId: userId, repos: [{ fullName: 'acme/web' }] });

    await expect(
      pool.query(
        `INSERT INTO repo_paths (id, repo_id, path_pattern, owner_role, access, action_key, priority, source)
         VALUES (gen_random_uuid(), $1, 'extra/**', NULL, 'write', NULL, 10, 'seed')`,
        [repo!.id],
      ),
    ).rejects.toThrow(/uq_repo_paths_priority/);
  });

  it('source와 맞지 않는 대역은 CHECK 위반이다', async () => {
    const { userId, orgId } = await createTestOrg('rep');
    const [repo] = await connectRepos({ orgId, actorUserId: userId, repos: [{ fullName: 'acme/web' }] });

    await expect(
      pool.query(
        `INSERT INTO repo_paths (id, repo_id, path_pattern, owner_role, access, action_key, priority, source)
         VALUES (gen_random_uuid(), $1, 'extra/**', NULL, 'denied', NULL, 910, 'manual')`,
        [repo!.id],
      ),
    ).rejects.toThrow(/repo_paths_priority_band_chk/);
  });
});
