// 질문 라우터 오프라인 평가 — 데이터셋의 질문마다 라우터를 돌려 정답과 비교한다.
// 데이터셋 형식은 scripts/data/README-question-routing.md(v2: 항목마다 운영과 같은 RoutingInputSnapshot, v1: contexts 참조 — 둘 다 읽는다),
// 빈 틀은 scripts/data/question-routing.template.json. 운영에서 모은 질문은 GET /projects/:id/routing-dataset 응답 파일을 그대로 넣는다.
// 평가는 항목의 input을 그대로 라우터에 넣는다(다시 조립하지 않는다).
//
//   npx tsx scripts/eval-question-router.ts opposite                       # 기본 데이터셋(scripts/data/question-routing.json)
//   npx tsx scripts/eval-question-router.ts claude-api --data team.json --concurrency 1   # 운영 llm 라우터와 같은 API 호출(셸의 ANTHROPIC_API_KEY, 기본 claude-sonnet-5-5)
//   npx tsx scripts/eval-question-router.ts claude:sonnet --data team.json --repeat 2      # 이 PC의 Claude Code(CLI) — 라우터 비교에는 claude-api
//   npx tsx scripts/eval-question-router.ts openai:gpt-6.1-sol --data team.json   # OpenAI(셸의 OPENAI_API_KEY)
//   npx tsx scripts/eval-question-router.ts openai-decisions --data team.json     # OpenAI 결정 전용 API(gpt-6-luna, 셸의 OPENAI_API_KEY)
//   npx tsx scripts/eval-question-router.ts jev --data team.json                  # TypeSafe Jev(셸의 TYPESAFE_API_KEY, 기본 jev-1.14.0)
//   npx tsx scripts/eval-question-router.ts http://localhost:8080/route --data team.json   # 그 밖의 외부 결정 모델
//   npx tsx scripts/eval-question-router.ts --check --data team.json      # 형식 검사만(라우터를 부르지 않는다)
//   npx tsx scripts/eval-question-router.ts jev --data team.json --ids test.json --team-rules rules.json   # 팀 규칙을 넣고 일부 문항만
//
// --team-rules: { "rules": { "FRONTEND": "...", "BACKEND": "...", "PM": "..." } } — 문항마다 input.teamRules로 넣는다(세 라우터가 같은 문장을 받는다).
//   결과의 라우터 이름에 +team-<규칙 해시 8자>가 붙고 요약에 규칙 원문이 남는다 — 규칙 전·후 결과가 섞이지 않는다.
// --ids: 문항 id 배열(JSON) 또는 { "ids": [...] } — 그 문항만 잰다(규칙을 쓴 문항과 재는 문항을 나눌 때).
//
// 지표: 정확도(accept에 든 판정), SELF 탐지(정답이 SELF뿐인 문항을 SELF로), 잘못 막음(남에게 물어야 할 걸 SELF로),
// 지연·비용. 결과는 scripts/data/router-runs/에 남긴다(커밋하지 않는다).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { oppositeRoleRouter, type TeamRules } from '../src/domain/question/router.js';
import { claudeApiEvalRouter, claudeCliRouter, httpRouter, jevEvalRouter, openAiDecisionsEvalRouter, openAiEvalRouter, type EvalRouter } from './lib/question-routers.js';
import { parseDataset, runEvaluation, summarize, type LoadedDataset } from './lib/routing-dataset.js';

function loadDataset(file: string): LoadedDataset {
  return parseDataset(JSON.parse(readFileSync(file, 'utf8')));
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
const routerSpec = argv.find((a, i) => !a.startsWith('--') && !['--data', '--repeat', '--concurrency', '--team-rules', '--ids'].includes(argv[i - 1] ?? '')) ?? 'opposite';
const teamRulesFile = flag('--team-rules');
const idsFile = flag('--ids');
// 판정 시간을 비교할 때는 --concurrency 1 — 동시에 돌리면 노트북·네트워크를 나눠 써 서로 느려진다(특히 claude CLI 여러 개).
const concurrency = Number(flag('--concurrency') ?? 4) || 4;

let dataset: LoadedDataset;
try {
  dataset = loadDataset(dataFile);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
if (idsFile) {
  const raw = JSON.parse(readFileSync(path.resolve(idsFile), 'utf8')) as string[] | { ids: string[] };
  const wanted = new Set(Array.isArray(raw) ? raw : raw.ids);
  const missing = [...wanted].filter((id) => !dataset.items.some((i) => i.id === id) && !dataset.unlabeled.includes(id));
  if (missing.length > 0) {
    console.error(`--ids에 데이터셋에 없는 문항 ${missing.length}개: ${missing.slice(0, 5).join(', ')}`);
    process.exit(1);
  }
  dataset = { ...dataset, items: dataset.items.filter((i) => wanted.has(i.id)), unlabeled: dataset.unlabeled.filter((id) => wanted.has(id)) };
}
let teamRules: { rules: TeamRules; sha: string; file: string } | null = null;
if (teamRulesFile) {
  const raw = JSON.parse(readFileSync(path.resolve(teamRulesFile), 'utf8')) as { rules?: Record<string, unknown> };
  const rules: TeamRules = {};
  for (const [k, v] of Object.entries(raw.rules ?? {})) {
    if (!['FRONTEND', 'BACKEND', 'PM'].includes(k) || typeof v !== 'string' || v.trim() === '') {
      console.error(`--team-rules의 rules는 FRONTEND·BACKEND·PM 키에 문장(문자열)만 받는다: ${k}`);
      process.exit(1);
    }
    rules[k as keyof TeamRules] = v.trim();
  }
  if (Object.keys(rules).length === 0) {
    console.error('--team-rules 파일에 규칙이 없다({ "rules": { "FRONTEND": "..." } })');
    process.exit(1);
  }
  const sha = createHash('sha256').update(JSON.stringify(rules)).digest('hex').slice(0, 8);
  teamRules = { rules, sha, file: path.basename(teamRulesFile) };
  dataset = { ...dataset, items: dataset.items.map((i) => ({ ...i, input: { ...i.input, teamRules: rules } })) };
}
const counts = {
  items: dataset.items.length,
  self: dataset.items.filter((i) => i.accept.length === 1 && i.accept[0] === 'SELF').length,
  multi: dataset.items.filter((i) => i.input.questions.length > 1).length,
};
console.log(
  `dataset ${path.relative(process.cwd(), dataFile)} (${dataset.format}) v${dataset.version}: ${counts.items}문항 (SELF만 정답 ${counts.self}, 여러 질문 묶음 ${counts.multi})`,
);
if (dataset.unlabeled.length > 0) console.log(`  정답 라벨이 없어 건너뜀 ${dataset.unlabeled.length}건: ${dataset.unlabeled.slice(0, 5).join(', ')}${dataset.unlabeled.length > 5 ? ' …' : ''}`);
if (checkOnly) process.exit(0);
if (dataset.items.length === 0) {
  console.error('평가할 문항이 없다(정답 라벨이 붙은 항목이 없다)');
  process.exit(1);
}

function pickRouter(s: string): EvalRouter {
  if (s === 'opposite') return { ...oppositeRoleRouter, routeWithCost: async (i) => ({ ...(await oppositeRoleRouter.route(i)), costUsd: 0 }) };
  if (s === 'claude-api' || s.startsWith('claude-api:')) return claudeApiEvalRouter(s.split(':')[1]);
  if (s === 'claude' || s.startsWith('claude:')) return claudeCliRouter(s.split(':')[1]);
  if (s === 'openai-decisions' || s.startsWith('openai-decisions:')) return openAiDecisionsEvalRouter(s.split(':')[1]);
  if (s === 'openai' || s.startsWith('openai:')) return openAiEvalRouter(s.split(':')[1]);
  if (s === 'jev' || s.startsWith('jev:')) return jevEvalRouter(s.split(':')[1]);
  if (s.startsWith('http')) return httpRouter(s);
  throw new Error(`unknown router: ${s} (opposite | claude-api[:model] | claude[:model] | openai[:model] | openai-decisions | jev[:model] | http(s)://...)`);
}
const baseRouter = pickRouter(routerSpec);
const router: EvalRouter = teamRules ? { ...baseRouter, name: `${baseRouter.name}+team-${teamRules.sha}` } : baseRouter;
if (teamRules) console.log(`팀 규칙 ${teamRules.file} (${teamRules.sha}) — ${Object.keys(teamRules.rules).join(', ')}`);

// --- 실행 ---
const rows = await runEvaluation(dataset.items, router, { repeat, concurrency, onProgress: () => process.stderr.write('.') });
process.stderr.write('\n');
const items = new Map(dataset.items.map((i) => [i.id, i]));
const summary = { router: router.name, dataset: path.basename(dataFile), datasetVersion: dataset.version, format: dataset.format, ...(teamRules ? { teamRules } : {}), ...(idsFile ? { ids: path.basename(idsFile) } : {}), ...summarize(rows, dataset.items, repeat) };

for (const item of dataset.items) {
  const rs = rows.filter((r) => r.id === item.id);
  const text = item.input.questions.map((q) => q.question).join(' / ');
  console.log(`${item.id} ${rs.every((r) => r.ok) ? 'OK ' : 'NG '} accept=${item.accept.join('|').padEnd(14)} got=${rs.map((r) => r.target).join(',').padEnd(16)} ${text.slice(0, 50)}`);
  for (const r of rs.filter((x) => x.error)) console.log(`      error: ${r.error}`);
}
console.log(JSON.stringify(summary, null, 2));

const outDir = path.resolve('scripts/data/router-runs');
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${router.name.replace(/[^a-z0-9._-]+/gi, '_')}.json`);
writeFileSync(file, JSON.stringify({ summary, rows: rows.map((r) => ({ ...r, questions: items.get(r.id)?.input.questions.map((q) => q.question) })) }, null, 2));
console.log(`saved ${path.relative(process.cwd(), file)}`);
