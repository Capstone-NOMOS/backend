import { z } from 'zod';
import type { NomosApi } from './nomos-http.js';

// 질문 모으기 반복 실행(033) — 기능 명세·계약을 확정한 **실험 모드** 프로젝트에 같은 태스크 묶음을 회차마다 새로 넣어
// 에이전트가 같은 일을 N번 하게 하고, 그때마다 나온 질문을 모은다. 실험 모드는 질문에 첫 선택지로 바로 답하므로 사람 없이 돈다.
//
// 왜 회차를 새 태스크로 만드나: 같은 태스크를 다시 돌리는 길(재개)은 재시도·반려 지표를 섞는다. 새 태스크는 처음부터 같은 조건이다.
// 왜 끝난 회차를 취소하나: 멈춘(BLOCKED·ESCALATED) 태스크가 남으면 G3("모든 태스크 끝")가 영원히 오지 않고 화면에 쌓인다.
// DONE은 그대로 둔다(끝난 일이다). 승인 대기(AWAITING_APPROVAL)는 취소할 수 없어 그대로 두고 알린다 — 질문은 이미 다 나왔다.
//
// 중복 방지는 제목 꼬리표 `[harvest <run> r<n>]`다 — 서버는 같은 제목을 거부하고, 같은 --run으로 다시 돌리면
// 이미 만든 회차는 건너뛰고 이어 간다(중간에 끊겨도 처음부터 다시 만들지 않는다).
//
// 서버 판정을 흉내 내지 않는다 — 상태·질문·라우팅은 전부 API로 읽는다(routing-dataset·routing-report).

export const harvestFileSchema = z
  .object({
    tasks: z
      .array(
        z
          .object({
            // 같은 회차 안의 선행(dependsOn)을 가리키는 이름. 없으면 제목.
            ref: z.string().trim().min(1).max(64).optional(),
            title: z.string().trim().min(1).max(150),
            teamRole: z.enum(['FRONTEND', 'BACKEND']),
            kind: z.enum(['IMPLEMENT', 'INTEGRATION', 'REWORK']).default('IMPLEMENT'),
            // 프로젝트 레포 — fullName(owner/name) 또는 id.
            repo: z.string().trim().min(1),
            // 확정한 기능 명세의 키. IMPLEMENT는 필수(서버 규칙과 같다).
            featureKey: z.string().trim().min(1).max(32).nullable().default(null),
            dependsOn: z.array(z.string().trim().min(1)).max(20).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(40),
  })
  .strict();
export type HarvestFile = z.infer<typeof harvestFileSchema>;
export type HarvestTaskDef = HarvestFile['tasks'][number];

const TAG = /\s*\[harvest ([A-Za-z0-9-]+) r(\d+)\]$/;

export function roundTitle(title: string, run: string, round: number): string {
  return `${title} [harvest ${run} r${round}]`;
}

// 꼬리표를 떼어 낸 원래 제목과 회차. 꼬리표가 없으면 null.
export function parseRoundTitle(title: string): { base: string; run: string; round: number } | null {
  const m = TAG.exec(title);
  if (!m) return null;
  return { base: title.slice(0, m.index), run: m[1]!, round: Number(m[2]) };
}

export function newRunId(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `h${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
}

export const RUN_ID = /^[A-Za-z0-9-]{1,24}$/;

// ── 서버 응답 모양(쓰는 필드만) ──

type ProjectDetail = {
  project: { id: string; name: string; status: string; questionRelay: boolean; questionMode?: string };
  repos: { id: string; fullName: string }[];
  members: { teamRole: string; agentId: string | null }[];
};
type SpecRow = { id: string; featureKey: string; needsApi: boolean };
type ContractRow = { featureKey: string; status: string };
export type TaskRow = { id: string; title: string; state: string; blockedReason: string | null; teamRole: string | null };

export type HarvestIo = { log(line?: string): void; sleep(ms: number): Promise<void> };

export type HarvestOptions = {
  projectId: string;
  file: HarvestFile;
  repeat: number;
  run: string;
  dryRun: boolean;
  pollMs: number;
  roundTimeoutMs: number;
};

// 회차가 끝났다고 보는 상태. BLOCKED는 질문 대기(QUESTION)가 아닐 때만 — 실험 모드 자동 답 사이의 잠깐이다.
export function isSettled(t: TaskRow): boolean {
  if (t.state === 'BLOCKED') return t.blockedReason !== 'QUESTION';
  return ['DONE', 'ESCALATED', 'CANCELLED', 'AWAITING_APPROVAL'].includes(t.state);
}
const CANCELLABLE = new Set(['BLOCKED', 'ESCALATED', 'READY']);

type Prepared = {
  repoIdOf: Map<string, string>;
  specIdOf: Map<string, string>;
};

// 실행 전 확인 — 하나라도 어긋나면 아무것도 만들지 않는다. 위반은 전부 모아 한 번에 알린다.
export async function preflight(api: NomosApi, opts: HarvestOptions): Promise<{ detail: ProjectDetail; prepared: Prepared; problems: string[] }> {
  const detail = await api.call<ProjectDetail>('GET', `/projects/${opts.projectId}`);
  const problems: string[] = [];
  const p = detail.project;
  if (p.questionMode !== 'experiment') {
    problems.push(`실험 모드가 아니다(questionMode=${p.questionMode ?? '없음 — 서버가 033 전'}). 질문에 사람이 답해야 해 반복 실행이 멈춘다 — 시작 전에 PATCH /projects/:id/settings { questionMode: 'experiment' }`);
  }
  if (!p.questionRelay) problems.push('질문 중계가 꺼져 있다(questionRelay=false) — 에이전트가 질문하지 않는다');
  if (!['planning', 'active'].includes(p.status)) problems.push(`프로젝트 상태가 ${p.status}라 태스크를 만들 수 없다(planning·active만)`);

  const specs = (await api.call<{ specs: SpecRow[] }>('GET', `/projects/${opts.projectId}/specs`)).specs;
  const contracts = (await api.call<{ contracts: ContractRow[] }>('GET', `/projects/${opts.projectId}/contracts`)).contracts;
  const repoIdOf = new Map<string, string>();
  const specIdOf = new Map<string, string>();
  const refs = new Set(opts.file.tasks.map((t) => t.ref ?? t.title));
  const roles = new Set<string>();
  opts.file.tasks.forEach((t, i) => {
    const where = `tasks[${i}] ${t.title}`;
    roles.add(t.teamRole);
    const repo = detail.repos.find((r) => r.id === t.repo || r.fullName.toLowerCase() === t.repo.toLowerCase());
    if (!repo) problems.push(`${where}: 레포 ${t.repo}는 이 프로젝트의 레포가 아니다(${detail.repos.map((r) => r.fullName).join(', ') || '없음'})`);
    else repoIdOf.set(t.repo, repo.id);
    if (t.featureKey === null) {
      if (t.kind === 'IMPLEMENT') problems.push(`${where}: IMPLEMENT는 featureKey가 필요하다`);
    } else {
      const spec = specs.find((s) => s.featureKey === t.featureKey);
      if (!spec) problems.push(`${where}: 기능 명세 ${t.featureKey}가 없다 — 기능 명세를 먼저 확정한다`);
      else {
        specIdOf.set(t.featureKey, spec.id);
        const contract = contracts.find((c) => c.featureKey === t.featureKey);
        if (spec.needsApi && contract?.status !== 'approved') {
          problems.push(`${where}: ${t.featureKey}의 API 계약이 확정되지 않았다(${contract?.status ?? '없음'}) — 계약 없이 시작하면 FE·BE가 서로 다른 API를 짐작한다`);
        }
      }
    }
    for (const d of t.dependsOn) if (!refs.has(d)) problems.push(`${where}: dependsOn ${d}는 파일에 없는 ref다`);
    const earlier = new Set(opts.file.tasks.slice(0, i).map((x) => x.ref ?? x.title));
    for (const d of t.dependsOn) if (refs.has(d) && !earlier.has(d)) problems.push(`${where}: dependsOn ${d}는 이 태스크보다 앞에 적는다`);
  });
  for (const role of roles) {
    const m = detail.members.find((x) => x.teamRole === role);
    if (!m) problems.push(`${role} 담당이 배정되지 않았다`);
  }
  if (new Set(opts.file.tasks.map((t) => t.title)).size !== opts.file.tasks.length) problems.push('같은 제목의 태스크가 두 번 있다');
  return { detail, prepared: { repoIdOf, specIdOf }, problems };
}

export async function listTasks(api: NomosApi, projectId: string): Promise<TaskRow[]> {
  return (await api.call<{ tasks: TaskRow[] }>('GET', `/projects/${projectId}/tasks?limit=200`)).tasks;
}

function roundTasks(tasks: TaskRow[], run: string, round: number): TaskRow[] {
  return tasks.filter((t) => {
    const tag = parseRoundTitle(t.title);
    return tag?.run === run && tag.round === round;
  });
}

// 한 회차 만들기 — 이미 있는 제목은 건너뛴다(같은 --run으로 다시 돌린 경우).
async function createRound(api: NomosApi, opts: HarvestOptions, prepared: Prepared, round: number, existing: TaskRow[], io: HarvestIo): Promise<void> {
  const idOfRef = new Map<string, string>();
  for (const t of opts.file.tasks) {
    const title = roundTitle(t.title, opts.run, round);
    const found = existing.find((x) => x.title === title);
    if (found) {
      idOfRef.set(t.ref ?? t.title, found.id);
      continue;
    }
    const body = {
      title,
      teamRole: t.teamRole,
      kind: t.kind,
      repoId: prepared.repoIdOf.get(t.repo)!,
      specId: t.featureKey === null ? null : prepared.specIdOf.get(t.featureKey)!,
      dependsOn: t.dependsOn.map((d) => idOfRef.get(d)!),
    };
    const created = await api.call<{ id: string }>('POST', `/projects/${opts.projectId}/tasks`, body);
    idOfRef.set(t.ref ?? t.title, created.id);
    io.log(`  만듦 ${created.id} ${title}`);
  }
}

// 회차가 끝날 때까지 기다린다 — 시간이 넘으면 멈추고 남은 것을 알린다(같은 --run으로 이어 간다).
async function waitRound(api: NomosApi, opts: HarvestOptions, round: number, io: HarvestIo): Promise<TaskRow[]> {
  let waited = 0;
  for (;;) {
    const mine = roundTasks(await listTasks(api, opts.projectId), opts.run, round);
    const open = mine.filter((t) => !isSettled(t));
    if (open.length === 0) return mine;
    if (waited >= opts.roundTimeoutMs) {
      throw new Error(
        `r${round}이 ${Math.round(opts.roundTimeoutMs / 60000)}분 안에 끝나지 않았다: ${open.map((t) => `${t.title}(${t.state})`).join(', ')}. ` +
          `에이전트 연결을 확인하고 같은 --run ${opts.run}으로 다시 실행하면 이어 간다`,
      );
    }
    await io.sleep(opts.pollMs);
    waited += opts.pollMs;
  }
}

async function closeRound(api: NomosApi, tasks: TaskRow[], round: number, io: HarvestIo): Promise<void> {
  for (const t of tasks) {
    if (CANCELLABLE.has(t.state)) {
      await api.call('POST', `/tasks/${t.id}/cancel`, { reason: `질문 모으기 r${round} 정리 — 다음 회차를 새로 만든다` });
      io.log(`  취소 ${t.title} (${t.state})`);
    } else if (t.state === 'AWAITING_APPROVAL') {
      io.log(`  ! ${t.title}는 승인 대기라 취소할 수 없어 그대로 둔다(대표가 승인·반려하면 정리된다)`);
    }
  }
}

export async function runHarvest(api: NomosApi, opts: HarvestOptions, io: HarvestIo): Promise<void> {
  const { detail, prepared, problems } = await preflight(api, opts);
  io.log(`프로젝트: ${detail.project.name} (${detail.project.status}, 질문 모드 ${detail.project.questionMode ?? '?'})`);
  io.log(`실행 이름: ${opts.run} — 끊기면 --run ${opts.run}으로 이어 간다`);
  if (problems.length > 0) throw new Error(`시작할 수 없다:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  for (const m of detail.members) if (!m.agentId) io.log(`  ! ${m.teamRole} 담당의 에이전트가 연결돼 있지 않다 — 그 노트북에서 connect`);

  if (opts.dryRun) {
    for (let round = 1; round <= opts.repeat; round += 1) {
      io.log(`r${round}:`);
      for (const t of opts.file.tasks) {
        io.log(`  ${roundTitle(t.title, opts.run, round)} · ${t.teamRole} · ${t.repo}${t.featureKey ? ` · ${t.featureKey}` : ''}${t.dependsOn.length ? ` · 선행 ${t.dependsOn.join(', ')}` : ''}`);
      }
    }
    io.log('--dry-run: 아무것도 만들지 않았다');
    return;
  }
  if (detail.project.status === 'planning') io.log('  ! 프로젝트가 시작 전이다 — 웹에서 시작해야 에이전트가 가져간다');

  for (let round = 1; round <= opts.repeat; round += 1) {
    const all = await listTasks(api, opts.projectId);
    const existing = roundTasks(all, opts.run, round);
    // 이미 끝내고 정리한 회차(전부 DONE·CANCELLED)는 다시 만들지 않는다.
    if (existing.length === opts.file.tasks.length && existing.every((t) => t.state === 'DONE' || t.state === 'CANCELLED')) {
      io.log(`r${round}: 이미 끝났다 — 건너뜀`);
      continue;
    }
    io.log(`r${round}/${opts.repeat}:`);
    await createRound(api, opts, prepared, round, existing, io);
    const settled = await waitRound(api, opts, round, io);
    io.log(`  끝: ${settled.map((t) => `${parseRoundTitle(t.title)?.base ?? t.title}=${t.state}`).join(', ')}`);
    await closeRound(api, settled, round, io);
  }
  io.log(`다 돌았다 — npm run harvest:questions -- --project ${opts.projectId} --report --run ${opts.run}`);
}

// ── 보고(--report) ──

type DatasetItem = {
  id: string;
  stage: string;
  input: { task: { title: string } | null; questions: unknown[] };
  primary: { router: string; target: string };
  answerSource: string | null;
};
type ReportRow = { questionId: string; decisions: Record<string, string | null> };

export type HarvestReport = {
  questions: number;
  byStage: Record<string, number>;
  rounds: { round: number; tasks: number; tasksWithQuestions: number; questions: number }[];
  perTask: { title: string; rounds: number; roundsWithQuestions: number; questions: number }[];
  routers: Record<string, Record<string, number>>;
};

// run이 있으면 그 실행의 회차만, 없으면 꼬리표가 붙은 모든 실행을 회차 번호로 묶는다(기획 단계 질문은 회차가 없어 단계별 수에만 든다).
export function buildHarvestReport(input: { dataset: DatasetItem[]; report: { rows: ReportRow[] }; tasks: TaskRow[]; run: string | null }): HarvestReport {
  const byStage: Record<string, number> = {};
  for (const item of input.dataset) byStage[item.stage] = (byStage[item.stage] ?? 0) + 1;

  const inRun = (title: string) => {
    const tag = parseRoundTitle(title);
    return tag && (input.run === null || tag.run === input.run) ? tag : null;
  };
  const roundTasks = input.tasks.map((t) => ({ t, tag: inRun(t.title) })).filter((x) => x.tag !== null);
  // 질문 → 태스크(제목으로 — 데이터셋 입력에는 라우터가 본 태스크 제목이 있다).
  const questionsByTitle = new Map<string, number>();
  for (const item of input.dataset) {
    const title = item.input.task?.title;
    if (title && inRun(title)) questionsByTitle.set(title, (questionsByTitle.get(title) ?? 0) + 1);
  }

  const rounds = new Map<number, { tasks: number; tasksWithQuestions: number; questions: number }>();
  const perTask = new Map<string, { rounds: number; roundsWithQuestions: number; questions: number }>();
  for (const { t, tag } of roundTasks) {
    const n = questionsByTitle.get(t.title) ?? 0;
    const r = rounds.get(tag!.round) ?? { tasks: 0, tasksWithQuestions: 0, questions: 0 };
    r.tasks += 1;
    r.questions += n;
    if (n > 0) r.tasksWithQuestions += 1;
    rounds.set(tag!.round, r);
    const p = perTask.get(tag!.base) ?? { rounds: 0, roundsWithQuestions: 0, questions: 0 };
    p.rounds += 1;
    p.questions += n;
    if (n > 0) p.roundsWithQuestions += 1;
    perTask.set(tag!.base, p);
  }

  const routers: Record<string, Record<string, number>> = {};
  const count = (router: string, target: string | null) => {
    const key = target ?? '(실패)';
    routers[router] = routers[router] ?? {};
    routers[router]![key] = (routers[router]![key] ?? 0) + 1;
  };
  const rowOf = new Map(input.report.rows.map((r) => [r.questionId, r]));
  for (const item of input.dataset) {
    const row = rowOf.get(item.id);
    if (row && Object.keys(row.decisions).length > 0) for (const [router, target] of Object.entries(row.decisions)) count(router, target);
    else count(item.primary.router, item.primary.target);
  }

  return {
    questions: input.dataset.length,
    byStage,
    rounds: [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([round, v]) => ({ round, ...v })),
    perTask: [...perTask.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([title, v]) => ({ title, ...v })),
    routers,
  };
}

const pct = (a: number, b: number) => (b === 0 ? '-' : `${Math.round((a / b) * 100)}%`);

export function formatHarvestReport(r: HarvestReport): string[] {
  const lines: string[] = [];
  lines.push(`질문 ${r.questions}건 (질문 행 기준 — 한 번에 여러 문장을 물으면 한 건)`);
  lines.push(`단계별: ${Object.entries(r.byStage).map(([s, n]) => `${s} ${n}`).join(' · ') || '없음'}`);
  lines.push('');
  lines.push('회차별 (태스크 / 질문한 태스크 = 발생률 / 질문 수 / 태스크당 질문)');
  for (const x of r.rounds) lines.push(`  r${x.round}: ${x.tasks} / ${x.tasksWithQuestions} = ${pct(x.tasksWithQuestions, x.tasks)} / ${x.questions} / ${(x.questions / Math.max(1, x.tasks)).toFixed(2)}`);
  lines.push('');
  lines.push('태스크별 (회차 / 질문한 회차 = 발생률 / 질문 수 / 회차당 질문)');
  for (const x of r.perTask) lines.push(`  ${x.title}: ${x.rounds} / ${x.roundsWithQuestions} = ${pct(x.roundsWithQuestions, x.rounds)} / ${x.questions} / ${(x.questions / Math.max(1, x.rounds)).toFixed(2)}`);
  lines.push('');
  lines.push('라우터별 판정 분포 (primary + shadow, 대상별 건수)');
  for (const [router, targets] of Object.entries(r.routers).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  ${router}: ${Object.entries(targets).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(' · ')}`);
  }
  return lines;
}

export async function harvestReport(api: NomosApi, projectId: string, run: string | null): Promise<HarvestReport> {
  const dataset = (await api.call<{ items: DatasetItem[] }>('GET', `/projects/${projectId}/routing-dataset`)).items;
  const report = await api.call<{ rows: ReportRow[] }>('GET', `/projects/${projectId}/routing-report`);
  const tasks = await listTasks(api, projectId);
  return buildHarvestReport({ dataset, report, tasks, run });
}
