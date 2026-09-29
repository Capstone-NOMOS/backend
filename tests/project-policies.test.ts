import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/config/db.js';
import { createTestOrg, createTestProject, createTestUser } from './fixtures.js';
import { reapplyFrom, resetSchema, rollbackFrom, testPool, truncateAll } from './test-db.js';

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

// 프로젝트 생성이 할 일: 정책표의 해당 레벨 열을 17행 그대로 복사한다.
// 판정은 action_catalog가 아니라 이 사본만 본다 — 정책표가 나중에 바뀌어도 리플레이가 재현된다.
async function copyPolicies(projectId: string, preset: 'L1' | 'L2' | 'L3' | 'L4'): Promise<number> {
  const column = { L1: 'mode_l1', L2: 'mode_l2', L3: 'mode_l3', L4: 'mode_l4' }[preset];
  const { rowCount } = await pool.query(
    `INSERT INTO project_policies (project_id, action_key, mode, lock_key)
     SELECT $1, action_key, ${column}, lock_key FROM action_catalog`,
    [projectId],
  );
  return rowCount ?? 0;
}

async function setup() {
  const { userId, orgId } = await createTestOrg('rep');
  const projectId = await createTestProject({ orgId, userId });
  return { userId, orgId, projectId };
}

describe('project_policies', () => {
  it('정책표 17행을 레벨 열 그대로 복사한다', async () => {
    const { projectId } = await setup();

    expect(await copyPolicies(projectId, 'L2')).toBe(17);

    // 사본이 원본의 L2 열과 한 행도 어긋나지 않아야 한다.
    const { rows } = await pool.query(
      `SELECT p.action_key FROM project_policies p
         JOIN action_catalog a USING (action_key)
        WHERE p.mode <> a.mode_l2`,
    );
    expect(rows).toEqual([]);
  });

  it('🔒 행의 판정을 바꾸면 CHECK 위반이다 — 대표도 못 바꾼다', async () => {
    const { projectId } = await setup();
    await copyPolicies(projectId, 'L4');

    // deploy는 FORBIDDEN 🔒. L4(가장 느슨한 레벨)에서도 잠겨 있다.
    const deploy = await pool.query(
      `SELECT mode FROM project_policies WHERE project_id = $1 AND action_key = 'deploy'`,
      [projectId],
    );
    expect(deploy.rows[0]!.mode).toBe('FORBIDDEN');

    await expect(
      pool.query(`UPDATE project_policies SET mode = 'AUTO' WHERE action_key = 'deploy'`),
    ).rejects.toThrow(/project_policies_locked_chk/);
  });

  it("lock_key를 '-'로 낮춰 잠금을 우회하려 하면 FK가 막는다", async () => {
    const { projectId } = await setup();
    await copyPolicies(projectId, 'L4');

    // CHECK만 있으면 "이 행은 원래 안 잠겨 있었다"고 주장해 통과할 수 있다.
    // lock_key가 action_catalog와 복합 FK로 묶여 있어 그 주장 자체가 거짓이 된다.
    await expect(
      pool.query(`UPDATE project_policies SET mode = 'AUTO', lock_key = '-' WHERE action_key = 'deploy'`),
    ).rejects.toThrow(/project_policies_lock_fk/);

    // mode까지 맞춰 "이 행은 원래 FORBIDDEN 잠금이었다"고 위장하면 CHECK는 통과한다.
    // 그 거짓말을 잡는 것이 FK다 — git:pr_open의 실제 lock_key는 '-'이다.
    await expect(
      pool.query(
        `UPDATE project_policies SET mode = 'FORBIDDEN', lock_key = 'FORBIDDEN' WHERE action_key = 'git:pr_open'`,
      ),
    ).rejects.toThrow(/project_policies_lock_fk/);

    // lock_key만 어긋나게 두면 FK까지 가기 전에 CHECK가 먼저 잡는다.
    await expect(
      pool.query(`UPDATE project_policies SET lock_key = 'FORBIDDEN' WHERE action_key = 'git:pr_open'`),
    ).rejects.toThrow(/project_policies_locked_chk/);
  });

  it('잠기지 않은 행은 대표가 조정할 수 있다', async () => {
    const { projectId } = await setup();
    await copyPolicies(projectId, 'L3');

    await pool.query(
      `UPDATE project_policies SET mode = 'HUMAN' WHERE project_id = $1 AND action_key = 'contract:propose'`,
      [projectId],
    );
    const { rows } = await pool.query(
      `SELECT mode FROM project_policies WHERE project_id = $1 AND action_key = 'contract:propose'`,
      [projectId],
    );
    expect(rows[0]!.mode).toBe('HUMAN');
  });

  it('없는 행동 키와 없는 판정 어휘는 들어가지 않는다', async () => {
    const { projectId } = await setup();

    await expect(
      pool.query(
        `INSERT INTO project_policies (project_id, action_key, mode, lock_key)
         VALUES ($1, 'deploy:prod', 'AUTO', '-')`,
        [projectId],
      ),
    ).rejects.toThrow(/project_policies_action_key_fkey/);

    await expect(
      pool.query(
        `INSERT INTO project_policies (project_id, action_key, mode, lock_key)
         VALUES ($1, 'git:pr_open', 'MAYBE', '-')`,
        [projectId],
      ),
    ).rejects.toThrow(/project_policies_mode_chk/);
  });

  it('프로젝트를 지우면 정책 사본도 함께 지워진다', async () => {
    const { projectId } = await setup();
    await copyPolicies(projectId, 'L1');

    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM project_policies`);
    expect(rows[0]!.n).toBe(0);
  });
});

describe('spec_tests', () => {
  async function createSpec(projectId: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO specs (project_id, feature_key, title, content)
       VALUES ($1, 'F-03', '참여신청', 'WHEN …') RETURNING id`,
      [projectId],
    );
    return rows[0]!.id as string;
  }

  it('명세를 지우면 시험지도 함께 지워진다', async () => {
    const { projectId } = await setup();
    const specId = await createSpec(projectId);

    await pool.query(
      `INSERT INTO spec_tests (spec_id, criterion, test_code)
       VALUES ($1, 'IF 정원 초과 THEN 409', 'it(...)')`,
      [specId],
    );
    await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM spec_tests`);
    expect(rows[0]!.n).toBe(0);
  });

  it('잠기기 전(locked_at NULL)과 잠긴 뒤를 구분해 저장한다', async () => {
    const { projectId } = await setup();
    const specId = await createSpec(projectId);

    const { rows } = await pool.query(
      `INSERT INTO spec_tests (spec_id, criterion, test_code)
       VALUES ($1, 'IF 정원 초과 THEN 409', 'it(...)') RETURNING locked_at`,
      [specId],
    );
    expect(rows[0]!.locked_at).toBeNull();

    await pool.query(`UPDATE spec_tests SET locked_at = now() WHERE spec_id = $1`, [specId]);
    const locked = await pool.query(`SELECT locked_at FROM spec_tests WHERE spec_id = $1`, [specId]);
    expect(locked.rows[0]!.locked_at).not.toBeNull();
  });
});

describe('oauth_sessions', () => {
  it('사용자를 지우면 세션도 함께 지워진다', async () => {
    const userId = await createTestUser('dev1');

    await pool.query(
      `INSERT INTO oauth_sessions (user_id, github_token_enc, scope) VALUES ($1, 'enc:…', 'repo')`,
      [userId],
    );
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM oauth_sessions`);
    expect(rows[0]!.n).toBe(0);
  });
});

describe('007_spec_tests_policies_oauth', () => {
  it('down 후 다시 up 할 수 있다', async () => {
    const hasLockKey = async () =>
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_name = 'action_catalog' AND column_name = 'lock_key'`,
        )
      ).rows[0]!.n === 1;

    await rollbackFrom('007_spec_tests_policies_oauth.sql');
    expect(await hasLockKey()).toBe(false);

    await reapplyFrom('007_spec_tests_policies_oauth.sql');
    expect(await hasLockKey()).toBe(true);
    // 생성 컬럼이라 되살아날 때 17행이 자동으로 다시 채워진다.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM action_catalog WHERE lock_key <> '-'`,
    );
    expect(rows[0]!.n).toBe(5);
  });
});
