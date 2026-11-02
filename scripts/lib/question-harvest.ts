// 질문 모으기(scripts/question-harvest.ts) — 빈칸을 심은 명세로 FE·BE 태스크를 만들어 에이전트가 실제로 막혀 묻게 한다.
// docs/experiment-question-routing.md "질문 발생률". question-probe와 달리 명세에 **누가 정하는지 쓰지 않는다** — 라우팅 정확도를 재기 위한 질문이라서다.
//
// 시나리오 파일의 plantedGaps(심은 빈칸과 예상 담당자)는 실험자 메모다 — 서버로 보내지 않는다(라우터·에이전트가 보면 안 된다).
// 결과 집계에서 "심은 빈칸 수"로만 쓴다. 이 파일은 서버 코드를 런타임 import하지 않는다(타입만).
import { z } from 'zod';
import { TEAM_ROLES, type TeamRole } from '../../src/domain/roles.js';

const ownerSchema = z.union([z.enum(TEAM_ROLES), z.literal('PM'), z.literal('SELF')]);

const featureSchema = z
  .object({
    featureKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/, '영문·숫자·-·_ 31자 이내'),
    title: z.string().trim().min(1).max(200),
    // 빈칸을 심은 명세 본문. "누가 정한다"를 쓰지 않는다.
    content: z.string().trim().min(1),
    plantedGaps: z.array(z.object({ note: z.string().trim().min(1), expectedOwner: ownerSchema })).default([]),
    tasks: z.array(z.object({ title: z.string().trim().min(1).max(160), teamRole: z.enum(TEAM_ROLES) })).min(1),
  })
  .strict();

export const harvestScenarioSchema = z
  .object({
    version: z.union([z.number(), z.string()]).optional(),
    note: z.string().optional(),
    features: z.array(featureSchema).min(1),
  })
  .strict();

export type HarvestScenario = z.infer<typeof harvestScenarioSchema>;
export type HarvestFeature = HarvestScenario['features'][number];

export function parseHarvestScenario(raw: unknown): HarvestScenario {
  const parsed = harvestScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`시나리오 형식 오류 (${problems.length}건)\n${problems.join('\n')}`);
  }
  const keys = new Set<string>();
  for (const f of parsed.data.features) {
    if (keys.has(f.featureKey)) throw new Error(`시나리오 형식 오류: featureKey ${f.featureKey}가 겹친다`);
    keys.add(f.featureKey);
  }
  return parsed.data;
}

// --only로 고른 기능. 없으면 전부.
export function pickFeatures(scenario: HarvestScenario, only: string | undefined): HarvestFeature[] {
  if (!only) return scenario.features;
  const wanted = only.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((k) => !scenario.features.some((f) => f.featureKey === k));
  if (unknown.length > 0) throw new Error(`시나리오에 없는 기능: ${unknown.join(', ')} (있는 것: ${scenario.features.map((f) => f.featureKey).join(', ')})`);
  return scenario.features.filter((f) => wanted.includes(f.featureKey));
}

// 같은 제목·같은 기능 키는 거부되므로(재실행 방지 규칙) 실행마다 꼬리표를 붙인다(question-probe와 같은 방식).
export function harvestStamp(now: Date = new Date()): string {
  return now.getTime().toString(36).slice(-6);
}

export function stampedFeatureKey(featureKey: string, stamp: string): string {
  return `${featureKey}-${stamp}`;
}

// 서버로 보낼 본문. 명세는 needsApi:false — 계약 단계를 건너뛴다(확정한 계약이 있으면 BE에게 물을 일이 사라진다).
// FE·BE 태스크를 같은 명세에 함께 만든다. plantedGaps·expectedOwner는 여기 들어가지 않는다.
export type HarvestRequest = {
  featureKey: string;
  spec: { featureKey: string; title: string; content: string; needsApi: false };
  tasks: { title: string; teamRole: TeamRole; kind: 'IMPLEMENT' }[];
};

export function buildHarvestRequests(features: HarvestFeature[], stamp: string): HarvestRequest[] {
  return features.map((f) => ({
    featureKey: f.featureKey,
    spec: { featureKey: stampedFeatureKey(f.featureKey, stamp), title: `${f.title} (${stamp})`, content: f.content, needsApi: false },
    tasks: f.tasks.map((t) => ({ title: `${t.title} (${stamp})`, teamRole: t.teamRole, kind: 'IMPLEMENT' })),
  }));
}

// --- 집계 ---
// 내보내기(GET /projects/:id/routing-dataset) 항목 중 이 시나리오의 기능(꼬리표가 붙은 키 포함)에서 나온 질문을 센다.
export type DatasetItemForReport = { id: string; input: { spec: { featureKey: string } | null; questions: unknown[]; askerRole: string }; primary?: { target: string } };

export type HarvestFeatureReport = {
  featureKey: string;
  plantedGaps: number;
  expectedOwners: Record<string, number>;
  questionRows: number; // AskUserQuestion 호출 수
  questions: number; // 질문 문장 수(한 호출에 여러 개일 수 있다)
  runs: number; // 이 기능이 몇 번 투입됐나(꼬리표 수)
  rate: string; // 질문 문장 수 ÷ (심은 빈칸 × 투입 횟수)
  byTarget: Record<string, number>; // 실제로 보낸 판정별
};

// specKeys: 그 프로젝트의 명세 기능 키(GET /projects/:id/specs) — 질문이 하나도 안 나온 투입도 분모에 넣으려고 센다.
export function harvestReport(scenario: HarvestScenario, items: DatasetItemForReport[], specKeys: string[]): HarvestFeatureReport[] {
  const belongs = (key: string | undefined, featureKey: string) => key === featureKey || (key !== undefined && key.startsWith(`${featureKey}-`));
  return scenario.features.map((f) => {
    const mine = items.filter((i) => belongs(i.input.spec?.featureKey, f.featureKey));
    const runs = new Set([...specKeys.filter((k) => belongs(k, f.featureKey)), ...mine.map((i) => i.input.spec!.featureKey)]).size;
    const questions = mine.reduce((n, i) => n + i.input.questions.length, 0);
    const expectedOwners: Record<string, number> = {};
    for (const g of f.plantedGaps) expectedOwners[g.expectedOwner] = (expectedOwners[g.expectedOwner] ?? 0) + 1;
    const byTarget: Record<string, number> = {};
    for (const i of mine) {
      const t = i.primary?.target ?? '?';
      byTarget[t] = (byTarget[t] ?? 0) + 1;
    }
    const denominator = f.plantedGaps.length * Math.max(runs, 1);
    return {
      featureKey: f.featureKey,
      plantedGaps: f.plantedGaps.length,
      expectedOwners,
      questionRows: mine.length,
      questions,
      runs,
      rate: denominator === 0 ? '-' : `${Math.round((100 * questions) / denominator)}%`,
      byTarget,
    };
  });
}
