import { exec as execShell, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

// 의존성 설치는 모델이 아니라 Executor가 Claude를 띄우기 전에 한다(운영 테스트 4-4).
// 모델에게 `npm install`·`pip install`을 열면 설치 스크립트(postinstall·setup.py)가 임의 코드를 돌려 Edit 금지 규칙(.env·contracts)을 우회할 수 있다.
// 그래서 여기서도 스크립트를 끈다: npm 계열은 --ignore-scripts, pip는 바이너리 휠만(--only-binary :all: — 소스 빌드는 코드 실행이다).
// 설치가 실패해도 태스크는 진행한다 — 모델은 설치 없이 할 수 있는 만큼 하고, 못 한 것은 멈춤 사유(거부 명령)로 드러난다.

const run = promisify(execFile);
const runShell = promisify(execShell);
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

export type SetupStep = { manager: string; command: string; ok: boolean; detail?: string };
export type SetupResult = { steps: SetupStep[]; venvBin: string | null };

// 작업공간에 만든 파이썬 가상환경 이름. info/exclude에 들어 있어 커밋에 섞이지 않는다(workspace.ts).
export const VENV_DIR = '.nomos-venv';

type Exec = (cmd: string, args: string[], cwd: string) => Promise<void>;

const NODE_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);

const defaultExec: Exec = async (cmd, args, cwd) => {
  // Windows에서 npm·pnpm·yarn은 .cmd라 셸 없이 못 띄운다. 그 셋은 명령 이름과 인자가 전부 이 파일의 고정 문자열이라 셸에 넘겨도 주입될 값이 없다.
  // 파이썬은 실행 파일 경로(공백이 들어갈 수 있다)를 직접 띄우므로 셸을 쓰지 않는다.
  const options = { cwd, timeout: INSTALL_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
  if (process.platform === 'win32' && NODE_MANAGERS.has(cmd)) {
    await runShell([cmd, ...args].join(' '), options);
    return;
  }
  await run(cmd, args, options);
};

function pythonBin(dir: string): string {
  return process.platform === 'win32' ? path.join(dir, VENV_DIR, 'Scripts') : path.join(dir, VENV_DIR, 'bin');
}

// 어떤 설치를 할지(순수 함수). 잠금 파일이 있으면 그대로 재현(ci/frozen), 없으면 package.json만으로 설치하되 잠금 파일을 만들지 않는다
// (만들면 작업공간에 새 파일이 생겨 모델이 커밋에 섞는다).
export function planSetup(has: (file: string) => boolean): { manager: string; cmd: string; args: string[] }[] {
  const steps: { manager: string; cmd: string; args: string[] }[] = [];
  if (has('pnpm-lock.yaml')) steps.push({ manager: 'pnpm', cmd: 'pnpm', args: ['install', '--frozen-lockfile', '--ignore-scripts'] });
  else if (has('yarn.lock')) steps.push({ manager: 'yarn', cmd: 'yarn', args: ['install', '--frozen-lockfile', '--ignore-scripts'] });
  else if (has('package-lock.json')) steps.push({ manager: 'npm', cmd: 'npm', args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'] });
  else if (has('package.json')) {
    steps.push({ manager: 'npm', cmd: 'npm', args: ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund'] });
  }
  if (has('requirements.txt')) {
    steps.push({ manager: 'python', cmd: process.platform === 'win32' ? 'python' : 'python3', args: ['-m', 'venv', VENV_DIR] });
    steps.push({ manager: 'pip', cmd: 'venv-python', args: ['-m', 'pip', 'install', '--only-binary', ':all:', '--disable-pip-version-check', '-r', 'requirements.txt'] });
  }
  return steps;
}

export async function prepareDependencies(dir: string, log: (line: string) => void, exec: Exec = defaultExec): Promise<SetupResult> {
  const plan = planSetup((file) => existsSync(path.join(dir, file)));
  const steps: SetupStep[] = [];
  let venvBin: string | null = null;
  for (const step of plan) {
    const cmd = step.cmd === 'venv-python' ? path.join(pythonBin(dir), 'python') : step.cmd;
    // venv를 못 만들었으면 pip도 건너뛴다.
    if (step.cmd === 'venv-python' && venvBin === null) continue;
    const command = `${step.cmd === 'venv-python' ? 'python' : step.cmd} ${step.args.join(' ')}`;
    try {
      await exec(cmd, step.args, dir);
      steps.push({ manager: step.manager, command, ok: true });
      if (step.manager === 'python') venvBin = pythonBin(dir);
      log(`의존성 설치: ${command} — OK`);
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0]!.slice(0, 200) : String(err);
      steps.push({ manager: step.manager, command, ok: false, detail });
      log(`의존성 설치 실패(태스크는 진행한다): ${command} — ${detail}`);
    }
  }
  return { steps, venvBin };
}
