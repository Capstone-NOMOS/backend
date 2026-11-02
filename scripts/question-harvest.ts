// 질문 모으기 반복 실행(033) — 기능 명세·계약을 확정한 실험 모드 프로젝트에 같은 태스크 묶음을 N회 넣어 질문 발생률을 잰다.
//
//   npm run harvest:questions -- --project <id> --login <대표 loginId> --tasks <파일.json> --repeat 5
//   npm run harvest:questions -- ... --dry-run            # 확인만 하고 만들 제목을 출력
//   npm run harvest:questions -- ... --run h202611021530  # 끊긴 실행을 이어 간다(이미 만든 회차는 건너뜀)
//   npm run harvest:questions -- --project <id> --login <대표> --report [--run <이름>]   # 단계별·회차별·태스크별 질문 수, 라우터별 판정 분포
//   --server <주소>   기본 https://nomos-team.duckdns.org  (로컬: http://localhost:3000)
//   --interval <초>   상태 확인 간격(기본 30)   --round-timeout <분>  한 회차를 기다리는 시간(기본 90)
//
// 태스크 파일: { "tasks": [{ "ref"?, "title", "teamRole", "kind"?, "repo": "owner/name", "featureKey", "dependsOn"?: [ref] }] }
// 예시는 scripts/examples/question-harvest.json. 규칙과 이유는 scripts/lib/question-harvest.ts, 절차는 docs/experiment-question-routing.md.
// 대표 권한(HTTP)만 쓴다 — 서버 코드(env.ts·DB)를 거치지 않는다. 비밀번호는 NOMOS_PASSWORD 또는 입력 창, 받은 토큰이 있으면 NOMOS_TOKEN.
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { NomosHttp, signIn } from './lib/nomos-http.js';
import { formatHarvestReport, harvestFileSchema, harvestReport, newRunId, RUN_ID, runHarvest } from './lib/question-harvest.js';

const DEFAULT_SERVER = 'https://nomos-team.duckdns.org';

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    '사용법: npm run harvest:questions -- --project <id> --login <대표 loginId> --tasks <파일.json> --repeat N [--dry-run] [--run <이름>]\n' +
      '        npm run harvest:questions -- --project <id> --login <대표 loginId> --report [--run <이름>]\n' +
      '        [--server <주소>] [--interval <초>] [--round-timeout <분>]\n',
  );
  process.exit(2);
}

type Args = {
  server: string;
  project: string;
  login: string | undefined;
  tasks: string | undefined;
  repeat: number;
  run: string | undefined;
  dryRun: boolean;
  report: boolean;
  intervalSec: number;
  roundTimeoutMin: number;
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
  const args: Partial<Args> & { server: string; dryRun: boolean; report: boolean; repeat: number; intervalSec: number; roundTimeoutMin: number } = {
    server: DEFAULT_SERVER,
    dryRun: false,
    report: false,
    repeat: 0,
    intervalSec: 30,
    roundTimeoutMin: 90,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--server') args.server = value(i++);
    else if (arg === '--project') args.project = value(i++);
    else if (arg === '--login') args.login = value(i++);
    else if (arg === '--tasks') args.tasks = value(i++);
    else if (arg === '--repeat') args.repeat = positive(value(i++), '--repeat');
    else if (arg === '--run') args.run = value(i++);
    else if (arg === '--interval') args.intervalSec = positive(value(i++), '--interval');
    else if (arg === '--round-timeout') args.roundTimeoutMin = positive(value(i++), '--round-timeout');
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--report') args.report = true;
    else usage(`모르는 인자: ${arg}`);
  }
  if (!args.project) usage('--project가 필요하다');
  if (args.run !== undefined && !RUN_ID.test(args.run)) usage('--run은 영문·숫자·하이픈 24자 이내다');
  if (!args.report) {
    if (!args.tasks) usage('--tasks가 필요하다');
    if (args.repeat < 1) usage('--repeat이 필요하다');
  }
  return { ...args, project: args.project, server: args.server.replace(/\/+$/, '') } as Args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const api = new NomosHttp(args.server);
  out(`서버: ${args.server}`);
  await signIn(api, args.login);

  if (args.report) {
    for (const line of formatHarvestReport(await harvestReport(api, args.project, args.run ?? null))) out(line);
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(args.tasks!, 'utf8'));
  } catch (err) {
    throw new Error(`${args.tasks}를 읽지 못했다: ${(err as Error).message}`);
  }
  const parsed = harvestFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${args.tasks} 형식이 틀렸다:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  await runHarvest(
    api,
    {
      projectId: args.project,
      file: parsed.data,
      repeat: args.repeat,
      run: args.run ?? newRunId(new Date()),
      dryRun: args.dryRun,
      pollMs: args.intervalSec * 1000,
      roundTimeoutMs: args.roundTimeoutMin * 60_000,
    },
    { log: out, sleep: (ms) => sleep(ms).then(() => undefined) },
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`실패: ${(err as Error).message}\n`);
  process.exit(1);
});
