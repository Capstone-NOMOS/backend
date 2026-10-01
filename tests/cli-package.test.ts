import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// npm 패키지 @capstone-nomos/cli는 src/executor·src/bridge만 담는다(tsconfig.cli.json).
// 이 두 폴더가 서버 코드를 import하면 그 파일과 그 의존성(서버 비밀값을 읽는 config 등)이 노트북으로 실려 나간다.
// 실제 설치·실행은 npm run check:cli-package(배포 워크플로)가 본다 — 여기서는 소스만 빠르게 막는다.

const ROOT = path.resolve(__dirname, '..');
const CLI_DIRS = ['src/executor', 'src/bridge'];

function sources(): { file: string; text: string }[] {
  return CLI_DIRS.flatMap((dir) =>
    readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({ file: path.join(ROOT, dir, f), text: readFileSync(path.join(ROOT, dir, f), 'utf-8') })),
  );
}

function specifiers(text: string): string[] {
  // import type은 런타임에 남지 않으므로 뺀다.
  return [...text.matchAll(/^\s*import\s+(?!type\s)[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]!);
}

const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { dependencies: Record<string, string> };
const cliPkg = JSON.parse(readFileSync(path.join(ROOT, 'packages/cli/package.json'), 'utf-8')) as {
  name: string;
  bin: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
};

describe('CLI 패키지 경계', () => {
  it('상대 import는 src/executor·src/bridge 안에서만 한다', () => {
    const outside: string[] = [];
    for (const { file, text } of sources()) {
      for (const spec of specifiers(text).filter((s) => s.startsWith('.'))) {
        const target = path.resolve(path.dirname(file), spec);
        if (!CLI_DIRS.some((d) => target.startsWith(path.join(ROOT, d) + path.sep))) outside.push(`${path.relative(ROOT, file)} → ${spec}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('외부 패키지는 CLI package.json에 있는 것만, 서버와 같은 버전 범위로', () => {
    const builtins = new Set(builtinModules);
    const used = new Set<string>();
    for (const { text } of sources()) {
      for (const spec of specifiers(text).filter((s) => !s.startsWith('.') && !s.startsWith('node:') && !builtins.has(s))) {
        used.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
      }
    }
    expect([...used].sort()).toEqual(Object.keys(cliPkg.dependencies).sort());
    for (const [name, range] of Object.entries(cliPkg.dependencies)) expect(range, name).toBe(rootPkg.dependencies[name]);
  });

  it('bin은 shebang이 있는 cli.js이고 dist만 배포한다', () => {
    expect(cliPkg.name).toBe('@capstone-nomos/cli');
    expect(cliPkg.bin).toEqual({ nomos: 'dist/executor/cli.js' });
    expect(cliPkg.files).toEqual(['dist']);
    expect(readFileSync(path.join(ROOT, 'src/executor/cli.ts'), 'utf-8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('MCP 서버 경로를 실행 폴더(cwd) 기준으로 찾지 않는다', () => {
    const cli = readFileSync(path.join(ROOT, 'src/executor/cli.ts'), 'utf-8');
    expect(cli).not.toMatch(/path\.resolve\(['"]dist\//);
    expect(cli).toContain('mcpServerPath()');
  });
});
