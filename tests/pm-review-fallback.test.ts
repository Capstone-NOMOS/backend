import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withTransaction } from '../src/config/db.js';
import {
  decideGateWithoutPm,
  gateWhenPmUnavailable,
  type PolicyMode,
} from '../src/domain/policy/pm-review-fallback.js';
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

describe('gateWhenPmUnavailable', () => {
  it('PM_REVIEW만 AUTO로 강등한다', () => {
    expect(gateWhenPmUnavailable('PM_REVIEW', null)).toEqual({ gate: 'AUTO', degraded: true });
  });

  it.each<PolicyMode>(['HUMAN', 'FORBIDDEN', 'AUTO'])('%s는 절대 강등하지 않는다', (mode) => {
    expect(gateWhenPmUnavailable(mode, null)).toEqual({ gate: mode, degraded: false });
  });

  it('🔒 행은 강등 원천 제외', () => {
    // 정책표 CHECK상 🔒 행이 PM_REVIEW일 수는 없지만, 값이 무엇이든 잠금이 먼저다.
    expect(gateWhenPmUnavailable('PM_REVIEW', 'HUMAN')).toEqual({ gate: 'PM_REVIEW', degraded: false });
    expect(gateWhenPmUnavailable('FORBIDDEN', 'FORBIDDEN')).toEqual({ gate: 'FORBIDDEN', degraded: false });
  });
});

describe('decideGateWithoutPm', () => {
  it('강등하면 사유와 policy_hash를 담아 PM_REVIEW_DEGRADED를 남긴다', async () => {
    const { userId, orgId } = await createTestOrg('rep');

    const decision = await withTransaction((tx) =>
      decideGateWithoutPm(tx, {
        orgId,
        onBehalfOf: userId,
        actionKey: 'dep:add',
        mode: 'PM_REVIEW',
        lockedMode: null,
        reason: 'budget_exhausted',
        policyHash: 'abc123',
        subjectId: '22222222-2222-2222-2222-222222222222',
      }),
    );

    expect(decision).toEqual({ gate: 'AUTO', degraded: true });
    const { rows } = await pool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'PM_REVIEW_DEGRADED'`);
    expect(rows).toEqual([
      {
        on_behalf_of: userId,
        payload: {
          actionKey: 'dep:add',
          reason: 'budget_exhausted',
          policyHash: 'abc123',
          from: 'PM_REVIEW',
          to: 'AUTO',
          subjectId: '22222222-2222-2222-2222-222222222222',
        },
      },
    ]);
  });

  it('강등이 없으면 이벤트도 없다', async () => {
    const { userId, orgId } = await createTestOrg('rep');

    const decision = await withTransaction((tx) =>
      decideGateWithoutPm(tx, {
        orgId,
        onBehalfOf: userId,
        actionKey: 'db:migration',
        mode: 'HUMAN',
        lockedMode: null,
        reason: 'pm_timeout',
        policyHash: 'abc123',
      }),
    );

    expect(decision).toEqual({ gate: 'HUMAN', degraded: false });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'PM_REVIEW_DEGRADED'`);
    expect(rows[0]!.n).toBe(0);
  });
});
