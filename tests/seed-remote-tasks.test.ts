import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
        // locked는 필수다 — 빠뜨리면 조용히 false가 되어 V2가 근거 없이 돌던 것을 막는다.
        { criterion: '초안', testCode: 'expect(2).toBe(2)', locked: false },
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
    // 들여오기도 API와 같은 이벤트를 항목마다 남긴다(source='import'). 예전의 묶음 요약 TASKS_IMPORTED는 더 이상 없다.
    events: await n(`SELECT count(*)::int AS n FROM events WHERE type IN ('SPEC_CREATED', 'TASK_CREATED')`),
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

    expect(await counts()).toMatchObject({ specs: 1, tests: 2, tasks: 2, deps: 1, events: 3 });
    const tasks = await pool.query(`SELECT title, state, team_role, kind, spec_id FROM tasks ORDER BY title`);
    expect(tasks.rows.map((r) => [r.title, r.state, r.team_role, r.kind])).toEqual([
      ['T-051 대기열 API', 'READY', 'BACKEND', 'IMPLEMENT'],
      ['T-052 대기열 버튼', 'READY', 'FRONTEND', 'IMPLEMENT'],
    ]);
    expect(tasks.rows.every((r) => r.spec_id === result.specIds[0])).toBe(true);
    // 잠근 시험지만 locked_at이 있다 — 잠기지 않은 초안은 에이전트에게 내려가지 않는다.
    const locked = await pool.query(`SELECT criterion FROM spec_tests WHERE locked_at IS NOT NULL`);
    expect(locked.rows.map((r) => r.criterion)).toEqual(['202를 준다']);
    const events = await pool.query(
      `SELECT type, on_behalf_of, payload FROM events WHERE type IN ('SPEC_CREATED', 'TASK_CREATED') ORDER BY id`,
    );
    expect(events.rows.map((e) => [e.type, e.on_behalf_of, e.payload.source])).toEqual([
      ['SPEC_CREATED', userId, 'import'],
      ['TASK_CREATED', userId, 'import'],
      ['TASK_CREATED', userId, 'import'],
    ]);
    expect(events.rows[0]!.payload).toMatchObject({ testCount: 2, lockedTestCount: 1 });
    expect(result.dependencyCount).toBe(1);
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

  // 구조적 안전장치: 이 도구가 도는 코드(스크립트 + domain/authoring 폴더 **전체**)의 SQL에는 INSERT·SELECT만 있다.
  // 파일 목록이 아니라 폴더로 보는 이유: 폴더에 새 파일이 생겨도 빠지지 않게. 누가 "정리" 기능을 끼워 넣으면 여기서 깨진다.
  // 예외는 행 잠금 절(FOR NO KEY UPDATE) 하나 — 데이터를 바꾸지 않는다.
  it('SQL은 INSERT·SELECT뿐이다 — 지우거나 고치는 문장이 없다', () => {
    const dir = new URL('../src/domain/authoring/', import.meta.url);
    const files = [
      new URL('../scripts/lib/import-tasks.ts', import.meta.url),
      ...readdirSync(dir)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => new URL(f, dir)),
    ];
    expect(files.length).toBeGreaterThan(4);
    const sql = files
      .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/`([^`]*)`/g)].map((m) => m[1]!))
      .map((s) => s.replace(/\bFOR NO KEY UPDATE\b/gi, ''))
      .filter((s) => /\b(SELECT|INSERT)\b/i.test(s) || /\b(DELETE|UPDATE|TRUNCATE|DROP|ALTER)\b/i.test(s));
    expect(sql.length).toBeGreaterThan(8);
    for (const statement of sql) {
      expect(statement, statement).not.toMatch(/\b(DELETE|UPDATE|TRUNCATE|DROP|ALTER)\b/i);
    }
  });

  // 운영자 노트북에는 서버 비밀값(JWT_SECRET 등)이 없다. 이 스크립트가 직접이든 간접이든 src/config/env.ts를
  // 끌고 오면 거기서 죽는다. 사람이 눈으로 지키기 어려운 규칙이라 실제로 띄워 본다.
  // 레포 루트에서 띄우면 로컬 .env가 빈칸을 채워 통과해 버린다 — 빈 임시 폴더에서, 서버 변수를 지운 채 띄운다.
  it('서버 설정 없이 뜬다 — env.ts를 끌고 오지 않는다', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'nomos-seed-tasks-'));
    const script = fileURLToPath(new URL('../scripts/seed-remote-tasks.ts', import.meta.url));
    const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'development' };
    // 인자 없이 띄우면 모듈을 전부 불러온 뒤 사용법을 찍고 코드 2로 끝난다.
    const run = spawnSync(process.execPath, [tsx, script], { cwd, env, encoding: 'utf8' });
    expect(run.stderr).toContain('사용법');
    expect(run.stderr).not.toMatch(/JWT_SECRET|Invalid environment|is required/i);
    expect(run.status).toBe(2);
  });
});
