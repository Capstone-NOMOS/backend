import type { PathAccess } from '../src/domain/repo/seed-paths.js';

// 서버 매처와 브릿지 settings.json에 **같은** fixture를 돌린다. 한쪽에만 있으면 두 엔진이 또 어긋난다.
// 테스트(path-golden.test.ts)와 실제 파일 대조 스크립트(scripts/verify-workspace-settings.ts)가 함께 쓴다.

export const JUDGMENTS: ReadonlyArray<readonly [string, PathAccess]> = [
  ['.env', 'denied'],
  ['.env.example', 'write'], // 오탐 회귀 감시
  ['src/secretary.ts', 'write'], // 오탐 회귀 감시
  ['config/secrets/a', 'denied'],
  ['package-lock.json', 'write'],
  ['apps/api/.env.local', 'denied'],
  ['apps/web/.env.example', 'write'],
  ['secrets/.env.example', 'denied'], // 예외가 디렉터리째 막은 비밀 규칙까지 뚫지 않는다
  ['contracts/.env.example', 'read'], // 예외가 계약 읽기 전용까지 뚫지 않는다 (955 재고정)
  ['contracts/F-03/.env.example', 'read'], // 중첩 경로도 같다
  ['contracts/a/b/.env.example', 'read'],
  ['contracts/user.yaml', 'read'],
  ['vendor/contracts/user.yaml', 'write'], // 'contracts/**'는 레포 루트에만
  ['certs/server.pem', 'denied'],
  ['deploy/app.key', 'denied'],
  ['.ssh/id_rsa', 'denied'],
  ['services/api/Dockerfile', 'write'],
  ['src/app.ts', 'write'],
  // 대소문자 — Claude Code가 구분하지 않으므로 서버도 구분하지 않는다 (실측 확인)
  ['.ENV', 'denied'],
  ['x/SERVER.PEM', 'denied'],
  ['.env.EXAMPLE', 'write'],
  ['contracts/.ENV', 'denied'],
];

// 비대칭 교차 검증용 경로 전수. 디렉터리 x 파일 조합.
export const UNIVERSE_DIRS = ['', 'x/', 'x/y/', 'secrets/', 'secrets/sub/', 'config/secrets/', 'contracts/',
  'contracts/F-03/', 'contracts/a/b/', 'vendor/contracts/', 'tests/', 'migrations/', 'db/', '.github/', 'svc/'];
export const UNIVERSE_FILES = ['.env', '.ENV', '.env.local', '.env.example', '.env.EXAMPLE', '.ENV.example', 'server.pem',
  'SERVER.PEM', 'app.key', 'id_rsa', 'ID_RSA', 'id_rsa.pub', 'Dockerfile', 'package.json', 'package-lock.json',
  'requirements.txt', 'schema.sql', 'app.ts', 'secretary.ts', 'README.md'];
export const UNIVERSE = UNIVERSE_DIRS.flatMap((dir) => UNIVERSE_FILES.map((file) => `${dir}${file}`));
