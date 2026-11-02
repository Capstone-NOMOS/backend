// 질문 모으기 — 빈칸을 심은 명세로 FE·BE 태스크를 만들어 에이전트가 실제로 막혀 묻게 한다(질문 라우팅 실험, docs/experiment-question-routing.md).
// question-probe와 달리 명세에 "누가 정한다"를 쓰지 않는다. 나온 질문은 라우터가 본 입력과 함께 저장되고(032),
// GET /projects/:id/routing-dataset으로 내보내 오프라인 평가에 그대로 넣는다 — 실행은 질문을 모을 때 한 번만.
//
//   npm run harvest:questions -- --project <id> --login <대표> --scenario <파일> --fe-repo <owner/name|id> --be-repo <owner/name|id>
//   npm run harvest:questions -- ... --only F-1,F-2        # 기능 고르기(기본 전부)
//   npm run harvest:questions -- ... --dry-run             # 서버로 보낼 본문만 출력(아무것도 만들지 않는다)
//   npm run harvest:questions -- --report --project <id> --scenario <파일> --login <대표>   # 기능별 심은 빈칸·나온 질문·발생률
//   --server <주소>   기본 https://nomos-team.duckdns.org  (로컬: http://localhost:3000)
//
// 예시 시나리오: scripts/examples/harvest.example.json. 시나리오의 plantedGaps(예상 담당자)는 서버로 보내지 않는다 — 집계에만 쓴다.
// 대표 권한(API)으로 만든다. 비밀번호는 NOMOS_PASSWORD 또는 입력 창, 이미 받은 토큰이면 NOMOS_TOKEN. 서버 코드·DB를 거치지 않는다.
import { readFileSync } from 'node:fs';
import { Api, findProjectRepo, loginAsRepresentative, type ProjectDetail } from './lib/nomos-http.js';
import {
  buildHarvestRequests,
  harvestReport,
  harvestStamp,
  parseHarvestScenario,
  pickFeatures,
  type DatasetItemForReport,
} from './lib/question-harvest.js';

const DEFAULT_SERVER = 'https://nomos-team.duckdns.org';

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    '사용법: npm run harvest:questions -- --project <id> --login <대표 loginId> --scenario <파일> --fe-repo <owner/name|id> --be-repo <owner/name|id>\n' +
      '        [--only F-1,F-2] [--server <주소>] [--dry-run]\n' +
      '        npm run harvest:questions -- --report --project <id> --scenario <파일> --login <대표 loginId>\n',
  );
  process.exit(2);
}

type Args = {
  server: string;
  project: string | undefined;
  login: string | undefined;
  scenario: string;
  feRepo: string | undefined;
  beRepo: string | undefined;
  only: string | undefined;
  dryRun: boolean;
  report: boolean;
};

function parseArgs(argv: string[]): Args {
  const value = (i: number): string => {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) usage(`${argv[i]}에 값이 없다`);
    return v;
  };
  const a: Partial<Args> & { dryRun: boolean; report: boolean; server: string } = { dryRun: false, report: false, server: DEFAULT_SERVER };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--server') a.server = value(i++);
    else if (arg === '--project') a.project = value(i++);
    else if (arg === '--login') a.login = value(i++);
    else if (arg === '--scenario') a.scenario = value(i++);
    else if (arg === '--fe-repo') a.feRepo = value(i++);
    else if (arg === '--be-repo') a.beRepo = value(i++);
    else if (arg === '--only') a.only = value(i++);
    else if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--report') a.report = true;
    else usage(`모르는 인자: ${arg}`);
  }
  if (!a.scenario) usage('--scenario가 필요하다');
  if (!a.dryRun && !a.project) usage('--project가 필요하다');
  return { ...a, server: a.server.replace(/\/+$/, ''), scenario: a.scenario } as Args;
}

async function report(api: Api, args: Args, scenarioFile: ReturnType<typeof parseHarvestScenario>): Promise<void> {
  const [dataset, specs] = await Promise.all([
    api.call<{ items: DatasetItemForReport[] }>('GET', `/projects/${args.project}/routing-dataset`),
    api.call<{ specs: { featureKey: string }[] }>('GET', `/projects/${args.project}/specs`),
  ]);
  const rows = harvestReport(scenarioFile, dataset.items, specs.specs.map((s) => s.featureKey));
  out('기능별 질문 발생률 (질문 문장 수 ÷ (심은 빈칸 × 투입 횟수))');
  for (const r of rows) {
    const owners = Object.entries(r.expectedOwners).map(([k, n]) => `${k} ${n}`).join(', ') || '-';
    const targets = Object.entries(r.byTarget).map(([k, n]) => `${k} ${n}`).join(', ') || '-';
    out(`  ${r.featureKey}: 심은 빈칸 ${r.plantedGaps}(${owners}) · 투입 ${r.runs}회 · 질문 ${r.questions}개(호출 ${r.questionRows}회) · 발생률 ${r.rate} · 보낸 곳 ${targets}`);
  }
  const planted = rows.reduce((n, r) => n + r.plantedGaps * Math.max(r.runs, 1), 0);
  const asked = rows.reduce((n, r) => n + r.questions, 0);
  out(`  합계: 질문 ${asked}개 / 심은 빈칸 ${planted}(투입 반영) → ${planted === 0 ? '-' : `${Math.round((100 * asked) / planted)}%`}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scenario = parseHarvestScenario(JSON.parse(readFileSync(args.scenario, 'utf8')));
  const api = new Api(args.server);

  if (args.report) {
    await loginAsRepresentative(api, args.login, () => usage('--login이 필요하다 (또는 NOMOS_TOKEN)'));
    await report(api, args, scenario);
    return;
  }

  const stamp = harvestStamp();
  const requests = buildHarvestRequests(pickFeatures(scenario, args.only), stamp);
  out(`서버: ${args.server}`);
  out(`기능: ${requests.map((r) => r.featureKey).join(', ')}  (꼬리표 ${stamp})`);

  if (args.dryRun) {
    for (const r of requests) {
      out();
      out(`[${r.featureKey}] POST /projects/:id/specs`);
      out(JSON.stringify(r.spec, null, 2).replace(/^/gm, '  '));
      for (const t of r.tasks) out(`  POST /projects/:id/tasks ${JSON.stringify({ ...t, repoId: `<${t.teamRole} 레포>`, specId: '<위 명세>' })}`);
    }
    out();
    out('--dry-run: 아무것도 만들지 않았다 (심은 빈칸·예상 담당자는 서버로 보내지 않는다)');
    return;
  }

  await loginAsRepresentative(api, args.login, () => usage('--login이 필요하다 (또는 NOMOS_TOKEN)'));
  const detail = await api.call<ProjectDetail>('GET', `/projects/${args.project}`);
  out(`프로젝트: ${detail.project.name} (${detail.project.status})`);
  if (!detail.project.questionRelay) throw new Error('이 프로젝트는 질문 중계가 꺼져 있다(questionRelay=false) — 에이전트가 묻지 않고 가정한다');
  if (!['planning', 'active'].includes(detail.project.status)) throw new Error(`프로젝트 상태가 ${detail.project.status}라 명세·태스크를 만들 수 없다 (planning·active만)`);

  const roles = new Set(requests.flatMap((r) => r.tasks.map((t) => t.teamRole)));
  const repoByRole = new Map<string, { id: string; fullName: string }>();
  for (const role of roles) {
    const raw = role === 'FRONTEND' ? args.feRepo : args.beRepo;
    const flag = role === 'FRONTEND' ? '--fe-repo' : '--be-repo';
    if (!raw) usage(`${flag}가 필요하다 (${role} 태스크가 들어갈 레포)`);
    repoByRole.set(role, findProjectRepo(detail, raw, flag));
    const m = detail.members.find((x) => x.teamRole === role);
    if (!m) out(`  ! ${role} 담당이 배정되지 않았다 — 배정한 뒤 진행하라`);
    else if (!m.agentId) out(`  ! ${role} 담당의 에이전트가 연결돼 있지 않다 — 그 노트북에서 connect`);
  }

  out();
  for (const r of requests) {
    const spec = await api.call<{ id: string }>('POST', `/projects/${args.project}/specs`, r.spec);
    out(`[${r.featureKey}] 명세 ${r.spec.featureKey} 만듦`);
    for (const t of r.tasks) {
      const task = await api.call<{ id: string; state: string }>('POST', `/projects/${args.project}/tasks`, { ...t, repoId: repoByRole.get(t.teamRole)!.id, specId: spec.id });
      out(`      태스크 ${task.id} (${task.state}) · ${t.teamRole} · ${t.title}`);
    }
  }
  out();
  out('다음: 각 노트북에서 npx @capstone-nomos/cli@latest connect → 에이전트가 묻는 질문에 화면에서 답한다(정답 라벨은 POST /questions/:id/gold).');
  out(`집계: npm run harvest:questions -- --report --project ${args.project} --scenario ${args.scenario} --login <대표>`);
}

main().catch((err: unknown) => {
  process.stderr.write(`실패: ${(err as Error).message}\n`);
  process.exit(1);
});
