// npm 패키지(@capstone-nomos/cli)가 **backend 폴더 밖에서** 실제로 도는지 확인한다.
// build → npm pack → 임시 폴더에 tarball 설치 → 또 다른 폴더에서 실행 → MCP 서버를 띄워 도구 목록까지 받는다.
// 배포 워크플로(publish-cli.yml)가 publish 직전에 돌린다. 로컬: npm run check:cli-package (npm 레지스트리 접속 필요 — 의존성 설치)
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pkgDir = path.join(repoRoot, 'packages', 'cli');
const isWindows = process.platform === 'win32';

function out(line: string): void {
  process.stdout.write(`[check-cli] ${line}\n`);
}

function fail(message: string): never {
  throw new Error(message);
}

// npm run으로 실행되면 npm_execpath가 npm-cli.js를 가리킨다 — node로 직접 불러 shell(Windows의 npm.cmd)을 거치지 않는다.
function npm(args: string[], cwd: string): string {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) fail('npm run check:cli-package로 실행하라 (npm_execpath가 없다)');
  return execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function quote(p: string): string {
  return `"${p}"`;
}

// 설치된 bin(shim)을 그대로 부른다 — Windows는 nomos.cmd. 사용자가 npx로 실행할 때와 같은 진입점이다.
function nomos(binDir: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const bin = path.join(binDir, isWindows ? 'nomos.cmd' : 'nomos');
  return execFileSync([quote(bin), ...args].join(' '), { cwd, env, encoding: 'utf-8', shell: true });
}

// MCP 서버를 띄워 initialize → tools/list까지 주고받는다. 실제로 Claude Code가 하는 일과 같다.
async function mcpHandshake(serverPath: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const child = spawn(process.execPath, [serverPath], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);

  try {
    return await new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP 서버가 10초 안에 답하지 않았다. stderr: ${stderr}`)), 10_000);
      let buffer = '';
      child.once('exit', (code) => reject(new Error(`MCP 서버가 종료됐다(exit ${code}). stderr: ${stderr}`)));
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line) continue;
          const msg = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } };
          if (msg.id === 1) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          } else if (msg.id === 2) {
            clearTimeout(timer);
            resolve((msg.result?.tools ?? []).map((t) => t.name));
          }
        }
      });
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check-cli', version: '0' } },
      });
    });
  } finally {
    child.kill();
  }
}

async function main(): Promise<void> {
  const version = (JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')) as { version: string }).version;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nomos-cli-check-'));
  try {
    out('build:cli');
    npm(['run', 'build:cli'], repoRoot);

    out('npm pack');
    const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', tmp], pkgDir)) as {
      filename: string;
      files: { path: string }[];
    }[];
    if (!packed) fail('npm pack 결과가 없다');
    const files = packed.files.map((f) => f.path.replaceAll('\\', '/'));
    const stray = files.filter((f) => !f.startsWith('dist/') && !['package.json', 'README.md'].includes(f));
    if (stray.length > 0) fail(`패키지에 dist 밖의 파일이 들어 있다: ${stray.join(', ')}`);
    for (const required of ['dist/executor/cli.js', 'dist/bridge/mcp-server.js']) {
      if (!files.includes(required)) fail(`패키지에 ${required}가 없다`);
    }
    const leaked = files.filter((f) => /^dist\/(?!executor\/|bridge\/)/.test(f));
    if (leaked.length > 0) fail(`서버 코드가 패키지에 실렸다: ${leaked.join(', ')}`);
    out(`  ${files.length}개 파일, ${packed.filename}`);

    // 사용자 노트북 흉내: 설치 폴더와 실행 폴더를 backend 밖에 따로 둔다. 홈도 비워 둔다(내 자격 증명을 읽지 않게).
    const app = path.join(tmp, 'app');
    const elsewhere = path.join(tmp, 'elsewhere');
    const home = path.join(tmp, 'home');
    for (const dir of [app, elsewhere, home]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(app, 'package.json'), '{ "name": "check-cli-app", "private": true }\n');
    out('tarball 설치');
    npm(['install', '--no-audit', '--no-fund', path.join(tmp, packed.filename)], app);

    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const binDir = path.join(app, 'node_modules', '.bin');

    const reported = nomos(binDir, ['--version'], elsewhere, env).trim();
    if (reported !== version) fail(`--version이 ${reported} (기대 ${version})`);
    out(`--version ${reported}`);

    const doctor = JSON.parse(nomos(binDir, ['doctor', '--json'], elsewhere, env)) as {
      mcpServer: { ok: boolean; detail: string };
    };
    const installed = path.join(app, 'node_modules', '@capstone-nomos', 'cli');
    if (!doctor.mcpServer.ok) fail(`doctor: MCP 서버를 못 찾음 — ${doctor.mcpServer.detail}`);
    if (!path.resolve(doctor.mcpServer.detail).startsWith(path.resolve(installed))) {
      fail(`MCP 서버 경로가 설치된 패키지 밖이다: ${doctor.mcpServer.detail}`);
    }
    out(`MCP 서버 경로 ${doctor.mcpServer.detail}`);

    // 서버 주소는 쓰이지 않는다(도구를 부르지 않는다). 자격 증명 파일이 없으니 환경변수로 준다.
    const tools = await mcpHandshake(doctor.mcpServer.detail, elsewhere, {
      ...env,
      NOMOS_BASE_URL: 'http://127.0.0.1:9',
      NOMOS_ACCESS_TOKEN: 'check',
      NOMOS_REFRESH_TOKEN: 'check',
    });
    for (const name of ['claim_task', 'submit_artifact']) {
      if (!tools.includes(name)) fail(`MCP 도구 ${name}이 없다 (받은 것: ${tools.join(', ')})`);
    }
    out(`MCP 도구 ${tools.length}개: ${tools.join(', ')}`);
    out('OK');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[check-cli] 실패: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
