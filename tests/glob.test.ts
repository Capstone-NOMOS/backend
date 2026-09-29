import { describe, expect, it } from 'vitest';
import { matches, resolveRule, validatePattern } from '../src/domain/repo/glob.js';
import { AppError } from '../src/errors.js';
import type { RepoPath } from '../src/domain/repo/types.js';
import { asRepoId, asRepoPathId } from '../src/domain/ids.js';

function makeRule(overrides: Partial<RepoPath>): RepoPath {
  return {
    id: asRepoPathId('00000000-0000-0000-0000-000000000000'),
    repoId: asRepoId('11111111-1111-1111-1111-111111111111'),
    pathPattern: '**',
    ownerRole: null,
    access: 'write',
    actionKey: null,
    priority: 10,
    source: 'seed',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('validatePattern', () => {
  it('rejects "{a,b}" brace expansion', () => {
    expect(() => validatePattern('{a,b}')).toThrow(AppError);
  });

  it('rejects "!foo" negation', () => {
    expect(() => validatePattern('!foo')).toThrow(AppError);
  });

  it('rejects "?" wildcard', () => {
    expect(() => validatePattern('foo?bar')).toThrow(AppError);
  });

  it('rejects "[]" character classes', () => {
    expect(() => validatePattern('foo[abc]')).toThrow(AppError);
  });

  it('accepts "**", "*" and literal paths', () => {
    expect(() => validatePattern('api/**')).not.toThrow();
    expect(() => validatePattern('*.json')).not.toThrow();
    expect(() => validatePattern('package.json')).not.toThrow();
    expect(() => validatePattern('**/secrets/**')).not.toThrow();
  });

  it("rejects '**' that is not a whole path segment", () => {
    // picomatch는 이걸 '*'로 읽는다 — 서버와 브릿지의 판정이 갈린다.
    expect(() => validatePattern('a**b')).toThrow(AppError);
    expect(() => validatePattern('src/**.ts')).toThrow(AppError);
    expect(() => validatePattern('***')).toThrow(AppError);
  });

  it('rejects empty path segments', () => {
    expect(() => validatePattern('/etc/passwd')).toThrow(AppError);
    expect(() => validatePattern('dir/')).toThrow(AppError);
    expect(() => validatePattern('a//b')).toThrow(AppError);
  });
});

describe('matches', () => {
  it('"api/**" matches "api/routes/study.ts"', () => {
    expect(matches('api/**', 'api/routes/study.ts')).toBe(true);
  });

  it('"api/**" does not match "web/index.ts"', () => {
    expect(matches('api/**', 'web/index.ts')).toBe(false);
  });

  it("'**/' matches zero or more directories", () => {
    expect(matches('**/.env*', '.env')).toBe(true);
    expect(matches('**/.env*', '.env.local')).toBe(true);
    expect(matches('**/.env*', 'apps/api/.env')).toBe(true);
    expect(matches('**/*.sql', 'schema.sql')).toBe(true);
    expect(matches('**/*.sql', 'db/migrations/001.sql')).toBe(true);
    expect(matches('a/**/b', 'a/b')).toBe(true);
    expect(matches('a/**/b', 'a/x/y/b')).toBe(true);
  });

  it("'*' does not cross '/'", () => {
    expect(matches('*.json', 'package.json')).toBe(true);
    expect(matches('*.json', 'apps/package.json')).toBe(false);
    expect(matches('**/secrets/**', 'config/secrets/a')).toBe(true);
    expect(matches('**/secrets/**', 'src/secretary.ts')).toBe(false);
  });
});

describe('resolveRule', () => {
  it('returns the rule with the highest priority among matches', () => {
    const rules = [
      makeRule({ pathPattern: '**', priority: 10 }),
      makeRule({ pathPattern: 'contracts/**', priority: 60 }),
    ];
    const resolved = resolveRule(rules, 'contracts/foo.md');
    expect(resolved?.pathPattern).toBe('contracts/**');
  });

  it('deterministically tie-breaks by path_pattern ascending when priority is equal', () => {
    // 'src/*'와 'src/**'는 둘 다 'src/index.ts'와 매칭되고 priority가 같다.
    // 사전순으로 'src/*' < 'src/**'이므로 입력 순서와 무관하게 항상 'src/*'가 이겨야 한다.
    const rules = [
      makeRule({ pathPattern: 'src/**', priority: 50 }),
      makeRule({ pathPattern: 'src/*', priority: 50 }),
    ];

    const winner1 = resolveRule(rules, 'src/index.ts');
    const winner2 = resolveRule([...rules].reverse(), 'src/index.ts');

    expect(winner1?.pathPattern).toBe('src/*');
    expect(winner2?.pathPattern).toBe('src/*');
  });
});
