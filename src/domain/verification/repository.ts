import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';

// V1A 계약(OpenAPI) 대조 · V1B 실제 응답 · V2 PM 시험지 · V3 경로 검사 · V4 린트
export const VERIFICATION_STAGES = ['V1A', 'V1B', 'V2', 'V3', 'V4', 'INTEGRATION'] as const;
export type VerificationStage = (typeof VERIFICATION_STAGES)[number];

// SKIPPED는 PASS가 아니다. "못 돌렸다"를 통과로 적으면 M5가 조용히 부풀려진다.
export const VERIFICATION_RESULTS = ['PASS', 'FAIL', 'SKIPPED'] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export type Verification = {
  id: string;
  artifactId: string;
  stage: VerificationStage;
  result: VerificationResult;
  executedBy: 'server' | 'bridge';
  detail: Record<string, unknown>;
  durationMs: number | null;
};

function toVerification(row: QueryResultRow): Verification {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    stage: row.stage,
    result: row.result,
    executedBy: row.executed_by,
    detail: row.detail,
    durationMs: row.duration_ms,
  };
}

export type VerificationInput = {
  artifactId: string;
  stage: VerificationStage;
  result: VerificationResult;
  executedBy: 'server' | 'bridge';
  detail: Record<string, unknown>;
  durationMs?: number | null;
};

// 중복 보고는 조용히 덮어쓰지 않는다. 같은 단계를 두 번 적으면 FAIL을 PASS로 갈아치울 수 있다 —
// 재제출은 attempt가 올라간 새 artifact이고, 그쪽에 새 행이 생긴다.
// null을 돌려주면 이미 기록된 것이다 (uq_verifications_stage).
export async function insertVerification(
  db: Queryable,
  input: VerificationInput,
): Promise<Verification | null> {
  const { rows } = await db.query(
    `INSERT INTO verifications (artifact_id, stage, result, executed_by, detail, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ON CONSTRAINT uq_verifications_stage DO NOTHING
     RETURNING *`,
    [
      input.artifactId,
      input.stage,
      input.result,
      input.executedBy,
      JSON.stringify(input.detail),
      input.durationMs ?? null,
    ],
  );
  const row = rows[0];
  return row ? toVerification(row) : null;
}

export async function listVerifications(db: Queryable, artifactId: string): Promise<Verification[]> {
  const { rows } = await db.query(
    `SELECT * FROM verifications WHERE artifact_id = $1 ORDER BY stage`,
    [artifactId],
  );
  return rows.map(toVerification);
}
