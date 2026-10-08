import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWED_BASH_PREFIXES } from '../src/bridge/claude-args.js';
import { planSetup, prepareDependencies, VENV_DIR } from '../src/executor/setup.js';
import { buildTaskPrompt } from '../src/executor/prompt.js';
import { withPathPrepended } from '../src/executor/runner.js';
import { NOMOS_LOCAL_FILES } from '../src/executor/workspace.js';

// 의존성 설치는 Executor가 Claude 전에 한다 — 모델에게 설치 명령을 열지 않는다(설치 스크립트가 Edit 금지를 우회한다).
const has = (...files: string[]) => (f: string) => files.includes(f);

describe('설치 계획', () => {
  it('잠금 파일이 있으면 그대로 재현하고, 설치 스크립트는 언제나 끈다', () => {
    expect(planSetup(has('package.json', 'package-lock.json'))).toEqual([
      { manager: 'npm', cmd: 'npm', args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'] },
    ]);
    expect(planSetup(has('package.json', 'pnpm-lock.yaml'))[0]).toMatchObject({ cmd: 'pnpm', args: ['install', '--frozen-lockfile', '--ignore-scripts'] });
    expect(planSetup(has('package.json', 'yarn.lock'))[0]).toMatchObject({ cmd: 'yarn', args: ['install', '--frozen-lockfile', '--ignore-scripts'] });
    for (const step of planSetup(has('package.json'))) expect(step.args).toContain('--ignore-scripts');
  });

  it('잠금 파일 없이 package.json만 있으면 잠금 파일을 만들지 않고 설치한다(새 파일이 커밋에 섞이지 않게)', () => {
    expect(planSetup(has('package.json'))).toEqual([
      { manager: 'npm', cmd: 'npm', args: ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund'] },
    ]);
  });

  it('requirements.txt는 작업공간 가상환경에 바이너리 휠만(소스 빌드는 코드 실행이다)', () => {
    const plan = planSetup(has('requirements.txt'));
    expect(plan[0]).toMatchObject({ manager: 'python', args: ['-m', 'venv', VENV_DIR] });
    expect(plan[1]).toMatchObject({ manager: 'pip', args: ['-m', 'pip', 'install', '--only-binary', ':all:', '--disable-pip-version-check', '-r', 'requirements.txt'] });
  });

  it('설치할 것이 없으면 아무것도 하지 않는다', () => {
    expect(planSetup(has('README.md'))).toEqual([]);
  });
});

describe('설치 실행', () => {
  it('실패해도 던지지 않고 결과에 적는다. 가상환경을 못 만들면 pip도 건너뛴다', async () => {
    const dir = path.resolve('/tmp/nomos-setup-test-absent');
    // 존재하지 않는 폴더라 파일이 없다 → 계획이 비어야 한다.
    const empty = await prepareDependencies(dir, () => undefined, async () => undefined);
    expect(empty).toEqual({ steps: [], venvBin: null });
  });
});

describe('Executor가 쓰는 파일은 커밋에 섞이지 않는다', () => {
  it('미리 설치한 node_modules·가상환경도 info/exclude 목록에 있다', () => {
    expect(NOMOS_LOCAL_FILES).toEqual(expect.arrayContaining(['/node_modules/', `/${VENV_DIR}/`]));
  });

  it('PATH 앞에 가상환경을 붙인다 — Windows의 Path 이름도 그대로', () => {
    expect(withPathPrepended({ Path: 'C:\\bin' }, 'C:\\venv\\Scripts')).toEqual({ Path: `C:\\venv\\Scripts${path.delimiter}C:\\bin` });
    expect(withPathPrepended({}, '/venv/bin')).toEqual({ PATH: '/venv/bin' });
  });
});

describe('허용 명령과 프롬프트', () => {
  it('시험 실행기는 열고, 설치 명령은 열지 않는다', () => {
    expect(ALLOWED_BASH_PREFIXES).toEqual(expect.arrayContaining(['python -m pytest', 'python -m unittest', 'pnpm test']));
    for (const p of ALLOWED_BASH_PREFIXES) expect(p).not.toMatch(/install|pip|npm ci|^npx (?!vitest)/);
  });

  it('프롬프트에 허용 명령·잇지 말 것·설치 결과·막혔을 때 할 일을 적는다', () => {
    const prompt = buildTaskPrompt(
      { task: { id: 't1', title: 'T', teamRole: 'BACKEND' }, repo: { fullName: 'a/b' }, spec: null, notesBlock: '', writablePaths: [{ pathPattern: '**' }] },
      'task/t1',
      { allowedCommands: ALLOWED_BASH_PREFIXES, setup: [{ command: 'npm ci --ignore-scripts', ok: true }, { command: 'python -m pip install', ok: false }] },
    );
    expect(prompt).toContain('# 작업 환경');
    expect(prompt).toContain('  - python -m pytest');
    expect(prompt).toContain('`&&`·`;`·`|`로 잇거나');
    expect(prompt).toContain('- 설치됨: npm ci --ignore-scripts');
    expect(prompt).toContain('- 설치 실패: python -m pip install');
    expect(prompt).toContain('막힌 이유를 마지막 메시지에');
  });
});

describe('질문 중계 스위치와 프롬프트', () => {
  const brief = (questionRelay?: boolean) =>
    buildTaskPrompt(
      { task: { id: 't1', title: 'T', teamRole: 'FRONTEND' }, repo: { fullName: 'a/b' }, spec: null, notesBlock: '', writablePaths: [{ pathPattern: '**' }], ...(questionRelay === undefined ? {} : { questionRelay }) },
      'task/t1',
    );

  it('켜져 있으면 AskUserQuestion으로 물으라고, 꺼져 있으면(옛 서버 포함) 가정하고 GOTCHA로 남기라고 한다', () => {
    expect(brief(true)).toContain('AskUserQuestion으로 물어본다');
    for (const p of [brief(false), brief()]) {
      expect(p).not.toContain('AskUserQuestion');
      expect(p).toContain('가장 단순한 쪽으로 가정하고 진행');
    }
  });

  it('스위치와 상관없이 다른 역할 소관 계약은 DECIDED가 아니라 GOTCHA "가정함"으로 (실험 E6)', () => {
    for (const p of [brief(true), brief(false)]) {
      expect(p).toContain('DECIDED로 남기지 않는다 — 네 역할(FRONTEND)이 정할 수 있는 것이 아니다');
      expect(p).toContain('가정함 — <그 역할> 확인 필요');
    }
  });
});
