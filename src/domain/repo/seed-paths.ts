export type PathAccess = 'write' | 'read' | 'denied';

export type SeedPathRule = {
  pathPattern: string;
  ownerRole: null; // 시드 직후 owner_role은 항상 null (대표가 온보딩에서 지정한다)
  access: PathAccess;
  actionKey: string | null; // action_catalog 참조. NULL이면 code:own_path
  priority: number; // 명시적 정수. "더 구체적인 패턴이 이긴다" 같은 암묵 규칙 금지
};

// priority 대역. 레포 안에서 priority는 유일하다(DB 인덱스) — 동점 사전순 폴백이 발동하지 않는다.
// 900 이상은 조직 상한으로, API로 추가·수정할 수 없다.
export const PRIORITY_BAND = {
  seed: { min: 0, max: 99 },
  scan: { min: 100, max: 199 },
  manual: { min: 200, max: 299 },
  orgCeiling: { min: 900 },
} as const;

// 레포 연결 시 repo_paths에 자동 삽입되는 기본 규칙. priority가 높을수록 우선한다.
// action_key는 action_catalog 정책표의 "탐지" 열 중 경로로 표현되는 것만 옮긴 것이다.
// 이 목록을 바꾸면 기존 레포에도 반영하는 마이그레이션을 함께 쓰고(004·005 참고),
// tests/path-golden.test.ts가 서버 매처와 브릿지 settings.json 양쪽에서 통과하는지 확인한다.
export const SEED_PATH_RULES: readonly SeedPathRule[] = [
  { pathPattern: '**', ownerRole: null, access: 'write', actionKey: null, priority: 10 },
  { pathPattern: 'tests/**', ownerRole: null, access: 'write', actionKey: 'test:write', priority: 20 },
  { pathPattern: 'Dockerfile', ownerRole: null, access: 'write', actionKey: 'infra:ci', priority: 30 },
  { pathPattern: '.github/**', ownerRole: null, access: 'write', actionKey: 'infra:ci', priority: 31 },
  // package.json의 의존성 추가는 경로가 아니라 내용 diff로 판정한다 (domain/policy/dependency-diff.ts — 서버 검증이
  // 커밋 전후 내용을 읽어 dep:add를 더한다, verification/service.ts). 경로 행으로 넣으면 scripts만 고친 변경까지 걸린다.
  { pathPattern: 'requirements.txt', ownerRole: null, access: 'write', actionKey: 'dep:add', priority: 40 },
  { pathPattern: '**/*.sql', ownerRole: null, access: 'write', actionKey: 'db:migration', priority: 50 },
  { pathPattern: 'migrations/**', ownerRole: null, access: 'write', actionKey: 'db:migration', priority: 51 },
  { pathPattern: 'contracts/**', ownerRole: null, access: 'read', actionKey: 'contract:change', priority: 60 },

  // ── 조직 상한 (900+) ─────────────────────────────────────────────────────────
  // negation 문법이 없으므로 예외는 더 높은 priority의 허용 행으로 표현한다.
  { pathPattern: '**/.env*', ownerRole: null, access: 'denied', actionKey: 'secret:touch', priority: 900 },
  { pathPattern: '**/.env.example', ownerRole: null, access: 'write', actionKey: null, priority: 950 },
  // 위 예외가 계약 디렉터리의 읽기 전용까지 뚫지 않게 다시 막는다.
  { pathPattern: 'contracts/**/.env.example', ownerRole: null, access: 'read', actionKey: 'contract:change', priority: 955 },
  // 예외(950)보다 위. Claude Code는 'secrets/**'처럼 디렉터리째 막은 규칙 안의 파일을 되살릴 수 없으므로
  // 서버가 되살리면 두 엔진이 어긋난다.
  { pathPattern: '**/*.pem', ownerRole: null, access: 'denied', actionKey: 'secret:touch', priority: 960 },
  { pathPattern: '**/*.key', ownerRole: null, access: 'denied', actionKey: 'secret:touch', priority: 961 },
  { pathPattern: '**/id_rsa*', ownerRole: null, access: 'denied', actionKey: 'secret:touch', priority: 962 },
  { pathPattern: '**/secrets/**', ownerRole: null, access: 'denied', actionKey: 'secret:touch', priority: 963 },
] as const;
