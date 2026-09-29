import { describe, expect, it } from 'vitest';
import { diffDependencies, isDependencyAddition } from '../src/domain/policy/dependency-diff.js';

const pkg = (body: Record<string, unknown>) => JSON.stringify(body, null, 2);

describe('diffDependencies', () => {
  it('scripts만 바뀐 package.json은 dep:add가 아니다', () => {
    const before = pkg({ scripts: { test: 'vitest' }, dependencies: { zod: '^3.24.1' } });
    const after = pkg({ scripts: { test: 'vitest run' }, dependencies: { zod: '^3.24.1' } });
    expect(isDependencyAddition(before, after)).toBe(false);
  });

  it('dependencies·devDependencies에 새 패키지가 들어오면 잡는다', () => {
    const before = pkg({ dependencies: { zod: '^3.24.1' } });
    const after = pkg({ dependencies: { zod: '^3.24.1', dayjs: '^1.11.0' }, devDependencies: { vitest: '^2.1.8' } });
    expect(diffDependencies(before, after).changes).toEqual([
      { section: 'dependencies', name: 'dayjs', from: null, to: '^1.11.0' },
      { section: 'devDependencies', name: 'vitest', from: null, to: '^2.1.8' },
    ]);
  });

  it('버전이 바뀌어도 잡는다 — 새 코드가 들어온다', () => {
    const before = pkg({ dependencies: { zod: '^3.24.1' } });
    const after = pkg({ dependencies: { zod: '^4.0.0' } });
    expect(diffDependencies(before, after).changes).toEqual([
      { section: 'dependencies', name: 'zod', from: '^3.24.1', to: '^4.0.0' },
    ]);
  });

  it('제거는 추가가 아니다', () => {
    const before = pkg({ dependencies: { zod: '^3.24.1', dayjs: '^1.11.0' } });
    const after = pkg({ dependencies: { zod: '^3.24.1' } });
    expect(isDependencyAddition(before, after)).toBe(false);
    expect(isDependencyAddition(before, null)).toBe(false);
  });

  it('새로 만든 package.json의 의존성은 전부 추가다', () => {
    expect(isDependencyAddition(null, pkg({ dependencies: { zod: '^3.24.1' } }))).toBe(true);
  });

  it('변경 후 내용을 읽을 수 없으면 dep:add로 취급한다 (fail closed)', () => {
    const before = pkg({ dependencies: { zod: '^3.24.1' } });
    expect(diffDependencies(before, '{ not json')).toEqual({ changes: [], unparseable: true });
    expect(isDependencyAddition(before, '{ not json')).toBe(true);
    expect(isDependencyAddition(before, pkg({ dependencies: ['zod'] }))).toBe(true);
  });
});
