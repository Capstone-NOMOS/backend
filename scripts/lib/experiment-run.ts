import { z } from 'zod';
import type { NomosApi } from './nomos-http.js';

// 무인 실험 감독(034) — scripts/experiment-run.ts가 쓴다. question-harvest(033)의 반복 로직을 흡수했다.
//
// 서버(실험 모드)가 사람 결정 지점을 자동으로 통과시키므로 감독은 "요청 → 기다림 → 정리 → 다음 회차"만 한다:
//   요구사항마다 기능 명세 요청(POST /pm/features) → 서버가 질문·자동 답·재작성·적용·계약·태스크 나누기까지 진행 → 시작 전이면 시작 →
//   그 태스크가 끝나기를 기다린다(r1) → 회차마다 같은 태스크 묶음을 [exp <run> r<n>] 꼬리표로 다시 만들어 돌린다.
// 태스크 정리: BLOCKED(AGENT_STOPPED) → 재개 1회, 또 멈추면 취소 / ESCALATED → 취소 / 회차 시간 초과 → 취소할 수 있는 것은 취소하고 다음 회차.
// 승인 대기(AWAITING_APPROVAL)는 서버가 자동 승인하므로 기다리기만 한다. G3는 서버도 감독도 건드리지 않는다.
//
// 자동으로 풀 수 없는 것은 **멈추고 알린다**(HaltError — 원인과 사람이 할 일 한 줄, 종료 코드 3):
//   같은 실패 K번 연속 · 역할 에이전트 offline · PM 워커 offline · PM 예산 소진 · READY 태스크를 아무도 안 가져감 · 계약 포기(태스크 나누기가 막힌다).
// 진행 상태는 상태 파일(scripts/data/experiment-runs/<run>.json, 커밋하지 않음)에 남겨 같은 --run으로 다시 실행하면 이어서 돈다.
// 서버 판정을 흉내 내지 않는다 — 상태는 전부 API로 읽는다.

export const requirementsSchema = z
  .array(
    z
      .object({
        key: z.string().trim().regex(/^[A-Za-z0-9_-]{1,32}$/, '영문·숫자·_·- 32자 이내'),
        // 대표가 PM에게 하듯 자연어 요구.
        instruction: z.string().trim().min(1).max(4000),
        // 이 요구사항만 회차 수를 따로 정할 때(없으면 --repeat).
        repeat: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(20)
  .refine((items) => new Set(items.map((i) => i.key)).size === items.length, '같은 key가 두 번 있다');
export type Requirement = z.infer<typeof requirementsSchema>[number];

export const RUN_ID = /^[A-Za-z0-9-]{1,24}$/;

export function newRunId(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `e${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
}

const TAG = /\s*\[exp ([A-Za-z0-9-]+) r(\d+)\]$/;
export function roundTitle(title: string, run: string, round: number): string {
  return round === 1 ? title : `${title} [exp ${run} r${round}]`;
}
export function parseRoundTitle(title: string): { base: string; run: string; round: number } | null {
  const m = TAG.exec(title);
  return m ? { base: title.slice(0, m.index), run: m[1]!, round: Number(m[2]) } : null;
}

// ── 상태 파일 ──

export type TaskTemplate = { title: string; teamRole: string | null; kind: string; repoId: string; specId: string | null; dependsOn: string[] };
export type RoundState = { taskIds: string[]; done: boolean; timedOut?: boolean };
export type RequirementState = {
  status: 'pending' | 'planning' | 'running' | 'done' | 'skipped';
  rootPlanId?: string;
  featureKeys?: string[];
  template?: TaskTemplate[];
  rounds: Record<string, RoundState>;
  skipReason?: string;
};
export type RunState = {
  run: string;
  projectId: string;
  requirements: Record<string, RequirementState>;
  counters: { resumed: number; cancelled: number; timedOutRounds: number; skippedRequirements: number };
  resumedTaskIds: string[];
};

export function emptyState(run: string, projectId: string): RunState {
  return { run, projectId, requirements: {}, counters: { resumed: 0, cancelled: 0, timedOutRounds: 0, skippedRequirements: 0 }, resumedTaskIds: [] };
}

export type StateStore = { load(): Promise<RunState | null>; save(state: RunState): Promise<void> };

// ── 서버 응답(쓰는 필드만) ──

type ProjectDetail = {
  project: { id: string; name: string; status: string; questionRelay: boolean; questionMode?: string };
  members: { teamRole: string; agentId: string | null }[];
};
type PlanJson = {
  id: string;
  kind: 'feature' | 'tasks';
  status: string;
  parentPlanId: string | null;
  revisionCause: string | null;
  createdAt: string;
  error: { reason: string } | null;
  draft: { tasks?: { ref: string; title: string; spec: string | null; dependsOn: string[] }[] } | null;
  featureDraft: { features: { featureKey: string; needsApi: boolean }[] } | null;
};
type TaskJson = { id: string; title: string; state: string; blockedReason: string | null; teamRole: string | null; kind: string; repoId: string; specId: string | null };
type ContractJson = { featureKey: string; status: string };
type PmStatusJson = { ready: boolean; reason: string | null; budgetUsd: number; spentUsd: number; pendingPlanId: string | null };
type RoomJson = { role: string; agent: { online: boolean } | null };

export class HaltError extends Error {}

export type SupervisorIo = {
  log(line?: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
};

export type SupervisorOptions = {
  projectId: string;
  requirements: Requirement[];
  repeat: number;
  run: string;
  dryRun: boolean;
  pollMs: number;
  roundTimeoutMs: number;
  planningTimeoutMs: number;
  offlineMs: number;
  unclaimedMs: number;
  failureLimit: number;
};

export const DEFAULTS = {
  pollMs: 30_000,
  roundTimeoutMs: 90 * 60_000,
  planningTimeoutMs: 120 * 60_000,
  offlineMs: 10 * 60_000,
  unclaimedMs: 15 * 60_000,
  failureLimit: 3,
};

const FINISHED = new Set(['DONE', 'CANCELLED']);
const CANCELLABLE = new Set(['READY', 'BLOCKED', 'ESCALATED']);
const IN_FLIGHT = new Set(['CLAIMED', 'IN_PROGRESS', 'VERIFYING', 'AWAITING_APPROVAL']);

// 고장 감지 — 감독이 한 번 확인할 때마다 부른다. 자동으로 풀 수 없으면 HaltError(사람이 할 일 한 줄).
export class HealthMonitor {
  private offlineSince = new Map<string, number>();
  private workerOfflineSince: number | null = null;
  private readySince = new Map<string, number>();
  private lastFailure: { key: string; count: number } | null = null;

  constructor(
    private readonly api: NomosApi,
    private readonly opts: Pick<SupervisorOptions, 'projectId' | 'offlineMs' | 'unclaimedMs' | 'failureLimit'>,
    private readonly io: SupervisorIo,
  ) {}

  // 같은 실패가 연속 K번이면 멈춘다. 성공(태스크 DONE·초안 적용)이 오면 센 것을 비운다.
  failure(key: string, advice: string): void {
    this.lastFailure = this.lastFailure?.key === key ? { key, count: this.lastFailure.count + 1 } : { key, count: 1 };
    if (this.lastFailure.count >= this.opts.failureLimit) {
      throw new HaltError(`같은 실패(${key})가 연속 ${this.lastFailure.count}번 났다 — ${advice}`);
    }
  }

  success(): void {
    this.lastFailure = null;
  }

  async check(tasks: TaskJson[], projectStatus: string): Promise<void> {
    const now = this.io.now();
    const [status, rooms] = await Promise.all([
      this.api.call<PmStatusJson>('GET', `/projects/${this.opts.projectId}/pm/status`),
      this.api.call<{ rooms: RoomJson[] }>('GET', `/projects/${this.opts.projectId}/rooms`),
    ]);
    if (status.spentUsd >= status.budgetUsd) {
      throw new HaltError(`PM 예산이 다 떨어졌다($${status.spentUsd.toFixed(2)} / $${status.budgetUsd}) — 대표가 프로젝트 PM 예산을 늘린 뒤 같은 명령을 다시 실행`);
    }
    if (status.reason === 'WORKER_OFFLINE') {
      this.workerOfflineSince ??= now;
      if (now - this.workerOfflineSince >= this.opts.offlineMs) {
        throw new HaltError(
          `대표 노트북의 pm-worker가 ${Math.round((now - this.workerOfflineSince) / 60000)}분째 응답하지 않는다 — 노트북이 꺼졌거나 절전 중이거나 Claude 로그인이 만료됐을 수 있다. pm-worker를 다시 띄운 뒤 같은 명령을 다시 실행`,
        );
      }
    } else {
      this.workerOfflineSince = null;
    }
    for (const room of rooms.rooms) {
      if (!room.agent) continue;
      if (room.agent.online) {
        this.offlineSince.delete(room.role);
        continue;
      }
      const since = this.offlineSince.get(room.role) ?? now;
      this.offlineSince.set(room.role, since);
      if (now - since >= this.opts.offlineMs) {
        throw new HaltError(
          `${room.role} 에이전트가 ${Math.round((now - since) / 60000)}분째 연결돼 있지 않다 — ${room.role} 노트북이 꺼졌거나 절전 중일 수 있다. ` +
            '그 노트북에서 npx @capstone-nomos/cli@latest connect --background 후 같은 명령을 다시 실행',
        );
      }
    }
    // READY인데 아무도 가져가지 않는다 — 진행 중인 태스크가 하나도 없을 때만 본다(선행을 기다리는 READY를 고장으로 세지 않게).
    if (projectStatus !== 'active') return;
    const busy = tasks.some((t) => IN_FLIGHT.has(t.state));
    for (const t of tasks) {
      if (t.state !== 'READY' || busy) {
        this.readySince.delete(t.id);
        continue;
      }
      const since = this.readySince.get(t.id) ?? now;
      this.readySince.set(t.id, since);
      if (now - since >= this.opts.unclaimedMs) {
        throw new HaltError(
          `READY 태스크 "${t.title}"(${t.teamRole ?? '역할 없음'})를 ${Math.round((now - since) / 60000)}분 동안 아무도 가져가지 않았다 — ` +
            `${t.teamRole ?? '그 역할'} 노트북의 connect가 돌고 있는지, Claude 로그인·사용량 한도를 확인한 뒤 같은 명령을 다시 실행`,
        );
      }
    }
  }
}

// ── 감독 ──

export class Supervisor {
  private readonly health: HealthMonitor;
  private state!: RunState;

  constructor(
    private readonly api: NomosApi,
    private readonly opts: SupervisorOptions,
    private readonly store: StateStore,
    private readonly io: SupervisorIo,
  ) {
    this.health = new HealthMonitor(api, opts, io);
  }

  async preflight(): Promise<ProjectDetail> {
    const detail = await this.api.call<ProjectDetail>('GET', `/projects/${this.opts.projectId}`);
    const problems: string[] = [];
    if (detail.project.questionMode !== 'experiment') {
      problems.push(`실험 모드가 아니다(questionMode=${detail.project.questionMode ?? '없음'}) — 시작 전에 PATCH /projects/:id/settings { questionMode: 'experiment' }`);
    }
    if (!['planning', 'active'].includes(detail.project.status)) problems.push(`프로젝트 상태가 ${detail.project.status}다(planning·active만)`);
    for (const role of ['FRONTEND', 'BACKEND']) {
      const m = detail.members.find((x) => x.teamRole === role);
      if (!m) problems.push(`${role} 담당이 배정되지 않았다`);
      else if (!m.agentId) problems.push(`${role} 담당의 에이전트가 연결돼 있지 않다 — 그 노트북에서 connect`);
    }
    const status = await this.api.call<PmStatusJson>('GET', `/projects/${this.opts.projectId}/pm/status`);
    if (!status.ready) problems.push(`PM을 부를 수 없다(${status.reason}) — ${status.reason === 'WORKER_OFFLINE' ? '대표 노트북에서 pm-worker를 띄운다' : '서버의 PM 설정을 확인한다'}`);
    if (problems.length > 0) throw new HaltError(`시작할 수 없다:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    return detail;
  }

  async run(): Promise<RunState> {
    const detail = await this.preflight();
    this.state = (await this.store.load()) ?? emptyState(this.opts.run, this.opts.projectId);
    if (this.state.projectId !== this.opts.projectId) throw new HaltError(`상태 파일의 프로젝트(${this.state.projectId})가 --project와 다르다 — 다른 --run을 쓴다`);
    this.io.log(`프로젝트: ${detail.project.name} (${detail.project.status}) · 실행 이름 ${this.opts.run} — 끊기면 --run ${this.opts.run}으로 이어 간다`);
    if (this.opts.dryRun) {
      for (const r of this.opts.requirements) {
        const s = this.state.requirements[r.key];
        this.io.log(`  [${r.key}] ${s ? `이어 감(${s.status})` : '새로'} · 회차 ${r.repeat ?? this.opts.repeat} · "${r.instruction.slice(0, 80)}"`);
      }
      this.io.log('--dry-run: 아무것도 요청하지 않았다');
      return this.state;
    }
    for (const r of this.opts.requirements) await this.runRequirement(r);
    this.io.log(`다 돌았다 — npm run experiment:run -- --project ${this.opts.projectId} --report --run ${this.opts.run}`);
    return this.state;
  }

  private async save(): Promise<void> {
    await this.store.save(this.state);
  }

  private reqState(key: string): RequirementState {
    this.state.requirements[key] ??= { status: 'pending', rounds: {} };
    return this.state.requirements[key]!;
  }

  private async runRequirement(r: Requirement): Promise<void> {
    const s = this.reqState(r.key);
    if (s.status === 'done' || s.status === 'skipped') {
      this.io.log(`[${r.key}] 이미 ${s.status === 'done' ? '끝났다' : `포기했다(${s.skipReason})`} — 건너뜀`);
      return;
    }
    if (!s.rootPlanId) {
      s.rootPlanId = await this.requestFeature(r);
      s.status = 'planning';
      await this.save();
      this.io.log(`[${r.key}] 기능 명세 요청 ${s.rootPlanId}`);
    }
    if (!s.template) {
      const planned = await this.waitPlanning(r, s);
      if (!planned) {
        s.status = 'skipped';
        this.state.counters.skippedRequirements += 1;
        await this.save();
        return;
      }
    }
    s.status = 'running';
    await this.save();
    await this.ensureStarted();
    const repeat = r.repeat ?? this.opts.repeat;
    for (let round = 1; round <= repeat; round += 1) {
      const rs = s.rounds[String(round)];
      if (rs?.done) continue;
      await this.runRound(r, s, round);
    }
    s.status = 'done';
    await this.save();
  }

  private async requestFeature(r: Requirement): Promise<string> {
    for (;;) {
      try {
        const plan = await this.api.call<{ id: string }>('POST', `/projects/${this.opts.projectId}/pm/features`, { instruction: r.instruction });
        return plan.id;
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('PM_PLAN_IN_PROGRESS')) {
          await this.io.sleep(this.opts.pollMs); // 다른 초안이 작성 중 — 끝나면 다시
          continue;
        }
        if (message.includes('PM_BUDGET_EXCEEDED')) throw new HaltError('PM 예산이 다 떨어졌다 — 대표가 프로젝트 PM 예산을 늘린 뒤 같은 명령을 다시 실행');
        throw err;
      }
    }
  }

  // 기능 명세 체인 적용 → 계약 확정 → 태스크 나누기 적용까지(전부 서버가 자동으로 한다). 태스크 묶음(r1)을 template으로 남긴다.
  // 포기(서버가 다시 시켜도 끝내지 못함)면 false.
  private async waitPlanning(r: Requirement, s: RequirementState): Promise<boolean> {
    const started = this.io.now();
    let failedSince: number | null = null;
    for (;;) {
      const plans = (await this.api.call<{ plans: PlanJson[] }>('GET', `/projects/${this.opts.projectId}/pm/plans`)).plans;
      const chain = chainOf(plans, s.rootPlanId!);
      const applied = chain.find((p) => p.status === 'applied');
      const leaf = chain.find((p) => !plans.some((c) => c.parentPlanId === p.id));
      if (!applied && leaf?.status === 'failed') {
        if (leaf.error?.reason === 'budget') throw new HaltError('PM 예산이 다 떨어졌다 — 대표가 프로젝트 PM 예산을 늘린 뒤 같은 명령을 다시 실행');
        // 서버는 실패하면 바로 다시 낸다 — 다음 판이 두 번 확인하는 동안 생기지 않으면 포기한 것이다(EXPERIMENT_SKIPPED).
        failedSince ??= this.io.now();
        if (this.io.now() - failedSince >= this.opts.pollMs * 2) {
          s.skipReason = `기능 명세 초안 실패(${leaf.error?.reason ?? '?'})`;
          this.io.log(`[${r.key}] 포기 — ${s.skipReason}`);
          this.health.failure(`plan_failed:${leaf.error?.reason ?? '?'}`, 'PM이 같은 이유로 계속 실패한다 — 서버 로그와 PM 설정(모델·키·pm-worker)을 확인한 뒤 같은 명령을 다시 실행');
          return false;
        }
      } else {
        failedSince = null;
      }
      if (applied) {
        s.featureKeys = (applied.featureDraft?.features ?? []).map((f) => f.featureKey);
        const template = await this.templateFor(plans, s.featureKeys);
        if (template) {
          s.template = template;
          s.rounds['1'] = { taskIds: [], done: false };
          this.health.success();
          await this.save();
          this.io.log(`[${r.key}] 계획 끝 — 기능 ${s.featureKeys.join(', ')}, 태스크 ${template.length}개`);
          return true;
        }
        const contracts = (await this.api.call<{ contracts: ContractJson[] }>('GET', `/projects/${this.opts.projectId}/contracts`)).contracts.filter((c) =>
          s.featureKeys!.includes(c.featureKey),
        );
        const failed = contracts.filter((c) => c.status === 'failed');
        if (failed.length > 0 && failedSince === null) failedSince = this.io.now();
        if (failed.length > 0 && this.io.now() - (failedSince ?? 0) >= this.opts.pollMs * 2) {
          throw new HaltError(
            `API 계약 ${failed.map((c) => c.featureKey).join(', ')}을(를) 자동으로 다시 시켜도 쓰지 못했다 — 태스크 나누기가 막힌다. ` +
              'BE 노트북의 connect·Claude 로그인을 확인하고 웹에서 계약 수정 요청을 누른 뒤 같은 명령을 다시 실행',
          );
        }
      }
      if (this.io.now() - started >= this.opts.planningTimeoutMs) {
        throw new HaltError(`[${r.key}] 계획(기능 명세 → 계약 → 태스크 나누기)이 ${Math.round(this.opts.planningTimeoutMs / 60000)}분 안에 끝나지 않았다 — 웹에서 계획·계약 상태를 확인`);
      }
      await this.health.check([], 'planning');
      await this.io.sleep(this.opts.pollMs);
    }
  }

  // 이 요구사항의 기능에 붙은 태스크 나누기(적용된 것)를 찾아 태스크 묶음을 만든다. 아직이면 null.
  private async templateFor(plans: PlanJson[], featureKeys: string[]): Promise<TaskTemplate[] | null> {
    const split = plans
      .filter((p) => p.kind === 'tasks' && p.status === 'applied')
      .find((p) => (p.draft?.tasks ?? []).some((t) => t.spec !== null && featureKeys.includes(t.spec)));
    if (!split?.draft?.tasks) return null;
    const tasks = (await this.api.call<{ tasks: TaskJson[] }>('GET', `/projects/${this.opts.projectId}/tasks?limit=200`)).tasks;
    const byRef = new Map(split.draft.tasks.map((t) => [t.ref, t.title]));
    const template: TaskTemplate[] = [];
    for (const t of split.draft.tasks) {
      const real = tasks.find((x) => x.title === t.title);
      if (!real) return null;
      template.push({
        title: t.title,
        teamRole: real.teamRole,
        kind: real.kind,
        repoId: real.repoId,
        specId: real.specId,
        dependsOn: t.dependsOn.map((d) => byRef.get(d)!).filter(Boolean),
      });
    }
    return template;
  }

  private async ensureStarted(): Promise<void> {
    const detail = await this.api.call<ProjectDetail>('GET', `/projects/${this.opts.projectId}`);
    if (detail.project.status === 'planning') {
      await this.api.call('POST', `/projects/${this.opts.projectId}/start`);
      this.io.log('프로젝트를 시작했다(G1)');
    }
  }

  private async runRound(r: Requirement, s: RequirementState, round: number): Promise<void> {
    const template = s.template!;
    const rs = (s.rounds[String(round)] ??= { taskIds: [], done: false });
    let tasks = (await this.api.call<{ tasks: TaskJson[] }>('GET', `/projects/${this.opts.projectId}/tasks?limit=200`)).tasks;
    // r1은 PM이 만든 그 태스크, r2부터는 꼬리표를 붙여 새로 만든다(이미 있는 제목은 건너뛴다 — 같은 --run으로 다시 돌린 경우).
    const idByTitle = new Map<string, string>();
    for (const t of template) {
      const title = roundTitle(t.title, this.opts.run, round);
      const existing = tasks.find((x) => x.title === title);
      if (existing) {
        idByTitle.set(t.title, existing.id);
        continue;
      }
      const created = await this.api.call<{ id: string }>('POST', `/projects/${this.opts.projectId}/tasks`, {
        title,
        teamRole: t.teamRole,
        kind: t.kind,
        repoId: t.repoId,
        specId: t.specId,
        dependsOn: t.dependsOn.map((d) => idByTitle.get(d)).filter((x): x is string => x !== undefined),
      });
      idByTitle.set(t.title, created.id);
      this.io.log(`  [${r.key}] r${round} 만듦 ${title}`);
    }
    rs.taskIds = [...idByTitle.values()];
    await this.save();
    this.io.log(`[${r.key}] r${round} 실행 중 (${rs.taskIds.length}개)`);

    const started = this.io.now();
    for (;;) {
      tasks = (await this.api.call<{ tasks: TaskJson[] }>('GET', `/projects/${this.opts.projectId}/tasks?limit=200`)).tasks;
      const mine = tasks.filter((t) => rs.taskIds.includes(t.id));
      for (const t of mine) await this.tidy(t);
      const refreshed = (await this.api.call<{ tasks: TaskJson[] }>('GET', `/projects/${this.opts.projectId}/tasks?limit=200`)).tasks;
      const open = refreshed.filter((t) => rs.taskIds.includes(t.id) && !FINISHED.has(t.state));
      if (open.length === 0) break;
      if (this.io.now() - started >= this.opts.roundTimeoutMs) {
        for (const t of open.filter((x) => CANCELLABLE.has(x.state))) await this.cancel(t, `r${round} 시간 초과`);
        const left = open.filter((x) => !CANCELLABLE.has(x.state));
        if (left.length > 0) this.io.log(`  ! r${round} 시간 초과 — 진행 중이라 취소하지 못한 태스크: ${left.map((t) => `${t.title}(${t.state})`).join(', ')}`);
        rs.timedOut = true;
        this.state.counters.timedOutRounds += 1;
        break;
      }
      const detail = await this.api.call<ProjectDetail>('GET', `/projects/${this.opts.projectId}`);
      await this.health.check(refreshed, detail.project.status);
      await this.io.sleep(this.opts.pollMs);
    }
    rs.done = true;
    await this.save();
    this.io.log(`[${r.key}] r${round} 끝`);
  }

  // 태스크 정리 규칙.
  private async tidy(t: TaskJson): Promise<void> {
    if (t.state === 'DONE') {
      this.health.success();
      return;
    }
    const role = t.teamRole ?? '역할 없음';
    if (t.state === 'BLOCKED' && t.blockedReason === 'AGENT_STOPPED') {
      if (!this.state.resumedTaskIds.includes(t.id)) {
        await this.api.call('POST', `/tasks/${t.id}/resume`, { note: '실험 감독 자동 재개(1회)' });
        this.state.resumedTaskIds.push(t.id);
        this.state.counters.resumed += 1;
        await this.save();
        this.io.log(`  재개 ${t.title}`);
      } else {
        await this.cancel(t, '재개 뒤에도 멈춤');
      }
      // 역할을 가리지 않고 센다 — 로그인 만료·사용량 한도는 FE·BE 태스크가 번갈아 멈추는 모양으로도 나온다.
      this.health.failure('task_stopped', `${role} 노트북의 Claude 로그인이 만료됐거나 사용량 한도에 닿았을 수 있다 — claude 로그인·사용량을 확인한 뒤 같은 명령을 다시 실행`);
      return;
    }
    if (t.state === 'ESCALATED') {
      await this.cancel(t, '재시도 소진(ESCALATED)');
      this.health.failure('task_escalated', `${role} 태스크가 계속 검증·반려로 끝난다 — 명세·경로 소유권·검사기 설정을 확인한 뒤 같은 명령을 다시 실행`);
    }
  }

  private async cancel(t: TaskJson, why: string): Promise<void> {
    await this.api.call('POST', `/tasks/${t.id}/cancel`, { reason: `실험 감독: ${why}` });
    this.state.counters.cancelled += 1;
    await this.save();
    this.io.log(`  취소 ${t.title} (${why})`);
  }
}

function chainOf(plans: PlanJson[], rootId: string): PlanJson[] {
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of plans) if (p.parentPlanId && ids.has(p.parentPlanId) && !ids.has(p.id)) (ids.add(p.id), (grew = true));
  }
  return plans.filter((p) => ids.has(p.id));
}

// ── 보고(--report) ──

type DatasetItem = { id: string; stage: string; input: { task: { title: string } | null; spec: { featureKey: string } | null }; primary: { router: string; target: string } };
type ReportRow = { questionId: string; decisions: Record<string, string | null> };

export type ExperimentReport = {
  questions: number;
  byStage: Record<string, number>;
  requirements: {
    key: string;
    status: string;
    planningQuestions: number;
    rounds: { round: number; tasks: number; tasksWithQuestions: number; questions: number }[];
  }[];
  automatic: { planRetries: number; contractRetries: number; resumed: number; cancelled: number; timedOutRounds: number; skippedRequirements: number };
  routers: Record<string, Record<string, number>>;
};

export function buildExperimentReport(input: {
  state: RunState;
  dataset: DatasetItem[];
  report: { rows: ReportRow[] };
  tasks: { id: string; title: string }[];
  plans: { revisionCause: string | null }[];
  contracts: { experimentRetries?: number }[];
}): ExperimentReport {
  const byStage: Record<string, number> = {};
  for (const item of input.dataset) byStage[item.stage] = (byStage[item.stage] ?? 0) + 1;
  const titleOf = new Map(input.tasks.map((t) => [t.id, t.title]));
  const perTitle = new Map<string, number>();
  for (const item of input.dataset) {
    const title = item.input.task?.title;
    if (title) perTitle.set(title, (perTitle.get(title) ?? 0) + 1);
  }
  const requirements = Object.entries(input.state.requirements).map(([key, s]) => {
    const keys = new Set(s.featureKeys ?? []);
    const planningQuestions = input.dataset.filter((d) => d.stage !== 'implementation' && d.input.spec && keys.has(d.input.spec.featureKey)).length;
    const rounds = Object.entries(s.rounds)
      .map(([n, rs]) => {
        const counts = rs.taskIds.map((id) => perTitle.get(titleOf.get(id) ?? '') ?? 0);
        return { round: Number(n), tasks: rs.taskIds.length, tasksWithQuestions: counts.filter((c) => c > 0).length, questions: counts.reduce((a, b) => a + b, 0) };
      })
      .sort((a, b) => a.round - b.round);
    return { key, status: s.status, planningQuestions, rounds };
  });
  const routers: Record<string, Record<string, number>> = {};
  const count = (router: string, target: string | null) => {
    const k = target ?? '(실패)';
    routers[router] ??= {};
    routers[router]![k] = (routers[router]![k] ?? 0) + 1;
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
    requirements,
    automatic: {
      planRetries: input.plans.filter((p) => p.revisionCause === 'retry').length,
      contractRetries: input.contracts.reduce((a, c) => a + (c.experimentRetries ?? 0), 0),
      ...input.state.counters,
    },
    routers,
  };
}

const pct = (a: number, b: number) => (b === 0 ? '-' : `${Math.round((a / b) * 100)}%`);

export function formatExperimentReport(r: ExperimentReport): string[] {
  const lines: string[] = [];
  lines.push(`질문 ${r.questions}건 (질문 행 기준) · 단계별: ${Object.entries(r.byStage).map(([s, n]) => `${s} ${n}`).join(' · ') || '없음'}`);
  lines.push('');
  lines.push('요구사항별 (기획 단계 질문 / 회차: 태스크 · 질문한 태스크 = 발생률 · 질문 수 · 태스크당 질문)');
  for (const req of r.requirements) {
    lines.push(`  [${req.key}] ${req.status} · 기획 단계 질문 ${req.planningQuestions}`);
    for (const x of req.rounds) {
      lines.push(`    r${x.round}: ${x.tasks} · ${x.tasksWithQuestions} = ${pct(x.tasksWithQuestions, x.tasks)} · ${x.questions} · ${(x.questions / Math.max(1, x.tasks)).toFixed(2)}`);
    }
  }
  lines.push('');
  const a = r.automatic;
  lines.push(`자동 처리: 초안 재요청 ${a.planRetries} · 계약 재시도 ${a.contractRetries} · 재개 ${a.resumed} · 취소 ${a.cancelled} · 시간 초과 회차 ${a.timedOutRounds} · 포기한 요구사항 ${a.skippedRequirements}`);
  lines.push('');
  lines.push('라우터별 판정 분포 (primary + shadow + baseline, 대상별 건수)');
  for (const [router, targets] of Object.entries(r.routers).sort((x, y) => x[0].localeCompare(y[0]))) {
    lines.push(`  ${router}: ${Object.entries(targets).sort((x, y) => y[1] - x[1]).map(([t, n]) => `${t} ${n}`).join(' · ')}`);
  }
  return lines;
}

export async function experimentReport(api: NomosApi, projectId: string, state: RunState): Promise<ExperimentReport> {
  const [dataset, report, tasks, plans, contracts] = await Promise.all([
    api.call<{ items: DatasetItem[] }>('GET', `/projects/${projectId}/routing-dataset`),
    api.call<{ rows: ReportRow[] }>('GET', `/projects/${projectId}/routing-report`),
    api.call<{ tasks: { id: string; title: string }[] }>('GET', `/projects/${projectId}/tasks?limit=200`),
    api.call<{ plans: { revisionCause: string | null }[] }>('GET', `/projects/${projectId}/pm/plans`),
    api.call<{ contracts: { experimentRetries?: number }[] }>('GET', `/projects/${projectId}/contracts`),
  ]);
  return buildExperimentReport({ state, dataset: dataset.items, report, tasks: tasks.tasks, plans: plans.plans, contracts: contracts.contracts });
}
