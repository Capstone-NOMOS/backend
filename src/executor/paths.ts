import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 이 CLI는 npm 패키지(@capstone-nomos/cli)로 배포되어 **아무 폴더에서나** 실행된다.
// 그래서 파일 위치는 실행 폴더(process.cwd())가 아니라 이 파일 위치(import.meta.url) 기준으로 찾는다.
// 예전 path.resolve('dist/bridge/mcp-server.js')는 backend 폴더에서 실행할 때만 맞았다.

// Claude Code가 띄우는 MCP 서버(submit_artifact 등). process.execPath로 실행하므로 컴파일된 .js여야 한다.
export function mcpServerPath(): string {
  // 패키지·서버 빌드(dist/executor/cli.js) → dist/bridge/mcp-server.js
  const sibling = fileURLToPath(new URL('../bridge/mcp-server.js', import.meta.url));
  if (existsSync(sibling)) return sibling;
  // 소스에서 tsx로 실행(npm run executor, src/executor/cli.ts) → 서버 빌드 결과 dist/bridge/mcp-server.js
  const built = fileURLToPath(new URL('../../dist/bridge/mcp-server.js', import.meta.url));
  if (existsSync(built)) return built;
  throw new Error(`MCP 서버 파일을 찾지 못했다(${sibling}). 소스에서 실행 중이면 npm run build를 먼저 하라`);
}

// 패키지 버전. 패키지에서는 packages/cli/package.json, 소스에서는 backend의 package.json이 읽힌다.
export function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
