-- Up Migration

-- repo_paths는 append-only 대상이 아니다. 과거 판정은 artifacts.triggered_actions / gate_mode가
-- 사실로 고정하므로 규칙 행을 지워도 지난 판정 재현성은 깨지지 않는다.

-- ① 004가 무손실로 남겨둔 구 시드 행 정리 — '**/.env*'가 이미 덮는다.
DELETE FROM repo_paths WHERE source = 'seed' AND path_pattern IN ('.env', '.env.*');

-- ② 오탐 규칙 폐기.
--   '**/*secret*'   secretary.ts 같은 평범한 파일까지 막았다.
--   package.json    의존성 추가 판정은 경로가 아니라 dependencies/devDependencies diff로 한다.
--   package-lock.json  lock 갱신만으로 dep:add가 걸렸다.
DELETE FROM repo_paths
 WHERE source = 'seed' AND path_pattern IN ('**/*secret*', 'package.json', 'package-lock.json');

-- ③ priority 대역 고정. 레포 안에서 priority가 겹치지 않게 해 사전순 폴백이 발동하지 않게 한다.
--     0~99 seed · 100~199 scan · 200~299 manual · 900+ 조직 상한(seed, API 수정 불가)
UPDATE repo_paths r SET priority = s.priority
  FROM (VALUES
    ('**',               10),
    ('tests/**',         20),
    ('Dockerfile',       30),
    ('.github/**',       31),
    ('requirements.txt', 40),
    ('**/*.sql',         50),
    ('migrations/**',    51),
    ('contracts/**',     60),
    ('**/.env*',        900),
    ('**/*.pem',        960)
  ) AS s(path_pattern, priority)
 WHERE r.source = 'seed' AND r.path_pattern = s.path_pattern;

-- ④ 조직 상한 대역의 새 시드 행. negation 문법이 없으므로 예외는 더 높은 priority의 허용 행으로 표현한다.
--   '**/.env.example'(950)은 '**/.env*'(900)만 뚫는다.
--   955: .env.example 예외(950)가 contracts/ 읽기 전용(60)을 뚫는 것을 재고정.
--        settings.json은 dir/** deny를 '!'로 못 뚫으므로 서버가 맞춰야 함.
--        950대에 예외를 추가할 때마다 이런 재고정 행이 필요한지 tests/path-golden.test.ts가 검사한다.
--   나머지 비밀 규칙(960~963)은 예외보다 위에 둔다 — Claude Code는 디렉터리 전체를 막은 규칙('secrets/**')
--   안의 파일을 '!'로 되살릴 수 없으므로, 서버가 되살리면 두 엔진이 어긋난다.
INSERT INTO repo_paths (id, repo_id, path_pattern, owner_role, access, action_key, priority, source)
SELECT gen_random_uuid(), r.id, s.path_pattern, NULL, s.access, s.action_key, s.priority, 'seed'
  FROM repos r
 CROSS JOIN (VALUES
   ('**/.env.example',           'write',  NULL,              950),
   ('contracts/**/.env.example', 'read',   'contract:change', 955),
   ('**/*.key',                  'denied', 'secret:touch',    961),
   ('**/id_rsa*',                'denied', 'secret:touch',    962),
   ('**/secrets/**',             'denied', 'secret:touch',    963)
 ) AS s(path_pattern, access, action_key, priority)
ON CONFLICT (repo_id, path_pattern) DO NOTHING;

-- ⑤ manual·scan 행을 대역 안으로 옮긴다. 기존 상대 순서(priority, path_pattern)는 보존한다.
UPDATE repo_paths r SET priority = 199 + n.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY repo_id ORDER BY priority, path_pattern) AS rn
          FROM repo_paths WHERE source = 'manual') n
 WHERE r.id = n.id;

UPDATE repo_paths r SET priority = 99 + n.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY repo_id ORDER BY priority, path_pattern) AS rn
          FROM repo_paths WHERE source = 'scan') n
 WHERE r.id = n.id;

-- ⑥ 대역과 유일성을 DB가 강제한다. 대역에 100개를 넘으면 여기서 실패한다(조용히 겹치는 것보다 낫다).
ALTER TABLE repo_paths ADD CONSTRAINT repo_paths_priority_band_chk CHECK (
     (source = 'seed'   AND (priority BETWEEN 0 AND 99 OR priority >= 900))
  OR (source = 'scan'   AND priority BETWEEN 100 AND 199)
  OR (source = 'manual' AND priority BETWEEN 200 AND 299)
);
CREATE UNIQUE INDEX uq_repo_paths_priority ON repo_paths(repo_id, priority);

-- ⑦ 정책표 탐지 열을 새 기준에 맞춘다.
UPDATE action_catalog SET detection = 'package.json dependencies·devDependencies diff, requirements.txt'
 WHERE action_key = 'dep:add';
UPDATE action_catalog SET detection = '.env*(.env.example 제외), *.pem, *.key, id_rsa*, secrets/**'
 WHERE action_key = 'secret:touch';

-- Down Migration
-- 되돌리지 않는 것: manual·scan 행의 priority(원래 값을 알 수 없다 — 대역 CHECK가 사라지므로 그대로 유효),
-- 004가 남겼던 구 '.env' / '.env.*' 행(중복이었다).

DROP INDEX uq_repo_paths_priority;
ALTER TABLE repo_paths DROP CONSTRAINT repo_paths_priority_band_chk;

UPDATE action_catalog SET detection = 'package.json / requirements.txt diff' WHERE action_key = 'dep:add';
UPDATE action_catalog SET detection = '.env*, *.pem, *secret*' WHERE action_key = 'secret:touch';

DELETE FROM repo_paths
 WHERE source = 'seed'
   AND path_pattern IN ('**/.env.example', 'contracts/**/.env.example', '**/*.key', '**/id_rsa*', '**/secrets/**');

UPDATE repo_paths r SET priority = s.priority
  FROM (VALUES
    ('**',               10),
    ('tests/**',         20),
    ('Dockerfile',       50),
    ('.github/**',       50),
    ('requirements.txt', 50),
    ('**/*.sql',         50),
    ('migrations/**',    50),
    ('contracts/**',     60),
    ('**/.env*',         99),
    ('**/*.pem',         99)
  ) AS s(path_pattern, priority)
 WHERE r.source = 'seed' AND r.path_pattern = s.path_pattern;

INSERT INTO repo_paths (id, repo_id, path_pattern, owner_role, access, action_key, priority, source)
SELECT gen_random_uuid(), r.id, s.path_pattern, NULL, s.access, s.action_key, s.priority, 'seed'
  FROM repos r
 CROSS JOIN (VALUES
   ('package.json',      'write',  'dep:add',      50),
   ('package-lock.json', 'write',  'dep:add',      50),
   ('**/*secret*',       'denied', 'secret:touch', 99)
 ) AS s(path_pattern, access, action_key, priority)
ON CONFLICT (repo_id, path_pattern) DO NOTHING;
