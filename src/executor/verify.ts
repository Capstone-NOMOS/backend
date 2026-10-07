// V2(PM 시험지)와 V4(린트) — 작업공간이 있어야 돌 수 있는 두 단계.
// 제출 시점에는 결과가 물리적으로 존재할 수 없으므로 서버가 동기로 돌릴 수 없고,
// Executor가 돌린 뒤 POST /api/artifacts/:id/verifications로 보고한다.
//
// 여기서 판정하는 것은 "명령이 0으로 끝났는가"뿐이다. 출력을 읽고 해석하지 않는다 —
// 해석이 들어가는 순간 브릿지마다 결과가 달라지고, 그건 결정적 검증이 아니다.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { removeQuietly } from './cleanup.js';

const run = promisify(execFile);

// 린트와 테스트는 오래 걸릴 수 있지만 무한정은 아니다. 초과하면 SKIPPED로 남긴다 —
// FAIL로 적으면 코드가 아니라 기계가 느려서 재시도 횟수를 잃는다.
const STEP_TIMEOUT_MS = 5 * 60 * 1000;

export type StageReport = {
  stage: 'V2' | 'V4';
  result: 'PASS' | 'FAIL' | 'SKIPPED';
  detail: Record<string, unknown>;
  durationMs: number;
};

type Exec = { code: number; stdout: string; stderr: string };

// Windows에서 npm은 .cmd라 shell 없이는 못 띄운다. 인자를 문자열로 합치지 않고
// npm-cli.js를 직접 node로 부르는 방식이 안전하지만, 여기서는 인자가 고정이라
// shell:true로도 주입 여지가 없다 — 사용자 입력이 섞이지 않는다.
async function exec(cmd: string, args: string[], cwd: string): Promise<Exec> {
  try {
    const { stdout, stderr } = await run(cmd, args, {
      cwd,
      timeout: STEP_TIMEOUT_MS,
      shell: process.platform === 'win32',
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    return {
      code: typeof e.code === 'number' ? e.code : e.killed ? 124 : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? String(err),
    };
  }
}

// 출력 전체를 서버에 올리지 않는다. events·verifications는 지워지지 않으므로
// 로그를 통째로 넣으면 비밀값이 섞여 들어갈 수 있다.
function tail(text: string, lines = 20): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}

function packageScripts(workspaceDir: string): Record<string, string> {
  const file = path.join(workspaceDir, 'package.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

// ── V4 — 린트 ─────────────────────────────────────────────────────────────
export async function runLint(workspaceDir: string): Promise<StageReport> {
  const started = Date.now();
  const done = (
    result: StageReport['result'],
    detail: Record<string, unknown>,
  ): StageReport => ({ stage: 'V4', result, detail, durationMs: Date.now() - started });

  const scripts = packageScripts(workspaceDir);
  if (!('lint' in scripts)) {
    return done('SKIPPED', { reason: 'package.json에 lint 스크립트가 없다' });
  }

  const out = await exec('npm', ['run', '--silent', 'lint'], workspaceDir);
  if (out.code === 124) return done('SKIPPED', { reason: '린트가 제한 시간을 넘겼다' });
  return out.code === 0
    ? done('PASS', { command: 'npm run lint' })
    : done('FAIL', { command: 'npm run lint', exitCode: out.code, output: tail(out.stderr || out.stdout) });
}

// ── V2 — PM 시험지 ────────────────────────────────────────────────────────
// spec_tests.test_code를 작업공간에 풀어 vitest로 돌린다. 시험지는 서버가 내려준
// 잠긴 것만 오고, 잠근 시각이 산출물보다 늦으면 서버가 보고를 받을 때 뒤집는다.
export type SpecTest = { id: string; criterion: string; testCode: string };

const SPEC_TEST_DIR = '.nomos-spec-tests';

export async function runSpecTests(
  workspaceDir: string,
  specTests: SpecTest[],
): Promise<StageReport> {
  const started = Date.now();
  const done = (
    result: StageReport['result'],
    detail: Record<string, unknown>,
  ): StageReport => ({ stage: 'V2', result, detail, durationMs: Date.now() - started });

  if (specTests.length === 0) {
    return done('SKIPPED', { reason: '잠긴 spec_tests가 없다' });
  }
  // vitest가 작업공간에 설치돼 있을 때만 돌린다. npx에 맡기면 없을 때 레지스트리에서
  // 받아오느라 몇 분이 사라지고, 네트워크가 막힌 노트북에서는 그대로 멈춘다.
  if (!existsSync(path.join(workspaceDir, 'node_modules', 'vitest'))) {
    return done('SKIPPED', { reason: '작업공간에 vitest가 설치돼 있지 않다' });
  }

  const dir = path.join(workspaceDir, SPEC_TEST_DIR);
  // 시험지는 작업 결과가 아니다. 커밋에 섞이면 V3에서 신고 누락으로 잡힌다.
  removeQuietly(dir);
  mkdirSync(dir, { recursive: true });
  try {
    const files = specTests.map((t) => {
      const file = path.join(dir, `${t.id}.test.ts`);
      writeFileSync(file, t.testCode, 'utf-8');
      return path.posix.join(SPEC_TEST_DIR, `${t.id}.test.ts`);
    });

    const out = await exec('npx', ['vitest', 'run', ...files], workspaceDir);
    if (out.code === 124) return done('SKIPPED', { reason: '시험지가 제한 시간을 넘겼다' });
    return out.code === 0
      ? done('PASS', { specTestIds: specTests.map((t) => t.id) })
      : done('FAIL', {
          specTestIds: specTests.map((t) => t.id),
          exitCode: out.code,
          output: tail(out.stdout || out.stderr),
        });
  } finally {
    // 남겨두면 다음 실행에서 모델이 시험지를 읽고 거기에 맞춰 고칠 수 있다.
    removeQuietly(dir);
  }
}
