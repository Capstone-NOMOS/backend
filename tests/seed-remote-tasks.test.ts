import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyImport, ImportRefused, planImport, type ImportDoc } from '../scripts/lib/import-tasks.js';
import { pool } from '../src/config/db.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { assignRootOwner, createTestOrg, createTestUser } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

beforeAll(async () => {
  await resetSchema();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await pool.end();
  await testPool.end();
});

// 실제 온보딩으로 만든 프로젝트 — 들여오기는 "이미 있는 프로젝트"에 한다.
async function project() {
  const { userId, orgId } = await createTestOrg('rep');
  const repos = await connectRepos({
    orgId,
    actorUserId: userId,
    repos: [{ fullName: 'acme/study-api' }, { fullName: 'acme/study-web' }, { fullName: 'acme/unlinked' }],
  });
  await assignRootOwner(orgId, userId, repos[0]!.id, 'BACKEND');
  await assignRootOwner(orgId, userId, repos[1]!.id, 'FRONTEND');
  const { project: p } = await createProject(orgId, userId, {
    name: 'p1',
    autonomyPreset: 'L2',
    pmBudgetUsd: 40,
    repoIds: [repos[0]!.id, repos[1]!.id],
  });
  return { userId, orgId, projectId: p.id };
}

const DOC: ImportDoc = {
  specs: [
    {
      featureKey: 'F-05',
      title: '대기열 신청',
      content: 'WHEN 정원이 차면 THEN 대기열에 올린다',
      tests: [
        { criterion: '202를 준다', testCode: 'expect(1).toBe(1)', locked: true },
        { criterion: '초안', testCode: 'expect(2).toBe(2)' },
      ],
    },
  ],
  tasks: [
    { ref: 'api', title: 'T-051 대기열 API', repo: 'acme/study-api', teamRole: 'BACKEND', spec: 'F-05' },
    { ref: 'web', title: 'T-052 대기열 버튼', repo: 'acme/study-web', teamRole: 'FRONTEND', spec: 'F-05', dependsOn: ['api'] },
  ],
};

async function counts() {
  const n = async (sql: string) => (await pool.query(sql)).rows[0]!.n as number;
  return {
    specs: await n(`SELECT count(*)::int AS n FROM specs`),
    tests: await n(`SELECT count(*)::int AS n FROM spec_tests`),
    tasks: await n(`SELECT count(*)::int AS n FROM tasks`),
    deps: await n(`SELECT count(*)::int AS n FROM task_deps`),
    events: await n(`SELECT count(*)::int AS n FROM events WHERE type = 'TASKS_IMPORTED'`),
  };
}

async function run(input: { projectId: string; asLoginId?: string; doc?: unknown }) {
  const client = await pool.connect();
  try {
    const plan = await planImport(client, { projectId: input.projectId, asLoginId: input.asLoginId ?? 'rep', doc: input.doc ?? DOC });
    return await applyImport(client, plan);
  } finally {
    client.release();
  }
}

async function refusal(promise: Promise<unknown>): Promise<string[]> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ImportRefused);
  return (err as ImportRefused).problems;
}

describe('seed-remote-tasks', () => {
  it('계획만 세우면(dry-run) 아무것도 쓰지 않는다', async () => {
    const { projectId } = await project();
    const before = await counts();

    const client = await pool.connect();
    const plan = await planImport(client, { projectId, asLoginId: 'rep', doc: DOC }).finally(() => client.release());

    expect(plan.tasks.map((t) => t.ref)).toEqual(['api', 'web']);
    expect(await counts()).toEqual(before);
  });

  it('명세·시험지·태스크·선행 관계를 넣고, 대표 명의 이벤트를 남긴다 — 태스크는 READY', async () => {
    const { projectId, userId } = await project();

    const result = await run({ projectId });

    expect(await counts()).toMatchObject({ specs: 1, tests: 2, tasks: 2, deps: 1, events: 1 });
    const tasks = await pool.query(`SELECT title, state, team_role, kind, spec_id FROM tasks ORDER BY title`);
    expect(tasks.rows.map((r) => [r.title, r.state, r.team_role, r.kind])).toEqual([
      ['T-051 대기열 API', 'READY', 'BACKEND', 'IMPLEMENT'],
      ['T-052 대기열 버튼', 'READY', 'FRONTEND', 'IMPLEMENT'],
    ]);
    expect(tasks.rows.every((r) => r.spec_id === result.specIds[0])).toBe(true);
    // 잠근 시험지만 locked_at이 있다 — 잠기지 않은 초안은 에이전트에게 내려가지 않는다.
    const locked = await pool.query(`SELECT criterion FROM spec_tests WHERE locked_at IS NOT NULL`);
    expect(locked.rows.map((r) => r.criterion)).toEqual(['202를 준다']);
    const event = await pool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'TASKS_IMPORTED'`);
    expect(event.rows[0]).toMatchObject({
      on_behalf_of: userId,
      payload: { source: 'seed-remote-tasks', specTestCount: 2, dependencyCount: 1 },
    });
  });

  it('같은 파일을 다시 돌리면 중복으로 거부하고 아무것도 늘지 않는다', async () => {
    const { projectId } = await project();
    await run({ projectId });
    const before = await counts();

    const problems = await refusal(run({ projectId }));
    expect(problems.join('\n')).toMatch(/F-05.*이미 있다/);
    expect(problems.join('\n')).toMatch(/T-051.*이미 있다/);
    expect(await counts()).toEqual(before);
  });

  it('틀린 곳을 하나씩이 아니라 전부 모아서 알려주고, 아무것도 쓰지 않는다', async () => {
    const { projectId } = await project();

    const problems = await refusal(
      run({
        projectId,
        doc: {
          tasks: [
            { ref: 'a', title: 'A', repo: 'acme/unlinked', dependsOn: ['b'] }, // 프로젝트에 없는 레포
            { ref: 'b', title: 'B', repo: 'acme/study-api', spec: 'F-99', dependsOn: ['a'] }, // 없는 명세, 순환
            { ref: 'c', title: 'C', repo: 'acme/study-api', dependsOn: ['ghost'] }, // 없는 의존
          ],
        },
      }),
    );

    const all = problems.join('\n');
    expect(all).toContain('acme/unlinked는 이 프로젝트에 연결돼 있지 않다');
    expect(all).toContain('명세 F-99가');
    expect(all).toContain('의존 순환');
    expect(all).toContain('ghost');
    expect(await counts()).toMatchObject({ specs: 0, tasks: 0, deps: 0, events: 0 });
  });

  it('이미 있는 명세와 태스크를 가리킬 수 있다', async () => {
    const { projectId } = await project();
    await run({ projectId });
    const api = (await pool.query(`SELECT id FROM tasks WHERE title = 'T-051 대기열 API'`)).rows[0]!.id as string;

    await run({
      projectId,
      doc: { tasks: [{ ref: 'it', title: 'T-053 통합', repo: 'acme/study-api', kind: 'INTEGRATION', spec: 'F-05', dependsOn: [api] }] },
    });

    const row = (await pool.query(`SELECT team_role, kind FROM tasks WHERE title = 'T-053 통합'`)).rows[0]!;
    expect(row).toEqual({ team_role: null, kind: 'INTEGRATION' });
    expect((await counts()).deps).toBe(2);
  });

  it('그 조직의 대표가 아니면 거부한다 — 엉뚱한 사람·DB로 쓰지 않는다', async () => {
    const { projectId, orgId, userId } = await project();
    const member = await createTestUser('member');
    const invite = await createInvite(orgId, userId, { teamRole: 'BACKEND' });
    await acceptInvite(invite.token, member);

    expect((await refusal(run({ projectId, asLoginId: 'member' })))[0]).toContain('대표가 아니다');
    expect((await refusal(run({ projectId: '00000000-0000-4000-8000-000000000000' })))[0]).toContain('없다');
  });

  // 이 도구의 목적은 운영 DB에 쓰는 것이다. 운영 표시로 막히면 안 되고, 안전은 표시가 아니라 구조에서 와야 한다.
  it('운영 표시가 있는 DB에서도 동작한다 — 표시에 기대지 않는다', async () => {
    const { projectId } = await project();
    const client = await pool.connect();
    try {
      await client.query(`SET nomos.environment = 'production'`);
      const plan = await planImport(client, { projectId, asLoginId: 'rep', doc: DOC });
      await expect(applyImport(client, plan)).resolves.toMatchObject({ taskIds: expect.any(Array) });
    } finally {
      await client.query('RESET nomos.environment');
      client.release();
    }
  });

  // 구조적 안전장치: 이 모듈의 SQL에는 INSERT·SELECT만 있다. 누가 "정리" 기능을 끼워 넣으면 여기서 깨진다.
  it('SQL은 INSERT·SELECT뿐이다 — 지우거나 고치는 문장이 없다', () => {
    const source = readFileSync(new URL('../scripts/lib/import-tasks.ts', import.meta.url), 'utf8');
    const sql = [...source.matchAll(/`([^`]*)`/g)].map((m) => m[1]!).filter((s) => /\b(SELECT|INSERT)\b/i.test(s) || /\b(DELETE|UPDATE|TRUNCATE|DROP|ALTER)\b/i.test(s));
    expect(sql.length).toBeGreaterThan(5);
    for (const statement of sql) {
      expect(statement, statement).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE|DROP|ALTER)\b/i);
    }
  });
});
