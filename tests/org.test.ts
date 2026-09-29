import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/config/db.js';
import { insertUser } from '../src/domain/org/repository.js';
import { createOrganization } from '../src/domain/org/service.js';
import { createTestOrg, createTestUser } from './fixtures.js';
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

describe('createOrganization', () => {
  it('생성자가 REPRESENTATIVE가 되고 users.org_id가 채워진다', async () => {
    const { userId, orgId } = await createTestOrg('founder');

    const { rows } = await pool.query('SELECT org_id, org_role FROM users WHERE id = $1', [userId]);
    expect(rows[0]!.org_id).toBe(orgId);
    expect(rows[0]!.org_role).toBe('REPRESENTATIVE');
  });

  it('organizations.created_by와 users.org_id가 서로를 가리킨다', async () => {
    const { userId, orgId } = await createTestOrg('founder');

    const org = await pool.query('SELECT created_by FROM organizations WHERE id = $1', [orgId]);
    const user = await pool.query('SELECT org_id FROM users WHERE id = $1', [userId]);
    expect(org.rows[0]!.created_by).toBe(userId);
    expect(user.rows[0]!.org_id).toBe(orgId);
  });

  it('ORG_CREATED 이벤트의 on_behalf_of가 생성자 UUID다', async () => {
    const { userId, orgId } = await createTestOrg('founder');

    const { rows } = await pool.query(`SELECT on_behalf_of FROM events WHERE org_id = $1 AND type = 'ORG_CREATED'`, [
      orgId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.on_behalf_of).toBe(userId);
  });

  it('두 번째 REPRESENTATIVE 생성 시도가 유니크 제약에 걸린다', async () => {
    const { orgId } = await createTestOrg('founder');

    await expect(
      insertUser(pool, { id: randomUUID(), orgId, orgRole: 'REPRESENTATIVE', loginId: 'second-rep' }),
    ).rejects.toThrow(/uq_representative/);
  });

  it('이미 조직에 속한 사용자는 조직을 또 만들 수 없고, 만들다 만 조직 행도 남지 않는다', async () => {
    const { userId } = await createTestOrg('founder');

    await expect(createOrganization(userId, 'Second Org')).rejects.toMatchObject({
      code: 'ALREADY_IN_ORG',
      status: 409,
    });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM organizations WHERE name = 'Second Org'`);
    expect(rows[0]!.n).toBe(0);
  });

  it('조직 이름이 공백뿐이면 거부한다', async () => {
    const userId = await createTestUser('founder');
    await expect(createOrganization(userId, '   ')).rejects.toMatchObject({ code: 'ORG_NAME_REQUIRED' });
  });
});
