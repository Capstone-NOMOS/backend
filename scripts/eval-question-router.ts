// 질문 라우터 오프라인 평가 — 데이터셋의 질문마다 라우터를 돌려 정답과 비교한다.
// 데이터셋 형식은 scripts/data/README-question-routing.md, 빈 틀은 scripts/data/question-routing.template.json.
//
//   npx tsx scripts/eval-question-router.ts opposite                       # 기본 데이터셋(scripts/data/question-routing.json)
//   npx tsx scripts/eval-question-router.ts claude:sonnet --data team.json --repeat 2
//   npx tsx scripts/eval-question-router.ts http://localhost:8080/route --data team.json   # Jev 같은 외부 결정 모델
//   npx tsx scripts/eval-question-router.ts --check --data team.json      # 형식 검사만(라우터를 부르지 않는다)
//
// 지표: 정확도(accept에 든 판정), SELF 탐지(정답이 SELF뿐인 문항을 SELF로), 잘못 막음(남에게 물어야 할 걸 SELF로),
// 지연·비용. 결과는 scripts/data/router-runs/에 남긴다(커밋하지 않는다).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { oppositeRoleRouter, type RoutingInput, type RoutingTarget } from '../src/domain/question/router.js';
import { TEAM_ROLES } from '../src/domain/roles.js';
import { claudeCliRouter, httpRouter, type EvalRouter } from './lib/question-routers.js';

// --- 데이터셋 형식 ---
const roleSchema = z.enum(TEAM_ROLES);
const targetSchema = z.union([roleSchema, z.literal('SELF')]);
const contextSchema = z.object({
  askerRole: roleSchema,
  task: z.object({ title: z.string().min(1), kind: z.string().default('IMPLEMENT') }),
  repo: z.object({ fullName: z.string().min(1) }).nullable().default(null),
  spec: z.object({ featureKey: z.string(), title: z.string(), content: z.string() }).nullable().default(null),
});
const itemSchema = z
  .object({
    id: z.string().min(1),
    context: z.string().min(1),
    // 질문 하나면 question, 한 번의 AskUserQuestion에 여러 개였으면 questions(라우터는 묶음 전체에 한 역할을 고른다).
    question: z.string().min(1).optional(),
    questions: z.array(z.string().min(1)).min(1).max(4).optional(),
    // 정답으로 인정하는 판정. 애매하면 둘 이상. SELF = 묻는 쪽 자기 소관.
    accept: z.array(targetSchema).min(1),
    source: z.string().default('unknown'),
    labeledBy: z.string().optional(),
    note: z.string().optional(),
  })
  .refine((i) => (i.question === undefined) !== (i.questions === undefined), { message: 'question과 questions 중 하나만 쓴다' });
const datasetSchema = z.object({
  version: z.union([z.number(), z.string()]),
  roles: z.array(roleSchema).min(2).default([...TEAM_ROLES]),
  contexts: z.record(contextSchema),
  items: z.array(itemSchema).min(1),
});
type Dataset = z.infer<typeof datasetSchema>;

function loadDataset(file: string): Dataset {
  const parsed = datasetSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`데이터셋 형식 오류 (${problems.length}건)\n${problems.join('\n')}`);
  }
  const data = parsed.data;
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const item of data.items) {
    if (ids.has(item.id)) problems.push(`  - items.${item.id}: id가 겹친다`);
    ids.add(item.id);
    if (!data.contexts[item.context]) problems.push(`  - items.${item.id}: 없는 context "${item.context}"`);
  }
  if (problems.length) throw new Error(`데이터셋 형식 오류 (${problems.length}건)\n${problems.join('\n')}`);
  return data;
}

// --- 인자 ---
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const checkOnly = argv.includes('--check');
const dataFile = path.resolve(flag('--data') ?? 'scripts/data/question-routing.json');
const repeat = Number(flag('--repeat') ?? 1) || 1;
const routerSpec = argv.find((a, i) => !a.startsWith('--') && !['--data', '--repeat'].includes(argv[i - 1] ?? '')) ?? 'opposite';
const concurrency = 4;

const dataset = loadDataset(dataFile);
const counts = { items: dataset.items.length, self: dataset.items.filter((i) => i.accept.length === 1 && i.accept[0] === 'SELF').length, multi: dataset.items.filter((i) => i.questions).length };
console.log(`dataset ${path.relative(process.cwd(), dataFile)} v${dataset.version}: ${counts.items}문항 (SELF만 정답 ${counts.self}, 여러 질문 묶음 ${counts.multi})`);
if (checkOnly) process.exit(0);

function pickRouter(s: string): EvalRouter {
  if (s === 'opposite') return { ...oppositeRoleRouter, routeWithCost: async (i) => ({ ...(await oppositeRoleRouter.route(i)), costUsd: 0 }) };
  if (s === 'claude' || s.startsWith('claude:')) return claudeCliRouter(s.split(':')[1]);
  if (s.startsWith('http')) return httpRouter(s);
  throw new Error(`unknown router: ${s} (opposite | claude[:model] | http(s)://...)`);
}
const router = pickRouter(routerSpec);

// --- 실행 ---
type Row = { id: string; run: number; accept: RoutingTarget[]; target: RoutingTarget | 'ERROR'; ok: boolean; confidence: number | null; reason: string | null; ms: number; costUsd: number | null; error?: string };
const jobs = dataset.items.flatMap((item) => Array.from({ length: repeat }, (_, run) => ({ item, run })));
const rows: Row[] = [];

async function worker(): Promise<void> {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    const ctx = dataset.contexts[job.item.context]!;
    const texts = job.item.questions ?? [job.item.question!];
    const input: RoutingInput = { askerRole: ctx.askerRole, roles: dataset.roles, task: ctx.task, repo: ctx.repo, spec: ctx.spec, questions: texts.map((question) => ({ question, options: [] })) };
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
const items = new Map(dataset.items.map((i) => [i.id, i]));
const summary = {
  router: router.name,
  dataset: path.basename(dataFile),
  datasetVersion: dataset.version,
  runs: rows.length,
  accuracy: pct(rows.filter((r) => r.ok).length, rows.length),
  selfRecall: pct(selfOnly.filter((r) => r.target === 'SELF').length, selfOnly.length),
  wronglyKept: pct(notSelf.filter((r) => r.target === 'SELF').length, notSelf.length),
  // 같은 문항을 여러 번 돌렸을 때 판정이 갈린 문항 수(--repeat 2 이상에서 의미가 있다)
  unstable: repeat > 1 ? dataset.items.filter((i) => new Set(rows.filter((r) => r.id === i.id).map((r) => r.target)).size > 1).length : null,
  errors: rows.filter((r) => r.target === 'ERROR').length,
  avgMs: Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length),
  totalCostUsd: costs.length ? +costs.reduce((s, c) => s + c, 0).toFixed(4) : null,
};

for (const item of dataset.items) {
  const rs = rows.filter((r) => r.id === item.id);
  const text = (item.questions ?? [item.question!]).join(' / ');
  console.log(`${item.id} ${rs.every((r) => r.ok) ? 'OK ' : 'NG '} accept=${item.accept.join('|').padEnd(14)} got=${rs.map((r) => r.target).join(',').padEnd(16)} ${text.slice(0, 50)}`);
  for (const r of rs.filter((x) => x.error)) console.log(`      error: ${r.error}`);
}
console.log(JSON.stringify(summary, null, 2));

const outDir = path.resolve('scripts/data/router-runs');
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${router.name.replace(/[^a-z0-9._-]+/gi, '_')}.json`);
writeFileSync(file, JSON.stringify({ summary, rows: rows.map((r) => ({ ...r, question: items.get(r.id)?.question ?? items.get(r.id)?.questions })) }, null, 2));
console.log(`saved ${path.relative(process.cwd(), file)}`);
