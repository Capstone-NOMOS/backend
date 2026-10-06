// 질문 라우터 오프라인 평가 — 데이터셋(scripts/data/question-routing.json)의 질문마다 라우터를 돌려 정답과 비교한다.
//
//   npx tsx scripts/eval-question-router.ts opposite
//   npx tsx scripts/eval-question-router.ts claude            # 이 PC의 Claude Code 기본 모델(구독 사용량을 쓴다)
//   npx tsx scripts/eval-question-router.ts claude:sonnet --repeat 2
//   npx tsx scripts/eval-question-router.ts http://localhost:8080/route   # Jev 같은 외부 결정 모델
//
// 지표: 정확도(accept에 든 판정), SELF 탐지(정답이 SELF뿐인 문항을 SELF로), 넘겨선 안 될 것을 넘김(SELF를 남에게),
// 지연·비용. 결과는 scripts/data/router-runs/에 남긴다 — 라우터·프롬프트를 바꿔 가며 비교한다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { oppositeRoleRouter, type RoutingInput, type RoutingTarget } from '../src/domain/question/router.js';
import type { TeamRole } from '../src/domain/roles.js';
import { claudeCliRouter, httpRouter, type EvalRouter } from './lib/question-routers.js';

type Context = { askerRole: TeamRole; task: RoutingInput['task']; repo: RoutingInput['repo']; spec: RoutingInput['spec'] };
type Item = { id: string; context: string; source: string; question: string; accept: RoutingTarget[] };
type Dataset = { version: number; contexts: Record<string, Context>; items: Item[] };

const [spec = 'opposite', ...rest] = process.argv.slice(2);
const repeat = Number(rest[rest.indexOf('--repeat') + 1] ?? 1) || 1;
const concurrency = 4;

function pickRouter(s: string): EvalRouter {
  if (s === 'opposite') return { ...oppositeRoleRouter, routeWithCost: async (i) => ({ ...(await oppositeRoleRouter.route(i)), costUsd: 0 }) };
  if (s === 'claude' || s.startsWith('claude:')) return claudeCliRouter(s.split(':')[1]);
  if (s.startsWith('http')) return httpRouter(s);
  throw new Error(`unknown router: ${s} (opposite | claude[:model] | http(s)://...)`);
}

const dataset = JSON.parse(readFileSync(path.resolve('scripts/data/question-routing.json'), 'utf8')) as Dataset;
const router = pickRouter(spec);

type Row = { id: string; run: number; accept: RoutingTarget[]; target: RoutingTarget | 'ERROR'; ok: boolean; confidence: number | null; reason: string | null; ms: number; costUsd: number | null; error?: string };
const jobs = dataset.items.flatMap((item) => Array.from({ length: repeat }, (_, run) => ({ item, run })));
const rows: Row[] = [];

async function worker(): Promise<void> {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    const ctx = dataset.contexts[job.item.context]!;
    const input: RoutingInput = { askerRole: ctx.askerRole, roles: ['FRONTEND', 'BACKEND'], task: ctx.task, repo: ctx.repo, spec: ctx.spec, questions: [{ question: job.item.question, options: [] }] };
    const started = Date.now();
    try {
      const d = await router.routeWithCost(input);
      rows.push({ id: job.item.id, run: job.run, accept: job.item.accept, target: d.target, ok: job.item.accept.includes(d.target), confidence: d.confidence, reason: d.reason, ms: Date.now() - started, costUsd: d.costUsd });
    } catch (err) {
      rows.push({ id: job.item.id, run: job.run, accept: job.item.accept, target: 'ERROR', ok: false, confidence: null, reason: null, ms: Date.now() - started, costUsd: null, error: err instanceof Error ? err.message : String(err) });
    }
    process.stderr.write('.');
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
process.stderr.write('\n');
rows.sort((a, b) => a.id.localeCompare(b.id) || a.run - b.run);

const selfOnly = rows.filter((r) => r.accept.length === 1 && r.accept[0] === 'SELF');
const notSelf = rows.filter((r) => !r.accept.includes('SELF'));
const pct = (n: number, d: number) => (d === 0 ? '-' : `${Math.round((100 * n) / d)}%`);
const costs = rows.map((r) => r.costUsd).filter((c): c is number => c !== null);
const summary = {
  router: router.name,
  datasetVersion: dataset.version,
  runs: rows.length,
  accuracy: pct(rows.filter((r) => r.ok).length, rows.length),
  selfRecall: pct(selfOnly.filter((r) => r.target === 'SELF').length, selfOnly.length), // 자기 소관을 알아봤나
  wronglyKept: pct(notSelf.filter((r) => r.target === 'SELF').length, notSelf.length), // 남에게 물어야 할 걸 SELF로 막았나
  errors: rows.filter((r) => r.target === 'ERROR').length,
  avgMs: Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length),
  totalCostUsd: costs.length ? +costs.reduce((s, c) => s + c, 0).toFixed(4) : null,
};

const byItem = dataset.items.map((item) => {
  const rs = rows.filter((r) => r.id === item.id);
  return `${item.id} ${rs.every((r) => r.ok) ? 'OK ' : 'NG '} accept=${item.accept.join('|').padEnd(14)} got=${rs.map((r) => r.target).join(',').padEnd(16)} ${item.question.slice(0, 50)}`;
});
console.log(byItem.join('\n'));
console.log(JSON.stringify(summary, null, 2));

const outDir = path.resolve('scripts/data/router-runs');
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${router.name.replace(/[^a-z0-9._-]+/gi, '_')}.json`);
writeFileSync(file, JSON.stringify({ summary, rows }, null, 2));
console.log(`saved ${path.relative(process.cwd(), file)}`);
