// 질문 라우터 오프라인 평가 데이터셋 — 읽기·검사·실행(scripts/eval-question-router.ts).
// 서버 코드 중에서는 router.ts(타입)·roles.ts만 쓴다 — 서버 비밀값 없이 노트북에서 돈다.
//
// 형식이 둘이다(scripts/data/README-question-routing.md):
//   v2  항목마다 { id, input: RoutingInputSnapshot, accept, source?, difficulty?, note? } — 운영 라우터가 받는 입력과 같은 모양.
//       GET /projects/:id/routing-dataset 응답 파일({ data: { items } })을 그대로 읽는다.
//   v1  contexts(상황) + 항목이 context 이름을 참조(초기 20문항). 읽을 때 RoutingInputSnapshot으로 바꾼다(roles는 데이터셋 값, contract는 null).
// 평가는 항목의 input을 **그대로** 라우터에 넣는다 — 다시 조립하면 운영과 다른 입력으로 비교하게 된다.
import { z } from 'zod';
import type { RoutingInputSnapshot, RoutingTarget } from '../../src/domain/question/router.js';
import { TEAM_ROLES } from '../../src/domain/roles.js';
import type { EvalRouter } from './question-routers.js';

const roleSchema = z.enum(TEAM_ROLES);
// PM(025) = 요구사항·정책 — 대표가 운용하는 PM 에이전트. SELF = 묻는 쪽 자기 소관.
export const targetSchema = z.union([roleSchema, z.literal('PM'), z.literal('SELF')]);
export const SOURCES = ['real-run', 'real-transcript', 'transplanted', 'human', 'llm'] as const;
export const DIFFICULTIES = ['clear', 'ambiguous', 'trap'] as const;

// --- v1 ---
const contextSchema = z.object({
  askerRole: roleSchema,
  task: z.object({ title: z.string().min(1), kind: z.string().default('IMPLEMENT') }),
  repo: z.object({ fullName: z.string().min(1) }).nullable().default(null),
  spec: z.object({ featureKey: z.string(), title: z.string(), content: z.string() }).nullable().default(null),
});
const v1ItemSchema = z
  .object({
    id: z.string().min(1),
    context: z.string().min(1),
    // 질문 하나면 question, 한 번의 AskUserQuestion에 여러 개였으면 questions(라우터는 묶음 전체에 한 역할을 고른다).
    question: z.string().min(1).optional(),
    questions: z.array(z.string().min(1)).min(1).max(4).optional(),
    accept: z.array(targetSchema).min(1),
    source: z.string().default('unknown'),
    labeledBy: z.string().optional(),
    note: z.string().optional(),
  })
  .refine((i) => (i.question === undefined) !== (i.questions === undefined), { message: 'question과 questions 중 하나만 쓴다' });
const v1Schema = z.object({
  version: z.union([z.number(), z.string()]),
  roles: z.array(roleSchema).min(2).default([...TEAM_ROLES]),
  contexts: z.record(contextSchema),
  items: z.array(v1ItemSchema).min(1),
});

// --- v2 ---
const askedQuestionSchema = z
  .object({ question: z.string().min(1), options: z.array(z.object({ label: z.string() }).passthrough()).default([]) })
  .passthrough();
export const routingInputSchema = z.object({
  askerRole: roleSchema,
  roles: z.array(roleSchema).min(1),
  task: z.object({ title: z.string().min(1), kind: z.string().min(1) }),
  spec: z.object({ featureKey: z.string(), title: z.string(), content: z.string() }).nullable(),
  repo: z.object({ fullName: z.string().min(1) }).nullable(),
  questions: z.array(askedQuestionSchema).min(1).max(4),
  contract: z.object({ featureKey: z.string(), summary: z.string().nullable() }).nullable().optional(),
});
const v2ItemSchema = z
  .object({
    id: z.string().min(1),
    input: routingInputSchema,
    // 내보낸 질문 중 정답 라벨이 아직 없는 것은 빈 배열이다 — 평가에서 건너뛴다.
    accept: z.array(targetSchema),
    source: z.enum(SOURCES).optional(),
    difficulty: z.enum(DIFFICULTIES).optional(),
    note: z.string().optional(),
  })
  .passthrough();
const v2Schema = z.object({ version: z.union([z.number(), z.string()]).optional(), items: z.array(v2ItemSchema).min(1) });

export type EvalItem = {
  id: string;
  input: RoutingInputSnapshot;
  accept: RoutingTarget[];
  source: string;
  difficulty: string | null;
  note: string | null;
};

export type LoadedDataset = { format: 'v1' | 'v2'; version: string | number; items: EvalItem[]; unlabeled: string[] };

function formatProblems(issues: z.ZodIssue[]): string {
  return issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

// 파일 내용(JSON 값)을 읽어 평가 항목으로 바꾼다. 형식이 틀리면 위반을 전부 모아 던진다.
export function parseDataset(raw: unknown): LoadedDataset {
  // 내보내기 응답({ data: { items } })을 그대로 받는다.
  const body = typeof raw === 'object' && raw !== null && 'data' in raw && !('items' in raw) ? (raw as { data: unknown }).data : raw;
  const isV1 = typeof body === 'object' && body !== null && 'contexts' in body;
  if (isV1) {
    const parsed = v1Schema.safeParse(body);
    if (!parsed.success) throw new Error(`데이터셋 형식 오류 (${parsed.error.issues.length}건)\n${formatProblems(parsed.error.issues)}`);
    const data = parsed.data;
    const problems: string[] = [];
    const items: EvalItem[] = [];
    for (const item of data.items) {
      const ctx = data.contexts[item.context];
      if (!ctx) {
        problems.push(`  - items.${item.id}: 없는 context "${item.context}"`);
        continue;
      }
      const texts = item.questions ?? [item.question!];
      items.push({
        id: item.id,
        input: {
          askerRole: ctx.askerRole,
          roles: data.roles,
          task: ctx.task,
          spec: ctx.spec,
          repo: ctx.repo,
          questions: texts.map((question) => ({ question, options: [] })),
          contract: null,
        },
        accept: item.accept,
        source: item.source,
        difficulty: null,
        note: item.note ?? null,
      });
    }
    problems.push(...duplicateIds(items));
    if (problems.length) throw new Error(`데이터셋 형식 오류 (${problems.length}건)\n${problems.join('\n')}`);
    return { format: 'v1', version: data.version, items, unlabeled: [] };
  }

  const parsed = v2Schema.safeParse(body);
  if (!parsed.success) throw new Error(`데이터셋 형식 오류 (${parsed.error.issues.length}건)\n${formatProblems(parsed.error.issues)}`);
  const problems = duplicateIds(parsed.data.items);
  if (problems.length) throw new Error(`데이터셋 형식 오류 (${problems.length}건)\n${problems.join('\n')}`);
  const items: EvalItem[] = [];
  const unlabeled: string[] = [];
  for (const item of parsed.data.items) {
    if (item.accept.length === 0) {
      unlabeled.push(item.id);
      continue;
    }
    items.push({
      id: item.id,
      input: item.input as RoutingInputSnapshot,
      accept: item.accept,
      source: item.source ?? 'unknown',
      difficulty: item.difficulty ?? null,
      note: item.note ?? null,
    });
  }
  return { format: 'v2', version: parsed.data.version ?? 2, items, unlabeled };
}

function duplicateIds(items: { id: string }[]): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const { id } of items) {
    if (seen.has(id)) problems.push(`  - items.${id}: id가 겹친다`);
    seen.add(id);
  }
  return problems;
}

// --- 실행 ---
export type EvalRow = {
  id: string;
  run: number;
  accept: RoutingTarget[];
  source: string;
  target: RoutingTarget | 'ERROR';
  ok: boolean;
  confidence: number | null;
  reason: string | null;
  ms: number;
  costUsd: number | null;
  error?: string;
};

export async function runEvaluation(items: EvalItem[], router: EvalRouter, options: { repeat: number; concurrency: number; onProgress?: () => void }): Promise<EvalRow[]> {
  const jobs = items.flatMap((item) => Array.from({ length: options.repeat }, (_, run) => ({ item, run })));
  const rows: EvalRow[] = [];
  const worker = async (): Promise<void> => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const { item, run } = job;
      const started = Date.now();
      try {
        // 저장된 입력을 그대로 넣는다(다시 조립하지 않는다).
        const d = await router.routeWithCost(item.input);
        rows.push({ id: item.id, run, accept: item.accept, source: item.source, target: d.target, ok: item.accept.includes(d.target), confidence: d.confidence, reason: d.reason, ms: Date.now() - started, costUsd: d.costUsd });
      } catch (err) {
        rows.push({ id: item.id, run, accept: item.accept, source: item.source, target: 'ERROR', ok: false, confidence: null, reason: null, ms: Date.now() - started, costUsd: null, error: err instanceof Error ? err.message : String(err) });
      }
      options.onProgress?.();
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));
  return rows.sort((a, b) => a.id.localeCompare(b.id) || a.run - b.run);
}

const pct = (n: number, d: number) => (d === 0 ? '-' : `${Math.round((100 * n) / d)}%`);

export function summarize(rows: EvalRow[], items: EvalItem[], repeat: number) {
  const selfOnly = rows.filter((r) => r.accept.length === 1 && r.accept[0] === 'SELF');
  const notSelf = rows.filter((r) => !r.accept.includes('SELF'));
  const costs = rows.map((r) => r.costUsd).filter((c): c is number => c !== null);
  // 출처별 정확도 — LLM이 만든 문항은 LLM 라우터가 잘 맞혀 점수가 부풀 수 있어 따로 본다.
  const bySource: Record<string, { runs: number; accuracy: string }> = {};
  for (const source of [...new Set(rows.map((r) => r.source))].sort()) {
    const rs = rows.filter((r) => r.source === source);
    bySource[source] = { runs: rs.length, accuracy: pct(rs.filter((r) => r.ok).length, rs.length) };
  }
  return {
    runs: rows.length,
    accuracy: pct(rows.filter((r) => r.ok).length, rows.length),
    selfRecall: pct(selfOnly.filter((r) => r.target === 'SELF').length, selfOnly.length),
    wronglyKept: pct(notSelf.filter((r) => r.target === 'SELF').length, notSelf.length),
    bySource,
    // 같은 문항을 여러 번 돌렸을 때 판정이 갈린 문항 수(--repeat 2 이상에서 의미가 있다)
    unstable: repeat > 1 ? items.filter((i) => new Set(rows.filter((r) => r.id === i.id).map((r) => r.target)).size > 1).length : null,
    errors: rows.filter((r) => r.target === 'ERROR').length,
    avgMs: rows.length ? Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length) : 0,
    totalCostUsd: costs.length ? +costs.reduce((s, c) => s + c, 0).toFixed(4) : null,
  };
}
