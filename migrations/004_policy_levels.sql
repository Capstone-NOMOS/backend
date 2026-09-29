-- Up Migration

-- ① action_catalog — 허용 레벨(L1~L4) 정책표.
-- "레벨"은 자율성 정도가 아니라 행동마다 누가 승인하는가를 정한 표다.
-- 프로젝트가 레벨을 고르면 mode_l1~l4 중 해당 열이 project_policies로 복사된다(Phase 2).
ALTER TABLE action_catalog
  ADD COLUMN detection text,
  ADD COLUMN mode_l1   text,
  ADD COLUMN mode_l2   text,
  ADD COLUMN mode_l3   text,
  ADD COLUMN mode_l4   text;

-- FE·BE 레포가 완전히 분리되어 통합 브랜치가 없다.
DELETE FROM action_catalog WHERE action_key = 'git:merge_integration';

-- locked_mode(🔒)는 레벨과 무관하게 고정 — 대표도 못 바꾼다.
-- 모든 레벨에서 값이 같아도 🔒가 아닌 행(code:own_path 등)은 잠그지 않는다.
INSERT INTO action_catalog (action_key, label, rung, locked_mode, detection, mode_l1, mode_l2, mode_l3, mode_l4) VALUES
  ('code:own_path',    '자기 소유 경로 수정',   1, NULL,        'diff 경로 ∈ 소유 레포',                'AUTO',      'AUTO',      'AUTO',      'AUTO'),
  ('test:write',       '테스트 작성',          2, NULL,        'diff tests/**',                       'AUTO',      'AUTO',      'AUTO',      'AUTO'),
  ('human:ask',        '사람에게 질문',         3, 'AUTO',      'MCP 호출',                             'AUTO',      'AUTO',      'AUTO',      'AUTO'),
  ('dispute:raise',    '이의제기',             4, NULL,        'MCP 호출',                             'AUTO',      'AUTO',      'AUTO',      'AUTO'),
  ('contract:propose', '계약 제안·합의',        5, NULL,        'MCP 호출',                             'HUMAN',     'PM_REVIEW', 'PM_REVIEW', 'AUTO'),
  ('artifact:submit',  '산출물 제출',          6, NULL,        'V1~V3 통과 후',                         'HUMAN',     'AUTO',      'AUTO',      'AUTO'),
  ('git:pr_open',      'PR 생성',             7, NULL,        '브릿지가 gh CLI',                       'PM_REVIEW', 'AUTO',      'AUTO',      'AUTO'),
  ('dep:add',          '외부 패키지 추가',       8, NULL,        'package.json / requirements.txt diff', 'HUMAN',     'PM_REVIEW', 'PM_REVIEW', 'AUTO'),
  ('file:delete',      '파일 삭제',            9, NULL,        'diff 삭제',                             'HUMAN',     'PM_REVIEW', 'AUTO',      'AUTO'),
  ('contract:change',  'LOCKED 계약 변경',     10, NULL,        'contracts/** diff',                    'HUMAN',     'HUMAN',     'PM_REVIEW', 'PM_REVIEW'),
  ('db:migration',     'DB 스키마 변경',       11, NULL,        'migrations/**, *.sql',                 'HUMAN',     'HUMAN',     'HUMAN',     'PM_REVIEW'),
  ('infra:ci',         'CI·인프라 설정 변경',   12, NULL,        '.github/**, Dockerfile',               'HUMAN',     'HUMAN',     'HUMAN',     'PM_REVIEW'),
  ('budget:exceed',    '예산 초과',           13, NULL,        'PM·에이전트 토큰 누적',                   'HUMAN',     'HUMAN',     'HUMAN',     'HUMAN'),
  ('git:merge_main',   'main 머지',          14, 'HUMAN',     'GitHub PR (각 레포)',                    'HUMAN',     'HUMAN',     'HUMAN',     'HUMAN'),
  ('scope:violation',  '소유 범위 밖 수정',     15, 'FORBIDDEN', 'diff 경로 ∉ 소유 레포',                  'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'),
  ('secret:touch',     '비밀 파일 접근',       16, 'FORBIDDEN', '.env*, *.pem, *secret*',               'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'),
  ('deploy',           '배포',               17, 'FORBIDDEN', '도구 미존재',                            'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN')
ON CONFLICT (action_key) DO UPDATE SET
  label       = EXCLUDED.label,
  rung        = EXCLUDED.rung,
  locked_mode = EXCLUDED.locked_mode,
  detection   = EXCLUDED.detection,
  mode_l1     = EXCLUDED.mode_l1,
  mode_l2     = EXCLUDED.mode_l2,
  mode_l3     = EXCLUDED.mode_l3,
  mode_l4     = EXCLUDED.mode_l4;

ALTER TABLE action_catalog
  ALTER COLUMN detection SET NOT NULL,
  ALTER COLUMN mode_l1   SET NOT NULL,
  ALTER COLUMN mode_l2   SET NOT NULL,
  ALTER COLUMN mode_l3   SET NOT NULL,
  ALTER COLUMN mode_l4   SET NOT NULL;

ALTER TABLE action_catalog
  ADD CONSTRAINT action_catalog_rung_key UNIQUE (rung),
  ADD CONSTRAINT action_catalog_mode_chk CHECK (
        mode_l1 IN ('AUTO','PM_REVIEW','HUMAN','FORBIDDEN')
    AND mode_l2 IN ('AUTO','PM_REVIEW','HUMAN','FORBIDDEN')
    AND mode_l3 IN ('AUTO','PM_REVIEW','HUMAN','FORBIDDEN')
    AND mode_l4 IN ('AUTO','PM_REVIEW','HUMAN','FORBIDDEN')),
  -- 🔒 행은 네 레벨 모두 잠긴 값과 같아야 한다. 표를 고치다 잠금을 깨는 실수를 DB가 막는다.
  ADD CONSTRAINT action_catalog_locked_chk CHECK (
    locked_mode IS NULL OR (
          mode_l1 = locked_mode AND mode_l2 = locked_mode
      AND mode_l3 = locked_mode AND mode_l4 = locked_mode));

-- ② repo_paths — 기존 레포의 시드 규칙을 새 탐지 기준에 맞춘다.
-- 시드 행(source='seed')만 건드리므로 대표가 손으로 추가한 행은 그대로다.

-- 비밀 파일 행의 action_key가 NULL이면 "code:own_path"로 해석된다. 🔒 FORBIDDEN이어야 한다.
UPDATE repo_paths SET action_key = 'secret:touch'
 WHERE source = 'seed' AND path_pattern IN ('.env', '.env.*');

-- 새 시드 규칙을 이미 연결된 레포에도 넣는다. 기존 '.env', '.env.*' 행은 지우지 않는다(무손실).
INSERT INTO repo_paths (id, repo_id, path_pattern, owner_role, access, action_key, priority, source)
SELECT gen_random_uuid(), r.id, s.path_pattern, NULL, s.access, s.action_key, s.priority, 'seed'
  FROM repos r
 CROSS JOIN (VALUES
   ('tests/**',         'write',  'test:write',   20),
   ('requirements.txt', 'write',  'dep:add',      50),
   ('**/*.sql',         'write',  'db:migration', 50),
   ('**/.env*',         'denied', 'secret:touch', 99),
   ('**/*.pem',         'denied', 'secret:touch', 99),
   ('**/*secret*',      'denied', 'secret:touch', 99)
 ) AS s(path_pattern, access, action_key, priority)
ON CONFLICT (repo_id, path_pattern) DO NOTHING;

-- Down Migration

DELETE FROM repo_paths
 WHERE source = 'seed'
   AND path_pattern IN ('tests/**', 'requirements.txt', '**/*.sql', '**/.env*', '**/*.pem', '**/*secret*');
UPDATE repo_paths SET action_key = NULL
 WHERE source = 'seed' AND path_pattern IN ('.env', '.env.*');

ALTER TABLE action_catalog
  DROP CONSTRAINT action_catalog_locked_chk,
  DROP CONSTRAINT action_catalog_mode_chk,
  DROP CONSTRAINT action_catalog_rung_key;

DELETE FROM action_catalog
 WHERE action_key IN ('human:ask', 'file:delete', 'budget:exceed', 'scope:violation', 'secret:touch');

-- 002 시점 행을 다시 넣기 전에 NOT NULL 컬럼부터 없앤다.
ALTER TABLE action_catalog
  DROP COLUMN mode_l4,
  DROP COLUMN mode_l3,
  DROP COLUMN mode_l2,
  DROP COLUMN mode_l1,
  DROP COLUMN detection;

INSERT INTO action_catalog (action_key, label, rung, locked_mode) VALUES
  ('code:own_path',         '자기 소유 경로 수정',  1,  'AUTO'),
  ('test:write',            '테스트 작성',         2,  'AUTO'),
  ('contract:propose',      '계약 제안·합의',       3,  NULL),
  ('dispute:raise',         '이의제기',            4,  'AUTO'),
  ('artifact:submit',       '산출물 제출',         5,  NULL),
  ('git:pr_open',           'PR 생성',            6,  NULL),
  ('dep:add',               '외부 패키지 추가',      7,  NULL),
  ('contract:change',       'LOCKED 계약 변경',    8,  NULL),
  ('db:migration',          'DB 스키마 변경',      9,  NULL),
  ('infra:ci',              'CI·인프라 설정 변경',  10, NULL),
  ('git:merge_integration', '통합 브랜치 머지',     11, NULL),
  ('git:merge_main',        'main 머지',          12, 'HUMAN'),
  ('deploy',                '배포',               13, 'FORBIDDEN')
ON CONFLICT (action_key) DO UPDATE SET
  label       = EXCLUDED.label,
  rung        = EXCLUDED.rung,
  locked_mode = EXCLUDED.locked_mode;
