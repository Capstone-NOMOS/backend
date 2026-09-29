import { describe, expect, it } from 'vitest';
import { buildClaudePermissions, toClaudePath } from '../src/domain/repo/claude-settings.js';
import { matches, resolveRule, validatePattern } from '../src/domain/repo/glob.js';
import { asRepoId, asRepoPathId } from '../src/domain/ids.js';
import { PRIORITY_BAND, SEED_PATH_RULES, type PathAccess, type SeedPathRule } from '../src/domain/repo/seed-paths.js';
import type { RepoPath } from '../src/domain/repo/types.js';
import { AppError } from '../src/errors.js';
import { claudeDenyRuleMatches, judgeWithClaudeSettings } from './claude-permission-model.js';
import { JUDGMENTS, UNIVERSE } from './path-fixtures.js';

// ── 골든 fixture ──────────────────────────────────────────────────────────────
// 서버 매처와 브릿지 settings.json 생성기에 **같은** fixture를 돌린다. 한쪽에만 있으면 두 엔진이 또 어긋난다.

// 경로 → 판정 (기본 시드 규칙 기준)

// 패턴 하나 → 경로 매칭. 004가 고친 '**/' = 0개 이상 디렉터리 해석과, 루트 앵커 해석.
const PATTERN_MATCHES: ReadonlyArray<readonly [string, string, boolean]> = [
  ['**/.env*', '.env', true],
  ['**/.env*', 'apps/api/.env', true],
  ['**/.env*', '.ENV', true], // 대소문자 무시
  ['**/*.sql', 'schema.sql', true],
  ['**/*.sql', 'db/migrations/001.sql', true],
  ['a/**/b', 'a/b', true],
  ['a/**/b', 'a/x/y/b', true],
  ['contracts/**', 'contracts/x.yaml', true],
  ['contracts/**', 'vendor/contracts/x.yaml', false],
  ['Dockerfile', 'Dockerfile', true],
  ['Dockerfile', 'svc/Dockerfile', false],
  ['*.json', 'apps/package.json', false],
];

// 방언이 갈리는 표기 — 두 엔진 모두 받아들이지 않아야 한다.
const REJECTED_PATTERNS = ['a**b', 'src/**.ts', '***', '/abs', 'dir/', 'a//b', '{a,b}', '!foo', 'foo?'];

// ── 두 엔진 ───────────────────────────────────────────────────────────────────

const STRICTNESS: Record<PathAccess, number> = { write: 0, read: 1, denied: 2 };

function asRepoPaths(rules: readonly SeedPathRule[]): RepoPath[] {
  return rules.map((rule, i) => ({
    id: asRepoPathId(`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`),
    repoId: asRepoId('11111111-1111-1111-1111-111111111111'),
    pathPattern: rule.pathPattern,
    ownerRole: null,
    access: rule.access,
    actionKey: rule.actionKey,
    priority: rule.priority,
    source: 'seed',
    createdAt: '',
  }));
}

function serverJudgeWith(rules: readonly SeedPathRule[]) {
  const repoPaths = asRepoPaths(rules);
  return (path: string): PathAccess => resolveRule(repoPaths, path)?.access ?? 'write';
}

const settings = buildClaudePermissions(SEED_PATH_RULES);

const serverEngine = {
  judge: serverJudgeWith(SEED_PATH_RULES),
  matches: (pattern: string, path: string) => matches(pattern, path),
  rejects: (pattern: string) => () => validatePattern(pattern),
};

const bridgeEngine = {
  judge: (path: string): PathAccess => judgeWithClaudeSettings(settings, path),
  matches: (pattern: string, path: string) => claudeDenyRuleMatches(toClaudePath(pattern), path),
  rejects: (pattern: string) => () => buildClaudePermissions([{ pathPattern: pattern, access: 'denied', priority: 1 }]),
};

describe.each([
  ['서버 매처', serverEngine],
  ['브릿지 settings.json', bridgeEngine],
] as const)('%s', (_name, engine) => {
  it.each(JUDGMENTS)('%s → %s', (path, expected) => {
    expect(engine.judge(path)).toBe(expected);
  });

  it.each(PATTERN_MATCHES)('"%s" vs "%s" → %s', (pattern, path, expected) => {
    expect(engine.matches(pattern, path)).toBe(expected);
  });

  it.each(REJECTED_PATTERNS)('"%s"는 거부한다', (pattern) => {
    expect(engine.rejects(pattern)).toThrow(AppError);
  });
});

// ── 비대칭 교차 검증 ──────────────────────────────────────────────────────────
// 두 불일치는 위험도가 다르다.
//   settings.json이 더 느슨함 → 에이전트가 파일을 실제로 건드린 뒤 제출 시점(V3)에야 반려된다.
//     정직한 실수 방어선이 한 겹 늦게 작동하므로 **하드 실패**.
//   settings.json이 더 엄격함 → 로컬에서 먼저 막힌다. 보수적이므로 통과시키되 눈에 보이게 남긴다.


describe('비대칭 교차 검증', () => {
  const diffs = UNIVERSE.map((path) => ({
    path,
    server: serverEngine.judge(path),
    bridge: bridgeEngine.judge(path),
  })).filter((r) => r.server !== r.bridge);

  it(`${UNIVERSE.length}개 경로에서 settings.json이 서버보다 느슨한 경우가 없다`, () => {
    const looser = diffs.filter((r) => STRICTNESS[r.bridge] < STRICTNESS[r.server]);
    expect(looser).toEqual([]);
  });

  it('settings.json이 더 엄격한 경우는 통과시키되 기록한다', () => {
    const stricter = diffs.filter((r) => STRICTNESS[r.bridge] > STRICTNESS[r.server]);
    if (stricter.length > 0) {
      console.warn(`[WARN] settings.json이 더 엄격한 경로 ${stricter.length}개:`, stricter);
    }
    expect(stricter.length).toBeLessThanOrEqual(UNIVERSE.length);
  });
});

// ── 조직 상한 예외의 짝 검사 ──────────────────────────────────────────────────
// "X 차단 > Y 읽기전용 > X 예외" 구조는 예외를 하나 만들 때마다 재발한다.
// 950대에 예외를 추가하면, 그 예외가 지나가는 낮은 우선순위 규칙 중 settings.json에서 '!'로 뚫을 수 없는 것
// (루트 고정 규칙, 디렉터리째 막은 규칙)에 대해 재고정 행이 있는지 자동으로 확인한다.

// 패턴을 구체 경로 몇 개로 펼친다.
function instantiate(pattern: string): string[] {
  let out: string[] = [''];
  const segments = pattern.split('/');
  segments.forEach((segment, i) => {
    const isLast = i === segments.length - 1;
    const variants =
      segment === '**'
        ? isLast
          ? ['f', 'd/f']
          : ['', 'd/', 'd/e/']
        : [segment.replace(/\*/g, 'w') + (isLast ? '' : '/')];
    out = out.flatMap((prefix) => variants.map((v) => prefix + v));
  });
  return [...new Set(out)].filter((p) => p.length > 0 && !p.endsWith('/'));
}

function isUncarvableInSettings(rule: SeedPathRule): boolean {
  return !rule.pathPattern.startsWith('**/') || rule.pathPattern.endsWith('/**');
}

function witnessesFor(restrictive: SeedPathRule, exception: SeedPathRule): string[] {
  const tails = instantiate(exception.pathPattern);
  if (!restrictive.pathPattern.endsWith('/**')) return tails;
  const dirs = instantiate(`${restrictive.pathPattern.slice(0, -2)}f`).map((p) => p.replace(/f$/, ''));
  return [...tails, ...dirs.flatMap((dir) => tails.map((tail) => dir + tail))];
}

function unpinnedPairs(rules: readonly SeedPathRule[]): string[] {
  const judge = serverJudgeWith(rules);
  const problems: string[] = [];
  const exceptions = rules.filter((r) => r.priority >= PRIORITY_BAND.orgCeiling.min && r.access !== 'denied');

  for (const exception of exceptions) {
    for (const restrictive of rules) {
      if (restrictive.priority >= exception.priority) continue;
      if (STRICTNESS[restrictive.access] <= STRICTNESS[exception.access]) continue;
      if (!isUncarvableInSettings(restrictive)) continue; // '!'로 뚫을 수 있으면 예외가 유효하다

      for (const witness of witnessesFor(restrictive, exception)) {
        if (!matches(restrictive.pathPattern, witness) || !matches(exception.pathPattern, witness)) continue;
        if (STRICTNESS[judge(witness)] < STRICTNESS[restrictive.access]) {
          problems.push(
            `${exception.pathPattern}(${exception.priority})가 ${restrictive.pathPattern}(${restrictive.priority}, ${restrictive.access})를 "${witness}"에서 뚫는다 — 재고정 행이 필요하다`,
          );
        }
      }
    }
  }
  return [...new Set(problems)];
}

describe('조직 상한 예외의 짝 검사', () => {
  it('예외가 settings.json에서 뚫을 수 없는 규칙을 서버에서만 뚫지 않는다', () => {
    expect(unpinnedPairs(SEED_PATH_RULES)).toEqual([]);
  });

  it('재고정 행(955)을 지우면 검사가 잡아낸다', () => {
    const withoutRepin = SEED_PATH_RULES.filter((r) => r.pathPattern !== 'contracts/**/.env.example');
    expect(unpinnedPairs(withoutRepin)).not.toEqual([]);
  });
});

describe('생성기', () => {
  it('priority가 겹치면 settings를 만들지 않는다', () => {
    expect(() =>
      buildClaudePermissions([
        { pathPattern: 'a/**', access: 'denied', priority: 5 },
        { pathPattern: 'b/**', access: 'write', priority: 5 },
      ]),
    ).toThrow(/duplicate priority/);
  });

  it('생성된 deny 목록 스냅샷', () => {
    // 이 목록 그대로를 임시 작업공간에 깔고 헤드리스 Claude Code로 실측했다 (claude-permission-model.ts 주석).
    expect(settings.permissions.deny).toEqual([
      'Read(**/.env*)',
      'Read(!**/.env.example)',
      'Read(!/contracts/**/.env.example)', // read 행은 Read 목록에선 허용이라 '!'로 나온다 (중복이지만 무해)
      'Read(**/*.pem)',
      'Read(**/*.key)',
      'Read(**/id_rsa*)',
      'Read(**/secrets/**)',
      'Edit(/contracts/**)',
      'Edit(**/.env*)',
      'Edit(!**/.env.example)',
      'Edit(/contracts/**/.env.example)',
      'Edit(**/*.pem)',
      'Edit(**/*.key)',
      'Edit(**/id_rsa*)',
      'Edit(**/secrets/**)',
    ]);
  });
});
