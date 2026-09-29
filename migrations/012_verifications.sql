-- Up Migration
-- V1A~V4 검증 결과. ERD에는 있었지만 실제 테이블에는 없던 것이다(011의 organizations.constitution과 같은 상황).

-- 서버가 커밋의 **실제** diff를 읽을 곳. 제출자가 신고한 changed_paths를 믿지 않기 위한 전제다.
-- 운영에서는 https://github.com/... 이고, 로컬 개발에서는 파일 경로일 수 있다.
-- NULL이면 V3를 돌릴 수 없으므로 SKIPPED로 기록된다 — 조용히 통과시키지 않는다.
ALTER TABLE repos ADD COLUMN clone_url text;

CREATE TABLE verifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  stage       text NOT NULL,
  result      text NOT NULL,
  executed_by text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms integer,
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- V1A 계약(OpenAPI) 대조 · V1B 실제 응답 · V2 PM 시험지 · V3 경로 검사 · V4 린트
  CONSTRAINT verifications_stage_chk CHECK (stage IN ('V1A', 'V1B', 'V2', 'V3', 'V4', 'INTEGRATION')),
  -- SKIPPED가 세 번째 값인 이유: "못 돌렸다"를 PASS로 적으면 M5 계산이 조용히 부풀려진다.
  CONSTRAINT verifications_result_chk CHECK (result IN ('PASS', 'FAIL', 'SKIPPED')),
  -- server 실행분(V1A·V1B·V3)이 "로컬을 신뢰하지 않아도 되는 검증"이다.
  CONSTRAINT verifications_executor_chk CHECK (executed_by IN ('server', 'bridge')),
  -- 건너뛴 이유를 반드시 남긴다. 사유 없는 SKIPPED는 나중에 PASS와 구분되지 않는다.
  CONSTRAINT verifications_skip_reason_chk CHECK (result <> 'SKIPPED' OR detail ? 'reason'),
  -- 한 산출물의 한 단계는 한 번만. 재제출은 attempt가 올라간 **새 artifact**다.
  CONSTRAINT uq_verifications_stage UNIQUE (artifact_id, stage)
);
CREATE INDEX idx_verifications_artifact ON verifications(artifact_id, stage);

-- Down Migration
DROP TABLE IF EXISTS verifications;
ALTER TABLE repos DROP COLUMN IF EXISTS clone_url;
