import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildExperimentReport,
  DEFAULTS,
  emptyState,
  formatExperimentReport,
  HaltError,
  parseRoundTitle,
  requirementsSchema,
  roundTitle,
  Supervisor,
  type RunState,
  type StateStore,
  type SupervisorOptions,
} from '../scripts/lib/experiment-run.js';
import type { HttpMethod, NomosApi } from '../scripts/lib/nomos-http.js';

// 무인 실험 감독(scripts/experiment-run.ts) — 가짜 서버 응답으로 흐름·이어 돌리기·태스크 정리·고장 감지를 본다.
// 서버 쪽 자동 통과(초안 적용·계약 확정·승인)는 tests/experiment-autopilot.test.ts가 실제 서버로 본다 — 여기서는 그 결과 모양만 흉내 낸다.

type Task = { id: string; title: string; state: string; blockedReason: string | null; teamRole: string | null; kind: string; repoId: string; specId: string | null };

// 감독이 부르는 API만 흉내 낸다. 상태는 테스트가 onPoll로 바꾼다(에이전트가 일하는 것처럼).
function fakeServer(options: { questionMode?: string; projectStatus?: string; repoOwners?: string[]; memberRoles?: string[] } = {}) {
  const s = {
    project: { id: 'p1', name: '스터디', status: options.projectStatus ?? 'planning', questionRelay: true, questionMode: options.questionMode ?? 'experiment' },
    plans: [] as Record<string, unknown>[],
    tasks: [] as Task[],
    contracts: [] as { featureKey: string; status: string; experimentRetries: number }[],
    rooms: [
      { role: 'FRONTEND', agent: { online: true } },
      { role: 'BACKEND', agent: { online: true } },
    ],
    pm: { ready: true, reason: null as string | null, budgetUsd: 40, spentUsd: 1, pendingPlanId: null },
    calls: [] as { method: HttpMethod; path: string; body?: unknown }[],
    // 기능 명세를 요청받으면 서버(실험 모드)가 끝까지 진행한 결과를 바로 만든다.
    onFeature: (instruction: string) => {
      const n = s.plans.length;
      const featureKey = `F-${n + 1}`;
      s.plans.push({
        id: `plan-${n}`,
        kind: 'feature',
        status: 'applied',
        parentPlanId: null,
        revisionCause: null,
        createdAt: '',
        error: null,
        draft: null,
        featureDraft: { features: [{ featureKey, needsApi: true }] },
        instruction,
      });
      s.contracts.push({ featureKey, status: 'approved', experimentRetries: 0 });
      s.plans.push({
        id: `plan-${n}-tasks`,
        kind: 'tasks',
        status: 'applied',
        parentPlanId: null,
        revisionCause: null,
        createdAt: '',
        error: null,
        featureDraft: null,
        draft: {
          tasks: [
            { ref: 'api', title: `${featureKey} API`, spec: featureKey, dependsOn: [] },
            { ref: 'ui', title: `${featureKey} 화면`, spec: featureKey, dependsOn: ['api'] },
          ],
        },
      });
      for (const [title, role] of [[`${featureKey} API`, 'BACKEND'], [`${featureKey} 화면`, 'FRONTEND']] as const) {
        s.tasks.push({ id: `t${s.tasks.length + 1}`, title, state: 'READY', blockedReason: null, teamRole: role, kind: 'IMPLEMENT', repoId: role === 'BACKEND' ? 'r-api' : 'r-web', specId: `spec-${featureKey}` });
      }
    },
    // 감독이 상태를 읽을 때마다(작업 진행 흉내). 기본: READY → DONE.
    onPoll: () => {
      for (const t of s.tasks) if (t.state === 'READY' && s.project.status === 'active') t.state = 'DONE';
    },
  };
  const api: NomosApi = {
    async call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
      s.calls.push({ method, path, body });
      const ok = (v: unknown) => v as T;
      if (method === 'GET' && path === '/projects/p1') {
        const members = (options.memberRoles ?? ['FRONTEND', 'BACKEND']).map((teamRole, i) => ({ teamRole, agentId: `a${i + 1}` }));
        const repos = (options.repoOwners ?? []).map((_, i) => ({ id: `r${i}` }));
        return ok({ project: s.project, members, ...(options.repoOwners ? { repos } : {}) });
      }
      const repoPaths = /^\/repos\/r(\d+)\/paths$/.exec(path);
      if (method === 'GET' && repoPaths) return ok({ paths: [{ ownerRole: options.repoOwners![Number(repoPaths[1])] }, { ownerRole: null }] });
      if (path === '/projects/p1/pm/status') return ok(s.pm);
      if (path === '/projects/p1/rooms') return ok({ rooms: s.rooms });
      if (path === '/projects/p1/pm/plans') return ok({ plans: s.plans });
      if (path === '/projects/p1/contracts') return ok({ contracts: s.contracts });
      if (method === 'POST' && path === '/projects/p1/pm/features') {
        s.onFeature((body as { instruction: string }).instruction);
        return ok({ id: `plan-${s.plans.length - 2}` });
      }
      if (method === 'POST' && path === '/projects/p1/start') {
        s.project.status = 'active';
        return ok(s.project);
      }
      if (method === 'GET' && path.startsWith('/projects/p1/tasks')) {
        s.onPoll();
        return ok({ tasks: s.tasks.map((t) => ({ ...t })) });
      }
      if (method === 'POST' && path === '/projects/p1/tasks') {
        const b = body as Omit<Task, 'id' | 'state' | 'blockedReason'> & { dependsOn: string[] };
        if (s.tasks.some((t) => t.title === b.title)) throw new Error('409 PLAN_INVALID duplicate title');
        const t: Task = { id: `t${s.tasks.length + 1}`, title: b.title, state: 'READY', blockedReason: null, teamRole: b.teamRole, kind: b.kind, repoId: b.repoId, specId: b.specId };
        s.tasks.push(t);
        return ok({ id: t.id });
      }
      const resume = /^\/tasks\/(t\d+)\/resume$/.exec(path);
      if (method === 'POST' && resume) {
        const t = s.tasks.find((x) => x.id === resume[1])!;
        Object.assign(t, { state: 'READY', blockedReason: null });
        return ok(t);
      }
      const cancel = /^\/tasks\/(t\d+)\/cancel$/.exec(path);
      if (method === 'POST' && cancel) {
        const t = s.tasks.find((x) => x.id === cancel[1])!;
        Object.assign(t, { state: 'CANCELLED', blockedReason: null });
        return ok(t);
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { s, api };
}

function memoryStore(initial: RunState | null = null): StateStore & { state: RunState | null } {
  const store = {
    state: initial,
    async load() {
      return store.state ? (JSON.parse(JSON.stringify(store.state)) as RunState) : null;
    },
    async save(state: RunState) {
      store.state = JSON.parse(JSON.stringify(state)) as RunState;
    },
  };
  return store;
}

function clockIo() {
  const lines: string[] = [];
  let now = 0;
  return { lines, io: { log: (l = '') => void lines.push(l), sleep: async (ms: number) => void (now += ms), now: () => now } };
}

const REQS = requirementsSchema.parse([{ key: 'list', instruction: '스터디 목록' }]);

function opts(extra: Partial<SupervisorOptions> = {}): SupervisorOptions {
  return { projectId: 'p1', requirements: REQS, repeat: 2, run: 'e1', dryRun: false, ...DEFAULTS, pollMs: 1000, ...extra };
}

const posts = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === 'POST').map((c) => c.path);

describe('감독 흐름', () => {
  it('--dry-run은 확인만 하고 아무것도 요청하지 않는다', async () => {
    const { s, api } = fakeServer();
    const { io, lines } = clockIo();
    await new Supervisor(api, opts({ dryRun: true }), memoryStore(), io).run();
    expect(posts(s.calls)).toEqual([]);
    expect(lines.at(-1)).toBe('--dry-run: 아무것도 요청하지 않았다');
  });

  it('담당을 요구하는 역할은 프로젝트 레포의 소유 역할뿐이다 — BE 레포만 있으면 FE 담당 없이 시작한다', async () => {
    const beOnly = fakeServer({ repoOwners: ['BACKEND'], memberRoles: ['BACKEND'] });
    await new Supervisor(beOnly.api, opts({ dryRun: true }), memoryStore(), clockIo().io).run();
    const both = fakeServer({ repoOwners: ['FRONTEND', 'BACKEND'], memberRoles: ['BACKEND'] });
    const err = await new Supervisor(both.api, opts({ dryRun: true }), memoryStore(), clockIo().io).run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HaltError);
    expect((err as Error).message).toContain('FRONTEND 담당이 배정되지 않았다');
  });

  it('실험 모드가 아니면 시작하지 않는다(HaltError)', async () => {
    const { s, api } = fakeServer({ questionMode: 'normal' });
    const err = await new Supervisor(api, opts(), memoryStore(), clockIo().io).run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HaltError);
    expect((err as Error).message).toContain('실험 모드가 아니다');
    expect(posts(s.calls)).toEqual([]);
  });

  it('기능 명세 요청 → (서버 자동 진행) → 시작 → r1(PM이 만든 태스크) → r2(꼬리표·선행 유지) — 같은 --run으로 다시 돌리면 건너뛴다', async () => {
    const { s, api } = fakeServer();
    const store = memoryStore();
    await new Supervisor(api, opts(), store, clockIo().io).run();
    expect(posts(s.calls).filter((p) => p === '/projects/p1/pm/features')).toHaveLength(1);
    expect(posts(s.calls)).toContain('/projects/p1/start');
    expect(s.tasks.map((t) => [t.title, t.state])).toEqual([
      ['F-1 API', 'DONE'],
      ['F-1 화면', 'DONE'],
      [roundTitle('F-1 API', 'e1', 2), 'DONE'],
      [roundTitle('F-1 화면', 'e1', 2), 'DONE'],
    ]);
    // r2 화면 태스크는 r2 API 태스크를 선행으로 둔다.
    const created = s.calls.filter((c) => c.method === 'POST' && c.path === '/projects/p1/tasks').map((c) => c.body as { title: string; dependsOn: string[] });
    expect(created[1]).toMatchObject({ title: roundTitle('F-1 화면', 'e1', 2), dependsOn: ['t3'] });
    expect(parseRoundTitle(created[1]!.title)).toEqual({ base: 'F-1 화면', run: 'e1', round: 2 });
    expect(store.state!.requirements.list).toMatchObject({ status: 'done', featureKeys: ['F-1'] });

    const before = s.calls.length;
    const again = clockIo();
    await new Supervisor(api, opts(), store, again.io).run();
    expect(posts(s.calls.slice(before))).toEqual([]);
    expect(again.lines).toContain('[list] 이미 끝났다 — 건너뜀');
  });

  it('중간에 멈춘 실행을 같은 --run으로 이어 간다(기능 명세를 다시 요청하지 않고, 만든 회차 태스크를 다시 만들지 않는다)', async () => {
    const { s, api } = fakeServer();
    const store = memoryStore();
    // r2 도중 BE 노트북이 꺼진다.
    s.onPoll = () => {
      for (const t of s.tasks) if (t.state === 'READY' && s.project.status === 'active' && !parseRoundTitle(t.title)) t.state = 'DONE';
      if (s.tasks.length > 2) s.rooms[1]!.agent.online = false;
    };
    const err = await new Supervisor(api, opts(), store, clockIo().io).run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HaltError);
    expect((err as Error).message).toContain('BACKEND 에이전트가');
    expect((err as Error).message).toContain('connect --background');
    expect(store.state!.requirements.list!.rounds['1']!.done).toBe(true);

    // 노트북을 켜고 다시 돌린다.
    s.rooms[1]!.agent.online = true;
    s.onPoll = () => {
      for (const t of s.tasks) if (t.state === 'READY') t.state = 'DONE';
    };
    const before = s.calls.length;
    await new Supervisor(api, opts(), store, clockIo().io).run();
    expect(posts(s.calls.slice(before))).toEqual([]); // 기능 명세 요청도, r2 태스크 생성도 다시 하지 않는다
    expect(s.tasks).toHaveLength(4);
    expect(store.state!.requirements.list!.status).toBe('done');
  });
});

describe('태스크 정리 규칙', () => {
  it('BLOCKED(AGENT_STOPPED) → 재개 1회, 또 멈추면 취소 / ESCALATED → 취소 / 승인 대기는 기다린다', async () => {
    const { s, api } = fakeServer();
    let polls = 0;
    s.onPoll = () => {
      polls += 1;
      if (s.project.status !== 'active') return;
      const [apiTask, ui] = s.tasks;
      if (apiTask!.state === 'READY') Object.assign(apiTask!, { state: 'BLOCKED', blockedReason: 'AGENT_STOPPED' }); // 재개해도 또 멈춘다
      if (ui!.state === 'READY' && polls < 8) ui!.state = 'AWAITING_APPROVAL';
      else if (ui!.state === 'AWAITING_APPROVAL' && polls >= 8) ui!.state = 'ESCALATED';
    };
    const store = memoryStore();
    await new Supervisor(api, opts({ repeat: 1, failureLimit: 5 }), store, clockIo().io).run();
    const resumes = posts(s.calls).filter((p) => p.endsWith('/resume'));
    const cancels = posts(s.calls).filter((p) => p.endsWith('/cancel'));
    expect(resumes).toEqual(['/tasks/t1/resume']);
    expect(cancels).toEqual(['/tasks/t1/cancel', '/tasks/t2/cancel']);
    expect(s.tasks.map((t) => t.state)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(store.state!.counters).toMatchObject({ resumed: 1, cancelled: 2 });
  });

  it('회차 시간 초과 — 취소할 수 있는 것은 취소하고 다음 회차로 간다', async () => {
    const { s, api } = fakeServer();
    s.onPoll = () => {
      if (s.project.status !== 'active') return;
      for (const t of s.tasks) if (t.state === 'READY' && t.teamRole === 'BACKEND') t.state = 'DONE';
    };
    // 화면 태스크는 아무도 가져가지 않지만 BE가 일하는 동안은 "진행 중"이 아니다 — 고장 감지는 길게 둔다.
    const store = memoryStore();
    await new Supervisor(api, opts({ repeat: 2, roundTimeoutMs: 5000, unclaimedMs: 60 * 60_000 }), store, clockIo().io).run();
    expect(store.state!.counters.timedOutRounds).toBe(2);
    expect(s.tasks.filter((t) => t.teamRole === 'FRONTEND').map((t) => t.state)).toEqual(['CANCELLED', 'CANCELLED']);
  });
});

describe('고장 감지 — 멈추고 사람이 할 일을 알린다', () => {
  async function haltOf(setup: (s: ReturnType<typeof fakeServer>['s']) => void, extra: Partial<SupervisorOptions> = {}): Promise<string> {
    const { s, api } = fakeServer();
    setup(s);
    const err = await new Supervisor(api, opts(extra), memoryStore(), clockIo().io).run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HaltError);
    return (err as Error).message;
  }

  it('PM 예산 소진', async () => {
    const message = await haltOf((s) => {
      s.onPoll = () => {
        s.pm.spentUsd = 40;
      };
    });
    expect(message).toContain('PM 예산이 다 떨어졌다');
  });

  it('PM 워커 offline이 계속되면', async () => {
    const message = await haltOf((s) => {
      s.onPoll = () => {
        (s.pm as { reason: string | null }).reason = 'WORKER_OFFLINE';
      };
    });
    expect(message).toContain('pm-worker');
  });

  it('같은 실패가 연속 K번', async () => {
    const message = await haltOf(
      (s) => {
        s.onPoll = () => {
          for (const t of s.tasks) if (t.state === 'READY' && s.project.status === 'active') Object.assign(t, { state: 'BLOCKED', blockedReason: 'AGENT_STOPPED' });
        };
      },
      { failureLimit: 3 },
    );
    expect(message).toContain('같은 실패(task_stopped)가 연속 3번');
    expect(message).toContain('Claude 로그인');
  });

  it('READY 태스크를 아무도 가져가지 않으면', async () => {
    const message = await haltOf((s) => {
      s.onPoll = () => undefined;
    });
    expect(message).toContain('아무도 가져가지 않았다');
  });

  it('CLI는 멈추면 종료 코드 3과 원인 한 줄을 낸다', async () => {
    // 실험 모드가 아닌 프로젝트를 돌려주는 작은 서버.
    const server: Server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/projects/p1') {
        res.end(JSON.stringify({ data: { project: { id: 'p1', name: 'x', status: 'planning', questionRelay: true, questionMode: 'normal' }, members: [] } }));
      } else if (req.url === '/api/projects/p1/pm/status') {
        res.end(JSON.stringify({ data: { ready: true, reason: null, budgetUsd: 40, spentUsd: 0, pendingPlanId: null } }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    // 같은 프로세스의 서버가 응답해야 하므로 비동기로 띄운다(spawnSync면 이벤트 루프가 막혀 교착한다).
    const run = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'scripts/experiment-run.ts', '--project', 'p1', '--requirements', 'scripts/examples/experiment-requirements.json', '--server', `http://127.0.0.1:${port}`],
      { encoding: 'utf8', env: { ...process.env, NOMOS_TOKEN: 'test-token', EXPERIMENT_ALERT_WEBHOOK: '' } },
    ).then(
      () => ({ status: 0, stderr: '' }),
      (err: { code: number; stderr: string }) => ({ status: err.code, stderr: err.stderr }),
    );
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('멈춤: 시작할 수 없다');
    expect(run.stderr).toContain('실험 모드가 아니다');
  });
});

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
});

describe('보고(--report)', () => {
  it('단계별 질문 수, 요구사항·회차별 발생률, 자동 처리 건수, 라우터별 분포', () => {
    const state = emptyState('e1', 'p1');
    state.requirements.list = {
      status: 'done',
      featureKeys: ['F-1'],
      rounds: { '1': { taskIds: ['t1', 't2'], done: true }, '2': { taskIds: ['t3', 't4'], done: true } },
    };
    state.counters = { resumed: 1, cancelled: 2, timedOutRounds: 0, skippedRequirements: 0 };
    const item = (id: string, stage: string, title: string | null, featureKey: string | null, target = 'BACKEND') => ({
      id,
      stage,
      input: { task: title ? { title } : null, spec: featureKey ? { featureKey } : null },
      primary: { router: 'llm:pm', target },
    });
    const report = buildExperimentReport({
      state,
      dataset: [
        item('q1', 'feature_spec', null, 'F-1', 'PM'),
        item('q2', 'contract', null, 'F-1', 'FRONTEND'),
        item('q3', 'implementation', 'F-1 화면', 'F-1'),
        item('q4', 'implementation', 'F-1 화면', 'F-1'),
        item('q5', 'implementation', roundTitle('F-1 API', 'e1', 2), 'F-1', 'FRONTEND'),
      ],
      report: { rows: [{ questionId: 'q1', decisions: { 'baseline:asker': 'SELF', 'llm:pm': 'PM', 'decision:v1': null } }] },
      tasks: [
        { id: 't1', title: 'F-1 API' },
        { id: 't2', title: 'F-1 화면' },
        { id: 't3', title: roundTitle('F-1 API', 'e1', 2) },
        { id: 't4', title: roundTitle('F-1 화면', 'e1', 2) },
      ],
      plans: [{ revisionCause: null }, { revisionCause: 'retry' }, { revisionCause: 'answers' }],
      contracts: [{ experimentRetries: 1 }],
    });
    expect(report.byStage).toEqual({ feature_spec: 1, contract: 1, implementation: 3 });
    expect(report.requirements).toEqual([
      {
        key: 'list',
        status: 'done',
        planningQuestions: 2,
        rounds: [
          { round: 1, tasks: 2, tasksWithQuestions: 1, questions: 2 },
          { round: 2, tasks: 2, tasksWithQuestions: 1, questions: 1 },
        ],
      },
    ]);
    expect(report.automatic).toEqual({ planRetries: 1, contractRetries: 1, resumed: 1, cancelled: 2, timedOutRounds: 0, skippedRequirements: 0 });
    expect(report.routers).toEqual({
      'baseline:asker': { SELF: 1 },
      'llm:pm': { PM: 1, FRONTEND: 2, BACKEND: 2 },
      'decision:v1': { '(실패)': 1 },
    });
    const text = formatExperimentReport(report);
    expect(text).toContain('    r1: 2 · 1 = 50% · 2 · 1.00');
    expect(text).toContain('자동 처리: 초안 재요청 1 · 계약 재시도 1 · 재개 1 · 취소 2 · 시간 초과 회차 0 · 포기한 요구사항 0');
  });

  it('요구사항 파일 형식', () => {
    expect(requirementsSchema.safeParse([{ key: 'a', instruction: 'x' }, { key: 'a', instruction: 'y' }]).success).toBe(false);
    expect(requirementsSchema.safeParse([{ key: 'a b', instruction: 'x' }]).success).toBe(false);
    expect(requirementsSchema.safeParse([{ key: 'a', instruction: 'x', repeat: 3 }]).success).toBe(true);
  });
});
