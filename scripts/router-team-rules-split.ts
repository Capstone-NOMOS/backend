// 팀 규칙 실험(발표 18장) — 채점판의 300문항과 정답으로 평가 데이터셋을 만들고, "규칙을 쓸 문항(dev)"과 "잴 문항(test)"으로 나눈다.
//
//   npx tsx scripts/router-team-rules-split.ts --board <채점판 data.json> --labels <labels 폴더> [--out scripts/data/team-rules] [--dev 100] [--seed team-rules-1] [--dev-include id,id]
//
// 왜 나누나: 300문항을 보며 규칙을 쓰고 같은 300문항으로 재면 시험 문제를 보고 답안을 쓴 셈이다(점수가 부푼다).
// 단계(feature_spec·contract·implementation) 비율을 맞춰 dev를 무작위로 뽑고, 팀은 dev만 보고 규칙을 쓴다. 규칙 전·후는 test에서 같이 잰다.
// --dev-include: 규칙 초안의 예시로 이미 쓴 문항 — test에 남으면 그 문항은 답을 보고 규칙을 쓴 셈이라 dev로 보낸다.
// 같은 --seed면 같은 분할이 나온다(재현). 결과는 scripts/data/(커밋하지 않음)에 둔다.
//
// 입력:
//   --board: 채점판 아티팩트의 data.json({ items: [{ id, stage, askerRole, input, ... }] }) — 질문할 때 저장한 입력 스냅샷
//   --labels: 채점판 DB labels 모음을 문서마다 JSON 파일로 받은 폴더(<id>.json = { target }) — 팀이 검수·합의한 정답
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Target = 'FRONTEND' | 'BACKEND' | 'PM' | 'SELF';
type BoardItem = { id: string; stage: string; askerRole: string; input: Record<string, unknown> };

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const boardFile = flag('--board');
const labelsDir = flag('--labels');
if (!boardFile || !labelsDir) {
  console.error('사용법: --board <data.json> --labels <labels 폴더> [--out 폴더] [--dev 100] [--seed 문자열] [--dev-include id,id]');
  process.exit(1);
}
const outDir = path.resolve(flag('--out') ?? 'scripts/data/team-rules');
const devSize = Number(flag('--dev') ?? 100);
const seed = flag('--seed') ?? 'team-rules-1';
const devInclude = (flag('--dev-include') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const board = (JSON.parse(readFileSync(boardFile, 'utf8')) as { items: BoardItem[] }).items;
const labels = new Map<string, Target>();
for (const f of readdirSync(labelsDir)) {
  if (f.startsWith('.') || !f.endsWith('.json')) continue;
  const doc = JSON.parse(readFileSync(path.join(labelsDir, f), 'utf8')) as { target?: string };
  if (doc.target === 'FRONTEND' || doc.target === 'BACKEND' || doc.target === 'PM' || doc.target === 'SELF') labels.set(f.slice(0, -5), doc.target);
}

// 채점판과 같은 해석: 질문한 역할 이름 = SELF, PM이 물었는데 SELF = PM(대표가 확정). 라우터 판정도 normalizeTarget이 같은 식으로 바꾼다.
function normalize(target: Target, askerRole: string): Target {
  if (askerRole === 'PM') return target === 'SELF' ? 'PM' : target;
  return target === askerRole ? 'SELF' : target;
}

const items: { id: string; stage: string; input: Record<string, unknown>; accept: Target[]; source: 'real-run' }[] = [];
const missing: string[] = [];
for (const it of board) {
  const gold = labels.get(it.id);
  if (!gold) {
    missing.push(it.id);
    continue;
  }
  // 옛 내보내기(최영현 묶음 100)는 입력에 stage·askerRole·roles가 없다 — 문항 바깥의 값으로 채운다. roles는 나머지 200문항이 모두 FE·BE다.
  const input: Record<string, unknown> = { stage: it.stage, askerRole: it.askerRole, roles: ['FRONTEND', 'BACKEND'], ...it.input };
  // 같은 내보내기의 구현 단계 4문항은 task.kind·contract.featureKey도 없다 — 구현 단계 태스크는 IMPLEMENT, 계약의 기능은 그 문항 명세의 기능이다.
  const task = input.task as { title: string; kind?: string } | null;
  if (task && !task.kind) input.task = { ...task, kind: 'IMPLEMENT' };
  const contract = input.contract as { featureKey?: string; summary: string | null } | null | undefined;
  const spec = input.spec as { featureKey: string } | null;
  if (contract && !contract.featureKey && spec) input.contract = { ...contract, featureKey: spec.featureKey };
  items.push({ id: it.id, stage: it.stage, input, accept: [normalize(gold, it.askerRole)], source: 'real-run' as const });
}
if (missing.length > 0) console.log(`정답이 없어 뺀 문항 ${missing.length}개: ${missing.slice(0, 5).join(', ')}`);
for (const id of devInclude) if (!items.some((i) => i.id === id)) throw new Error(`--dev-include의 ${id}가 데이터셋에 없다`);

// 결정적 섞기 — 같은 seed면 같은 순서(sha256(seed:id) 순).
const order = (id: string) => createHash('sha256').update(`${seed}:${id}`).digest('hex');

// 단계별 dev 몫: 비율대로 내림한 뒤 남는 자리를 소수점이 큰 단계부터 준다(최대 나머지 방식).
const stages = [...new Set(items.map((i) => i.stage))].sort();
const quotas = stages.map((stage) => {
  const n = items.filter((i) => i.stage === stage).length;
  const exact = (n / items.length) * devSize;
  return { stage, n, take: Math.floor(exact), rest: exact - Math.floor(exact) };
});
let left = devSize - quotas.reduce((a, q) => a + q.take, 0);
for (const q of [...quotas].sort((a, b) => b.rest - a.rest || a.stage.localeCompare(b.stage))) {
  if (left <= 0) break;
  q.take += 1;
  left -= 1;
}

const dev: string[] = [];
for (const q of quotas) {
  const inStage = items.filter((i) => i.stage === q.stage);
  const forced = inStage.filter((i) => devInclude.includes(i.id)).map((i) => i.id);
  if (forced.length > q.take) throw new Error(`${q.stage}: --dev-include가 그 단계 몫(${q.take})보다 많다`);
  const rest = inStage.filter((i) => !devInclude.includes(i.id)).sort((a, b) => order(a.id).localeCompare(order(b.id)));
  dev.push(...forced, ...rest.slice(0, q.take - forced.length).map((i) => i.id));
}
const devSet = new Set(dev);
const test = items.filter((i) => !devSet.has(i.id)).map((i) => i.id);

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'dataset.json'), JSON.stringify({ version: `team-rules:${seed}`, items }, null, 2));
writeFileSync(path.join(outDir, 'dev-ids.json'), JSON.stringify({ seed, devInclude, ids: dev }, null, 2));
writeFileSync(path.join(outDir, 'test-ids.json'), JSON.stringify({ seed, ids: test }, null, 2));

const byStage = (ids: string[]) => Object.fromEntries(stages.map((s) => [s, ids.filter((id) => items.find((i) => i.id === id)!.stage === s).length]));
console.log(`문항 ${items.length} → dev ${dev.length} ${JSON.stringify(byStage(dev))} / test ${test.length} ${JSON.stringify(byStage(test))}`);
console.log(`저장: ${path.relative(process.cwd(), outDir)}/{dataset,dev-ids,test-ids}.json`);
