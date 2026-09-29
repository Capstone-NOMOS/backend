-- Up Migration
INSERT INTO action_catalog (action_key, label, rung, locked_mode) VALUES
  ('code:own_path',          '자기 소유 경로 수정',    1,  'AUTO'),
  ('test:write',             '테스트 작성',           2,  'AUTO'),
  ('contract:propose',       '계약 제안·합의',        3,  NULL),
  ('dispute:raise',          '이의제기',             4,  'AUTO'),
  ('artifact:submit',        '산출물 제출',           5,  NULL),
  ('git:pr_open',            'PR 생성',              6,  NULL),
  ('dep:add',                '외부 패키지 추가',       7,  NULL),
  ('contract:change',        'LOCKED 계약 변경',      8,  NULL),
  ('db:migration',           'DB 스키마 변경',        9,  NULL),
  ('infra:ci',               'CI·인프라 설정 변경',    10, NULL),
  ('git:merge_integration',  '통합 브랜치 머지',       11, NULL),
  ('git:merge_main',         'main 머지',            12, 'HUMAN'),
  ('deploy',                 '배포',                 13, 'FORBIDDEN');

-- Down Migration
DELETE FROM action_catalog WHERE action_key IN (
  'code:own_path', 'test:write', 'contract:propose', 'dispute:raise',
  'artifact:submit', 'git:pr_open', 'dep:add', 'contract:change',
  'db:migration', 'infra:ci', 'git:merge_integration', 'git:merge_main', 'deploy'
);
