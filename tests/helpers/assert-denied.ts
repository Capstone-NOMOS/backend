import { expect } from 'vitest';
import { pool } from '../../src/config/db.js';

export type DeniedExpectation = {
  code: string;
  stage: string;
  // 이 테이블들에 행이 남지 않아야 한다 — 거부 경로가 부분 커밋되지 않았다는 증거.
  emptyTables?: string[];
};

export type DenialRow = {
  payload: Record<string, unknown>;
  pathViolation: boolean | null;
  ownerRole: string | null;
};

// settle 패턴(도메인 서비스가 거부를 커밋하고 밖에서 던지는 구조)을 쓰는 경로는
// 두 가지를 동시에 만족해야 한다: **거부 이벤트는 남고, 상태 변경은 하나도 남지 않는다.**
// 둘 중 하나만 확인하면 "이벤트까지 롤백"(M5′ 분모 유실)이나 "부분 커밋"을 놓친다.
export async function expectDenied(
  action: Promise<unknown>,
  expected: DeniedExpectation,
): Promise<DenialRow> {
  await expect(action).rejects.toMatchObject({ code: expected.code });

  const { rows } = await pool.query(
    `SELECT payload, path_violation, owner_role FROM events
      WHERE type = 'TOOL_DENIED' ORDER BY id DESC LIMIT 1`,
  );
  const row = rows[0];
  expect(row, '거부 이벤트가 남아야 한다').toBeDefined();
  expect(row!.payload).toMatchObject({ stage: expected.stage });

  for (const table of expected.emptyTables ?? []) {
    const count = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    expect(count.rows[0]!.n, `${table}에 행이 남지 않아야 한다`).toBe(0);
  }

  return { payload: row!.payload, pathViolation: row!.path_violation, ownerRole: row!.owner_role };
}
