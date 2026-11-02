import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NomosHttp, type HttpMethod, type NomosApi } from '../scripts/lib/nomos-http.js';
import {
  buildHarvestReport,
  formatHarvestReport,
  harvestFileSchema,
  harvestReport,
  parseRoundTitle,
  roundTitle,
  runHarvest,
  type HarvestOptions,
  type TaskRow,
} from '../scripts/lib/question-harvest.js';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { connectAgent } from '../src/domain/agent/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { clearPolicyCache } from '../src/domain/policy/policy-cache.js';
import { assignMember, createProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { cancelTask } from '../src/domain/task/human-control.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 질문 모으기 반복 실행(scripts/question-harvest.ts) — 확인·dry-run·회차 만들기는 실제 서버(HTTP)로,
// 멈춘 태스크 취소·이어 가기·보고 계산은 가짜 API로 본다(에이전트 없이 BLOCKED·ESCALATED를 만들 서비스 경로가 길다).

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await resetSchema();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await truncateAll();
  clearPolicyCache();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

const PASSWORD = 'correct-horse-battery';

async function world(options: { experiment: boolean }) {
  const rep = await signup({ loginId: 'rep', password: PASSWORD, nickname: '대표' });
  const fe = await signup({ loginId: 'fe', password: PASSWORD, nickname: '지수' });
  const be = await signup({ loginId: 'be', password: PASSWORD, nickname: '민수' });
  const { orgId } = await createOrganization(rep.userId, 'Acme');
  for (const u of [fe, be]) {
    const { token } = await createInvite(orgId, rep.userId);
    await acceptInvite(token, u.userId);
  }
  const [web, api] = await connectRepos({
    orgId,
    actorUserId: rep.userId,
    actorOrgRole: 'REPRESENTATIVE',
    repos: [{ fullName: 'acme/web', ownerRole: 'FRONTEND' }, { fullName: 'acme/api', ownerRole: 'BACKEND' }],
  });
  const { project } = await createProject(orgId, rep.userId, { name: '스터디', autonomyPreset: 'L2', pmBudgetUsd: 40, repoIds: [web!.id, api!.id] });
  const actor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' as const };
  for (const [u, role, name] of [[fe, 'FRONTEND', 'fe-mbp'], [be, 'BACKEND', 'be-mbp']] as const) {
    const agent = await connectAgent({ connectKey: u.connectKey, agentName: name, harness: 'test', skills: [], maxConcurrent: 1 });
    await assignMember(actor, project.id, agent.agentId, role);
  }
  const http = new NomosHttp(baseUrl, (await login({ loginId: 'rep', password: PASSWORD })).accessToken);
  if (options.experiment) await http.call('PATCH', `/projects/${project.id}/settings`, { questionMode: 'experiment' });
  // 기능 명세 — API가 필요 없는 것 하나, 필요한데 계약이 없는 것 하나.
  await http.call('POST', `/projects/${project.id}/specs`, { featureKey: 'F-1', title: '스터디 목록', content: '목록', tests: [] });
  await http.call('POST', `/projects/${project.id}/specs`, { featureKey: 'F-2', title: '스터디 신청', content: '신청', tests: [], needsApi: true, apiNeeds: '신청 정보' });
  return { projectId: project.id, http, actor };
}

const FILE = harvestFileSchema.parse({
  tasks: [
    { ref: 'api', title: '스터디 목록 API', teamRole: 'BACKEND', repo: 'acme/api', featureKey: 'F-1' },
    { ref: 'ui', title: '스터디 목록 화면', teamRole: 'FRONTEND', repo: 'acme/web', featureKey: 'F-1', dependsOn: ['api'] },
  ],
});

function options(projectId: string, extra: Partial<HarvestOptions> = {}): HarvestOptions {
  return { projectId, file: FILE, repeat: 2, run: 'h-test', dryRun: false, pollMs: 1000, roundTimeoutMs: 10_000, ...extra };
}

function io(onSleep: () => Promise<void> = async () => {}) {
  const lines: string[] = [];
  return { lines, log: (line = '') => void lines.push(line), sleep: async () => onSleep() };
}

describe('확인·dry-run·회차 만들기(실제 서버)', () => {
  it('실험 모드가 아니거나 계약이 확정되지 않은 기능이면 아무것도 만들지 않는다', async () => {
    const w = await world({ experiment: false });
    const withContract = harvestFileSchema.parse({ tasks: [{ title: '신청 API', teamRole: 'BACKEND', repo: 'acme/api', featureKey: 'F-2' }] });
    const err = await runHarvest(w.http, options(w.projectId, { file: withContract }), io()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('실험 모드가 아니다');
    expect((err as Error).message).toContain('F-2의 API 계약이 확정되지 않았다');
    expect(await w.http.call<{ tasks: unknown[] }>('GET', `/projects/${w.projectId}/tasks`)).toEqual({ tasks: [] });
  });

  it('--dry-run은 회차별 제목만 출력하고 만들지 않는다', async () => {
    const w = await world({ experiment: true });
    const out = io();
    await runHarvest(w.http, options(w.projectId, { dryRun: true }), out);
    expect(out.lines).toContain(`  ${roundTitle('스터디 목록 화면', 'h-test', 2)} · FRONTEND · acme/web · F-1 · 선행 api`);
    expect(out.lines.at(-1)).toBe('--dry-run: 아무것도 만들지 않았다');
    expect((await w.http.call<{ tasks: unknown[] }>('GET', `/projects/${w.projectId}/tasks`)).tasks).toEqual([]);
  });

  it('회차마다 꼬리표 붙은 태스크를 새로 만들고(선행 포함), 회차가 끝나야 다음 회차로 간다 — 같은 --run이면 이어 간다', async () => {
    const w = await world({ experiment: true });
    // 기다리는 동안 "에이전트"가 할 일 — 여기서는 대표가 전부 취소해 회차를 끝낸다(끝난 상태로 센다).
    const finishOpen = async () => {
      const { tasks } = await w.http.call<{ tasks: TaskRow[] }>('GET', `/projects/${w.projectId}/tasks`);
      for (const t of tasks.filter((x) => x.state === 'READY')) await cancelTask(w.actor, t.id, '테스트');
    };
    await runHarvest(w.http, options(w.projectId), io(finishOpen));
    const { tasks } = await w.http.call<{ tasks: (TaskRow & { id: string })[] }>('GET', `/projects/${w.projectId}/tasks`);
    expect(tasks.map((t) => t.title).sort()).toEqual(
      [roundTitle('스터디 목록 API', 'h-test', 1), roundTitle('스터디 목록 API', 'h-test', 2), roundTitle('스터디 목록 화면', 'h-test', 1), roundTitle('스터디 목록 화면', 'h-test', 2)].sort(),
    );
    // 회차 안의 선행 — 화면 태스크는 같은 회차의 API 태스크를 기다린다.
    const deps = await pool.query(
      `SELECT t.title AS task, d.title AS dep FROM task_deps x JOIN tasks t ON t.id = x.task_id JOIN tasks d ON d.id = x.depends_on WHERE t.project_id = $1 ORDER BY 1`,
      [w.projectId],
    );
    expect(deps.rows.map((r) => [parseRoundTitle(r.task)!.round, parseRoundTitle(r.dep)!.round])).toEqual([[1, 1], [2, 2]]);

    // 같은 --run으로 다시 돌리면 끝난 회차를 건너뛰고, 더 늘린 회차만 만든다(중복 없음).
    const again = io(finishOpen);
    await runHarvest(w.http, options(w.projectId, { repeat: 3 }), again);
    expect(again.lines).toContain('r1: 이미 끝났다 — 건너뜀');
    expect(again.lines).toContain('r2: 이미 끝났다 — 건너뜀');
    expect((await w.http.call<{ tasks: unknown[] }>('GET', `/projects/${w.projectId}/tasks`)).tasks).toHaveLength(6);
  });

  it('--report는 실제 응답 모양을 읽는다(질문이 없으면 0)', async () => {
    const w = await world({ experiment: true });
    const report = await harvestReport(w.http, w.projectId, null);
    expect(report).toEqual({ questions: 0, byStage: {}, rounds: [], perTask: [], routers: {} });
  });
});

// ── 가짜 API — 상태 전이를 손으로 정한다 ──

function fakeApi(project: Record<string, unknown> = {}) {
  const tasks: (TaskRow & { kind: string })[] = [];
  const calls: { method: HttpMethod; path: string; body?: unknown }[] = [];
  let polls = 0;
  // 회차마다: 첫 확인 때는 진행 중, 다음 확인부터 끝(API = DONE, 화면 = 회차마다 BLOCKED·ESCALATED·AWAITING_APPROVAL 차례로).
  const finals = ['BLOCKED', 'ESCALATED', 'AWAITING_APPROVAL'];
  const api: NomosApi = {
    async call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      if (method === 'GET' && path === '/projects/p1') {
        return {
          project: { id: 'p1', name: '스터디', status: 'active', questionRelay: true, questionMode: 'experiment', ...project },
          repos: [{ id: 'r-api', fullName: 'acme/api' }, { id: 'r-web', fullName: 'acme/web' }],
          members: [{ teamRole: 'BACKEND', agentId: 'a1' }, { teamRole: 'FRONTEND', agentId: 'a2' }],
        } as T;
      }
      if (path === '/projects/p1/specs') return { specs: [{ id: 's1', featureKey: 'F-1', needsApi: true }] } as T;
      if (path === '/projects/p1/contracts') return { contracts: [{ featureKey: 'F-1', status: 'approved' }] } as T;
      if (method === 'GET' && path.startsWith('/projects/p1/tasks')) {
        polls += 1;
        for (const t of tasks) {
          if (t.state === 'IN_PROGRESS') {
            const round = parseRoundTitle(t.title)!.round;
            t.state = t.title.startsWith('스터디 목록 API') ? 'DONE' : finals[(round - 1) % finals.length]!;
            t.blockedReason = t.state === 'BLOCKED' ? 'AGENT_STOPPED' : null;
          }
          if (t.state === 'READY') t.state = 'IN_PROGRESS';
        }
        return { tasks: tasks.map((t) => ({ ...t })) } as T;
      }
      if (method === 'POST' && path === '/projects/p1/tasks') {
        const b = body as { title: string; teamRole: string; kind: string };
        if (tasks.some((t) => t.title === b.title)) throw new Error('duplicate title');
        const row = { id: `t${tasks.length + 1}`, title: b.title, state: 'READY', blockedReason: null, teamRole: b.teamRole, kind: b.kind };
        tasks.push(row);
        return { id: row.id } as T;
      }
      const cancel = /^\/tasks\/(t\d+)\/cancel$/.exec(path);
      if (method === 'POST' && cancel) {
        const t = tasks.find((x) => x.id === cancel[1])!;
        t.state = 'CANCELLED';
        return t as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { api, tasks, calls, polls: () => polls };
}

const FAKE_FILE = harvestFileSchema.parse({
  tasks: [
    { title: '스터디 목록 API', teamRole: 'BACKEND', repo: 'acme/api', featureKey: 'F-1' },
    { title: '스터디 목록 화면', teamRole: 'FRONTEND', repo: 'acme/web', featureKey: 'F-1' },
  ],
});

describe('회차 정리(가짜 API)', () => {
  it('끝난 회차의 BLOCKED·ESCALATED는 취소하고 DONE은 두고, 승인 대기는 취소하지 못해 알린다 — 그 뒤에 다음 회차를 만든다', async () => {
    const fake = fakeApi();
    const out = io();
    await runHarvest(fake.api, { projectId: 'p1', file: FAKE_FILE, repeat: 3, run: 'h1', dryRun: false, pollMs: 1, roundTimeoutMs: 1000 }, out);
    const states = Object.fromEntries(fake.tasks.map((t) => [t.title, t.state]));
    expect(states).toEqual({
      [roundTitle('스터디 목록 API', 'h1', 1)]: 'DONE',
      [roundTitle('스터디 목록 화면', 'h1', 1)]: 'CANCELLED', // BLOCKED(AGENT_STOPPED)였다
      [roundTitle('스터디 목록 API', 'h1', 2)]: 'DONE',
      [roundTitle('스터디 목록 화면', 'h1', 2)]: 'CANCELLED', // ESCALATED였다
      [roundTitle('스터디 목록 API', 'h1', 3)]: 'DONE',
      [roundTitle('스터디 목록 화면', 'h1', 3)]: 'AWAITING_APPROVAL',
    });
    expect(out.lines.some((l) => l.includes('승인 대기라 취소할 수 없어'))).toBe(true);
    // 다음 회차는 앞 회차를 정리한 뒤에 만든다.
    const order = fake.calls.filter((c) => c.method === 'POST').map((c) => (c.path.endsWith('/cancel') ? 'cancel' : (c.body as { title: string }).title));
    expect(order.indexOf('cancel')).toBeLessThan(order.indexOf(roundTitle('스터디 목록 API', 'h1', 2)));
  });

  it('질문 대기(BLOCKED·QUESTION)는 끝난 것으로 보지 않는다, 시간이 넘으면 이어 갈 방법을 알리고 멈춘다', async () => {
    const fake = fakeApi();
    // 만들자마자 질문 대기로 멈춘 채 풀리지 않는다.
    const original = fake.api.call.bind(fake.api);
    fake.api.call = (async (method: HttpMethod, path: string, body?: unknown) => {
      const res = await original(method, path, body);
      for (const t of fake.tasks) if (t.state !== 'CANCELLED') Object.assign(t, { state: 'BLOCKED', blockedReason: 'QUESTION' });
      return res;
    }) as NomosApi['call'];
    const err = await runHarvest(fake.api, { projectId: 'p1', file: FAKE_FILE, repeat: 1, run: 'h1', dryRun: false, pollMs: 10, roundTimeoutMs: 30 }, io()).catch(
      (e: Error) => e,
    );
    expect((err as Error).message).toContain('r1이 0분 안에 끝나지 않았다');
    expect((err as Error).message).toContain('같은 --run h1으로 다시 실행하면 이어 간다');
    expect(fake.calls.some((c) => c.path.endsWith('/cancel'))).toBe(false);
  });

  it('dry-run은 확인만 하고 쓰지 않는다', async () => {
    const fake = fakeApi();
    await runHarvest(fake.api, { projectId: 'p1', file: FAKE_FILE, repeat: 2, run: 'h1', dryRun: true, pollMs: 1, roundTimeoutMs: 1000 }, io());
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('보고 계산', () => {
  const tasks: TaskRow[] = [
    { id: '1', title: roundTitle('목록 API', 'h1', 1), state: 'DONE', blockedReason: null, teamRole: 'BACKEND' },
    { id: '2', title: roundTitle('목록 화면', 'h1', 1), state: 'CANCELLED', blockedReason: null, teamRole: 'FRONTEND' },
    { id: '3', title: roundTitle('목록 API', 'h1', 2), state: 'DONE', blockedReason: null, teamRole: 'BACKEND' },
    { id: '4', title: roundTitle('목록 화면', 'h1', 2), state: 'DONE', blockedReason: null, teamRole: 'FRONTEND' },
    { id: '5', title: roundTitle('목록 API', 'other', 1), state: 'DONE', blockedReason: null, teamRole: 'BACKEND' },
    { id: '6', title: '손으로 만든 태스크', state: 'DONE', blockedReason: null, teamRole: 'BACKEND' },
  ];
  const item = (id: string, stage: string, title: string | null, target = 'BACKEND') => ({
    id,
    stage,
    input: { task: title === null ? null : { title }, questions: [{}] },
    primary: { router: 'llm:pm', target },
    answerSource: 'auto_first_option',
  });
  const dataset = [
    item('q1', 'implementation', roundTitle('목록 화면', 'h1', 1)),
    item('q2', 'implementation', roundTitle('목록 화면', 'h1', 1), 'PM'),
    item('q3', 'implementation', roundTitle('목록 API', 'h1', 2), 'FRONTEND'),
    item('q4', 'feature_spec', null, 'PM'),
    item('q5', 'implementation', roundTitle('목록 API', 'other', 1)),
  ];
  const report = {
    rows: [
      { questionId: 'q1', decisions: { 'baseline:asker': 'SELF', 'llm:pm': 'BACKEND', 'decision:v1': 'BACKEND' } },
      { questionId: 'q2', decisions: { 'baseline:asker': 'SELF', 'llm:pm': 'PM', 'decision:v1': null } },
    ],
  };

  it('단계별 수, 회차·태스크별 발생률, 라우터별 분포 — --run이면 그 실행만', () => {
    const r = buildHarvestReport({ dataset, report, tasks, run: 'h1' });
    expect(r.questions).toBe(5);
    expect(r.byStage).toEqual({ implementation: 4, feature_spec: 1 });
    expect(r.rounds).toEqual([
      { round: 1, tasks: 2, tasksWithQuestions: 1, questions: 2 },
      { round: 2, tasks: 2, tasksWithQuestions: 1, questions: 1 },
    ]);
    expect(r.perTask).toEqual([
      { title: '목록 API', rounds: 2, roundsWithQuestions: 1, questions: 1 },
      { title: '목록 화면', rounds: 2, roundsWithQuestions: 1, questions: 2 },
    ]);
    // 보고서 행이 있으면 primary·shadow 전부, 없으면(기록 전) primary만.
    expect(r.routers).toEqual({
      'baseline:asker': { SELF: 2 },
      'llm:pm': { BACKEND: 2, PM: 2, FRONTEND: 1 },
      'decision:v1': { BACKEND: 1, '(실패)': 1 },
    });
    const text = formatHarvestReport(r);
    expect(text).toContain('  r1: 2 / 1 = 50% / 2 / 1.00');
    expect(text).toContain('  목록 화면: 2 / 1 = 50% / 2 / 1.00');
  });

  it('--run이 없으면 꼬리표가 붙은 모든 실행을 회차 번호로 묶는다', () => {
    const r = buildHarvestReport({ dataset, report, tasks, run: null });
    expect(r.rounds[0]).toEqual({ round: 1, tasks: 3, tasksWithQuestions: 2, questions: 3 });
  });
});
