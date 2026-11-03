// 질문 라우팅 보고서 보기 — 운영(또는 로컬) 서버의 GET /projects/:id/routing-report를 대표 권한으로 읽어 표로 찍는다.
// 라우터 비교(Claude · OpenAI · Jev)가 실제 질문마다 돌았는지, 지연·비용이 쌓였는지 확인하는 용도다.
//
//   npm run routing:report -- --project <id> --login <대표 loginId>          # 기본 운영 서버
//   npm run routing:report -- --project <id> --login rep --server http://localhost:18080
//   --last <N>   질문별 판정을 최근 N개만(기본 10)
//
// 비밀번호는 NOMOS_PASSWORD 또는 입력 창(화면에 안 보임), 이미 받은 토큰은 NOMOS_TOKEN. 서버 코드(env.ts·DB)를 거치지 않는다 — HTTP만 쓴다.
import { NomosHttp, signIn } from './lib/nomos-http.js';

const DEFAULT_SERVER = 'https://nomos-team.duckdns.org';

type Report = {
  questions: number;
  labeled: number;
  routers: {
    router: string;
    mode: string;
    decisions: number;
    errors: number;
    alignmentRate: number | null;
    avgLatencyMs: number | null;
    p95LatencyMs: number | null;
    avgCostUsd: number | null;
    totalCostUsd: number | null;
  }[];
  rows: { askedAt: string; askerRole: string; stage: string; firstQuestion: string; goldTarget: string | null; decisions: Record<string, string | null> }[];
};

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const project = flag('--project');
if (!project) {
  process.stderr.write('사용법: npm run routing:report -- --project <id> --login <대표 loginId> [--server <주소>] [--last N]\n');
  process.exit(2);
}
const server = (flag('--server') ?? DEFAULT_SERVER).replace(/\/+$/, '');
const last = Number(flag('--last') ?? 10) || 10;

const api = new NomosHttp(server);
await signIn(api, flag('--login'));
const report = await api.call<Report>('GET', `/projects/${project}/routing-report`);

out(`${server} · 프로젝트 ${project} · 질문 ${report.questions}개 (정답 라벨 ${report.labeled})`);
out();
out('라우터별 — 판정 수 · 실패 · 지연 평균/p95 · 요청당 비용 · 비용 합 · 정답 일치율');
for (const r of report.routers) {
  const usd = (n: number | null) => (n === null ? '-' : `$${n.toFixed(6)}`);
  const ms = (n: number | null) => (n === null ? '-' : `${n}ms`);
  out(
    `  ${r.mode.padEnd(8)} ${r.router.padEnd(34)} 판정 ${String(r.decisions).padStart(3)}  실패 ${String(r.errors).padStart(3)}  ` +
      `${ms(r.avgLatencyMs).padStart(8)}/${ms(r.p95LatencyMs).padEnd(8)} ${usd(r.avgCostUsd).padStart(10)} ${usd(r.totalCostUsd).padStart(10)}  ` +
      `${r.alignmentRate === null ? '-' : `${Math.round(r.alignmentRate * 100)}%`}`,
  );
}
out();
const rows = [...report.rows].sort((a, b) => b.askedAt.localeCompare(a.askedAt)).slice(0, last);
out(`최근 질문 ${rows.length}개 — 라우터별 판정 (실패는 ✗)`);
for (const row of rows) {
  out(`  ${row.askedAt.slice(0, 19)} ${row.stage} ${row.askerRole} — ${row.firstQuestion.slice(0, 60)}${row.goldTarget ? ` (정답 ${row.goldTarget})` : ''}`);
  for (const [router, target] of Object.entries(row.decisions)) out(`      ${router.padEnd(34)} ${target ?? '✗'}`);
}
