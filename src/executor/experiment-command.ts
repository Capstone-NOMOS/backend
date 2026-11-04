// 무인 실험 감독(034) — 실험 모드 프로젝트에 요구사항을 넣고, 서버가 사람 없이 진행하는 것을 지켜보며 회차를 반복한다.
// question-harvest(033)를 대체한다(그 반복 로직을 흡수했다).
// 진입점은 둘이고 이 함수 한 벌을 쓴다: CLI `nomos experiment …`(서버 레포 없이 npx로 — 상태 파일 <NOMOS_HOME>/experiment-runs/)와
// 레포의 `npm run experiment:run -- …`(scripts/experiment-run.ts — 상태 파일 scripts/data/experiment-runs/).
// 대표 계정(사람 토큰)으로만 서버 API를 부른다 — 에이전트 자격 증명(credentials)은 읽지도 쓰지도 않고, 폴더 잠금(home-lock)도 잡지 않는다.
//
//   nomos experiment --project <id> --login <대표 loginId> --requirements <파일.json> --repeat 3
//   nomos experiment ... --dry-run                 # 확인만(요청하지 않는다)
//   nomos experiment ... --run e202611021530       # 끊긴 실행을 이어 간다(상태 파일 <run>.json)
//   nomos experiment --project <id> --login <대표> --report --run <이름>   # 단계별·요구사항·회차별 질문 수, 자동 처리 건수, 라우터 분포
//   --server <주소>(기본 운영) --interval <초>(30) --round-timeout <분>(90) --planning-timeout <분>(120)
//   --offline <분>(10) --unclaimed <분>(15) --failures <K>(3)
//   --until <시간>       이 시간 동안 회차를 늘려 가며 계속 돈다(요구사항을 한 바퀴씩, 바퀴마다 --repeat회 더). 마감은 상태 파일에 남아 이어 가도 늘지 않는다. --keep-going을 함께 켠다.
//   --keep-going         멈춤·일시 오류에도 끝내지 않고 알린 뒤 --retry-wait <분>(5) 기다렸다가 이어 간다(설정 문제만 끝낸다). 24시간 무인 실행용.
//
// 요구사항 파일: [{ "key": "study-list", "instruction": "대표가 PM에게 하듯 자연어 요구", "repeat"?: 3 }] — 예시 scripts/examples/experiment-requirements.json.
// 자동으로 풀 수 없는 고장(로그인 만료·노트북 꺼짐·예산 소진 등)은 멈추고 원인과 할 일을 한 줄로 출력한다(종료 코드 3).
// EXPERIMENT_ALERT_WEBHOOK이 있으면 같은 문장을 { text }로 POST한다(슬랙 호환). 비밀값은 싣지 않는다.
// 대표 권한 HTTP만 쓴다. 비밀번호는 NOMOS_PASSWORD 또는 입력 창, 받은 토큰이 있으면 NOMOS_TOKEN. 규칙과 이유는 experiment-supervisor.ts.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_SERVER } from './connect.js';
import {
  DEFAULTS,
  emptyState,
  experimentReport,
  formatExperimentReport,
  HaltError,
  newRunId,
  requirementsSchema,
  RUN_ID,
  Supervisor,
  superviseWithRetry,
  type RunState,
  type StateStore,
} from './experiment-supervisor.js';
import { NomosHttp, signIn } from './human-http.js';

// 사용법 문구의 명령 이름(진입점마다 다르다).
let commandName = 'nomos experiment';

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

// 오래 도는 감독의 출력에는 시각을 붙인다 — 몇 시간 뒤 로그를 볼 때 언제 일어난 일인지 알 수 있게.
function stamped(line = ''): void {
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  out(line ? `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())} ${line}` : '');
}

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    `사용법: ${commandName} --project <id> --login <대표 loginId> --requirements <파일.json> [--repeat N] [--run <이름>] [--dry-run]\n` +
      `        ${commandName} --project <id> --login <대표 loginId> --report --run <이름>\n` +
      '        [--server <주소>] [--interval <초>] [--round-timeout <분>] [--planning-timeout <분>] [--offline <분>] [--unclaimed <분>] [--failures <K>]\n' +
      '        [--until <시간>] [--keep-going] [--retry-wait <분>]\n',
  );
  process.exit(2);
}

type Args = {
  server: string;
  project: string;
  login?: string;
  requirements?: string;
  repeat: number;
  run?: string;
  dryRun: boolean;
  report: boolean;
  intervalSec: number;
  roundTimeoutMin: number;
  planningTimeoutMin: number;
  offlineMin: number;
  unclaimedMin: number;
  failures: number;
  untilHours?: number;
  keepGoing: boolean;
  retryWaitMin: number;
};

function parseArgs(argv: string[]): Args {
  const value = (i: number): string => {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) usage(`${argv[i]}에 값이 없다`);
    return v;
  };
  const positive = (raw: string, flag: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) usage(`${flag}는 1 이상의 정수다`);
    return n;
  };
  let project: string | undefined;
  const a: Omit<Args, 'project'> = {
    server: DEFAULT_SERVER,
    repeat: 1,
    dryRun: false,
    report: false,
    intervalSec: DEFAULTS.pollMs / 1000,
    roundTimeoutMin: DEFAULTS.roundTimeoutMs / 60_000,
    planningTimeoutMin: DEFAULTS.planningTimeoutMs / 60_000,
    offlineMin: DEFAULTS.offlineMs / 60_000,
    unclaimedMin: DEFAULTS.unclaimedMs / 60_000,
    failures: DEFAULTS.failureLimit,
    keepGoing: false,
    retryWaitMin: 5,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--server') a.server = value(i++);
    else if (arg === '--project') project = value(i++);
    else if (arg === '--login') a.login = value(i++);
    else if (arg === '--requirements') a.requirements = value(i++);
    else if (arg === '--repeat') a.repeat = positive(value(i++), '--repeat');
    else if (arg === '--run') a.run = value(i++);
    else if (arg === '--interval') a.intervalSec = positive(value(i++), '--interval');
    else if (arg === '--round-timeout') a.roundTimeoutMin = positive(value(i++), '--round-timeout');
    else if (arg === '--planning-timeout') a.planningTimeoutMin = positive(value(i++), '--planning-timeout');
    else if (arg === '--offline') a.offlineMin = positive(value(i++), '--offline');
    else if (arg === '--unclaimed') a.unclaimedMin = positive(value(i++), '--unclaimed');
    else if (arg === '--failures') a.failures = positive(value(i++), '--failures');
    else if (arg === '--until') a.untilHours = positive(value(i++), '--until');
    else if (arg === '--keep-going') a.keepGoing = true;
    else if (arg === '--retry-wait') a.retryWaitMin = positive(value(i++), '--retry-wait');
    else if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--report') a.report = true;
    else usage(`모르는 인자: ${arg}`);
  }
  if (!project) usage('--project가 필요하다');
  if (a.run !== undefined && !RUN_ID.test(a.run)) usage('--run은 영문·숫자·하이픈 24자 이내다');
  if (a.report && !a.run) usage('--report에는 --run이 필요하다(상태 파일로 요구사항·회차를 안다)');
  if (!a.report && !a.requirements) usage('--requirements가 필요하다');
  // 하루짜리 실행이 고장 한 번에 끝나면 --until의 의미가 없다.
  if (a.untilHours !== undefined) a.keepGoing = true;
  return { ...a, project, server: a.server.replace(/\/+$/, '') };
}

function fileStore(runsDir: string, run: string): StateStore {
  const file = path.join(runsDir, `${run}.json`);
  return {
    async load() {
      try {
        return JSON.parse(await readFile(file, 'utf8')) as RunState;
      } catch {
        return null;
      }
    },
    async save(state) {
      await mkdir(runsDir, { recursive: true });
      // 임시 파일에 쓰고 바꿔 끼운다 — 쓰는 도중 꺼지면(정전·강제 종료) 상태 파일이 반쯤 남아 이어 가지 못한다.
      const tmp = `${file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
      await rename(tmp, file);
    },
  };
}

async function alert(text: string): Promise<void> {
  const url = process.env.EXPERIMENT_ALERT_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `[NOMOS 무인 실험] ${text}` }) });
  } catch (err) {
    process.stderr.write(`알림 웹훅 실패: ${(err as Error).message}\n`);
  }
}

// 자동으로 풀 수 없는 멈춤은 종료 코드 3, 그 밖의 실패는 1, 사용법 오류는 2.
export async function experimentCli(argv: string[], opts: { command: string; runsDir: string }): Promise<void> {
  commandName = opts.command;
  try {
    await runExperiment(argv, opts.runsDir);
  } catch (err) {
    const message = (err as Error).message;
    if (err instanceof HaltError) {
      process.stderr.write(`멈춤: ${message}\n`);
      await alert(message);
      process.exit(3);
    }
    process.stderr.write(`실패: ${message}\n`);
    process.exit(1);
  }
}

async function runExperiment(argv: string[], runsDir: string): Promise<void> {
  const args = parseArgs(argv);
  const api = new NomosHttp(args.server);
  out(`서버: ${args.server}`);
  await signIn(api, args.login);

  if (args.report) {
    const state = (await fileStore(runsDir, args.run!).load()) ?? emptyState(args.run!, args.project);
    for (const line of formatExperimentReport(await experimentReport(api, args.project, state))) out(line);
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(args.requirements!, 'utf8'));
  } catch (err) {
    throw new Error(`${args.requirements}를 읽지 못했다: ${(err as Error).message}`);
  }
  const parsed = requirementsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${args.requirements} 형식이 틀렸다:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);

  const run = args.run ?? newRunId(new Date());
  const io = { log: stamped, sleep: (ms: number) => sleep(ms).then(() => undefined), now: () => Date.now() };
  const make = () =>
    new Supervisor(
      api,
      {
        projectId: args.project,
        requirements: parsed.data,
        repeat: args.repeat,
        run,
        dryRun: args.dryRun,
        pollMs: args.intervalSec * 1000,
        roundTimeoutMs: args.roundTimeoutMin * 60_000,
        planningTimeoutMs: args.planningTimeoutMin * 60_000,
        offlineMs: args.offlineMin * 60_000,
        unclaimedMs: args.unclaimedMin * 60_000,
        failureLimit: args.failures,
        ...(args.untilHours !== undefined ? { untilMs: args.untilHours * 3_600_000 } : {}),
      },
        fileStore(runsDir, run),
      io,
    );
  if (args.keepGoing && !args.dryRun) {
    stamped(`--keep-going: 멈춰도 ${args.retryWaitMin}분 뒤 이어 간다(Ctrl+C로 끝낸다). 끝낸 뒤에도 --run ${run}으로 이어 갈 수 있다`);
    await superviseWithRetry(make, io, { retryWaitMs: args.retryWaitMin * 60_000, notify: alert });
  } else {
    await make().run();
  }
}
