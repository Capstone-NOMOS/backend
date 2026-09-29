import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withTransaction } from '../src/config/db.js';
import { createTestAgent, createTestOrg, createTestUser } from './fixtures.js';
import { assertInvariants } from './helpers/assert-invariants.js';
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

describe('008 — agents.org_id = users.org_id', () => {
  it('사용자는 조직이 있는데 에이전트가 무소속이면 INSERT가 죽는다', async () => {
    const { userId } = await createTestOrg('rep');

    // 이번에 발견된 픽스처 버그의 모양. org_id가 NULL이라 MATCH SIMPLE이면 검사를 건너뛰는 경우다.
    await expect(
      pool.query(`INSERT INTO agents (user_id, org_id, name, harness) VALUES ($1, NULL, 'laptop', 'h')`, [userId]),
    ).rejects.toThrow(/agents_user_org_fk/);
  });

  it('남의 조직으로 넣어도 죽는다', async () => {
    const { userId } = await createTestOrg('rep');
    const other = await createTestOrg('rep2', 'Other Inc.');

    await expect(
      pool.query(`INSERT INTO agents (user_id, org_id, name, harness) VALUES ($1, $2, 'laptop', 'h')`, [
        userId,
        other.orgId,
      ]),
    ).rejects.toThrow(/agents_user_org_fk/);
  });

  it('조직 가입은 사용자와 에이전트를 함께 옮겨야 통과한다', async () => {
    const { orgId } = await createTestOrg('rep');
    const userId = await createTestUser('dev');
    await createTestAgent(userId); // 사용자가 무소속이므로 에이전트도 무소속

    // 사용자만 옮기면 커밋 시점에 막힌다.
    await expect(
      withTransaction((tx) => tx.query(`UPDATE users SET org_id = $2 WHERE id = $1`, [userId, orgId])),
    ).rejects.toThrow(/agents_user_org_fk/);

    // 둘을 같은 트랜잭션에서 옮기면 통과한다 — DEFERRABLE이라 중간 상태는 문제되지 않는다.
    await withTransaction(async (tx) => {
      await tx.query(`UPDATE users SET org_id = $2 WHERE id = $1`, [userId, orgId]);
      await tx.query(`UPDATE agents SET org_id = $2 WHERE user_id = $1`, [userId, orgId]);
    });

    const { rows } = await pool.query(`SELECT org_id FROM agents WHERE user_id = $1`, [userId]);
    expect(rows[0]!.org_id).toBe(orgId);
  });

  it('down 후 다시 up 할 수 있다', async () => {
    const hasColumn = async () =>
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_name = 'agents' AND column_name = 'org_key'`,
        )
      ).rows[0]!.n === 1;

    await rollbackFrom('008_agent_org_invariant.sql');
    expect(await hasColumn()).toBe(false);

    await reapplyFrom('008_agent_org_invariant.sql');
    expect(await hasColumn()).toBe(true);
  });
});

describe('픽스처 회귀', () => {
  it('createTestAgent는 사용자와 같은 조직에 에이전트를 넣는다', async () => {
    const { userId, orgId } = await createTestOrg('rep');

    const agentId = await createTestAgent(userId);

    const { rows } = await pool.query(`SELECT org_id FROM agents WHERE id = $1`, [agentId]);
    expect(rows[0]!.org_id).toBe(orgId);
  });

  it('조직이 없는 사용자의 에이전트도 무소속으로 들어간다', async () => {
    const userId = await createTestUser('dev');

    const agentId = await createTestAgent(userId);

    const { rows } = await pool.query(`SELECT org_id FROM agents WHERE id = $1`, [agentId]);
    expect(rows[0]!.org_id).toBeNull();
  });
});

describe('불변식 검사기', () => {
  it('깨끗한 상태는 통과시킨다', async () => {
    await createTestOrg('rep');
    await expect(assertInvariants()).resolves.toBeUndefined();
  });

  it('실재하지 않는 사람에게 귀속된 이벤트를 잡는다', async () => {
    const { orgId } = await createTestOrg('rep');
    // on_behalf_of는 text라 FK가 없다 — 'system:planner' 같은 값을 허용해야 하기 때문이다.
    // DB가 못 막는 자리라서 검사기가 필요하다.
    await pool.query(
      `INSERT INTO events (org_id, type, on_behalf_of, payload)
       VALUES ($1, 'ORG_CREATED', '00000000-0000-0000-0000-000000000000', '{}'::jsonb)`,
      [orgId],
    );

    await expect(assertInvariants()).rejects.toThrow(/on_behalf_of/);

    // 전역 afterEach도 같은 검사를 돌리므로 여기서 치운다.
    await pool.query(`DELETE FROM events WHERE on_behalf_of = '00000000-0000-0000-0000-000000000000'`);
  });

  it('system:* 주체는 위반이 아니다', async () => {
    const { orgId } = await createTestOrg('rep');
    await pool.query(
      `INSERT INTO events (org_id, type, on_behalf_of, payload)
       VALUES ($1, 'ORG_CREATED', 'system:planner', '{}'::jsonb)`,
      [orgId],
    );

    await expect(assertInvariants()).resolves.toBeUndefined();
  });
});
