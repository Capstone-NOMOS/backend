import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { NomosClient } from '../src/bridge/nomos-client.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { signup } from '../src/domain/auth/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { clearPolicyCache } from '../src/domain/policy/policy-cache.js';
import { recomputeProjectPolicyHash } from '../src/domain/policy/policy-hash.js';
import { connectRepos } from '../src/domain/repo/service.js';
import {
  gitMirrorInspector,
  setCommitInspector,
  type CommitInspector,
} from '../src/domain/verification/commit-inspector.js';
import { githubInspector } from '../src/domain/verification/github-inspector.js';
import { assignRootOwner, createTestProject } from './fixtures.js';
import { reapplyFrom, resetSchema, rollbackFrom, testPool, truncateAll } from './test-db.js';

let server: Server;
let baseUrl: string;

// 커밋의 실제 diff를 무엇으로 읽을지만 바꿔 끼운다. 검증 로직은 그대로 돈다 —
// 여기서 git을 실제로 돌리면 테스트가 파일시스템 상태에 의존하게 된다.
const realInspector = gitMirrorInspector();

function fakeInspector(paths: string[] | Error): CommitInspector {
  return {
    kind: 'fake',
    async changedPaths() {
      if (paths instanceof Error) throw paths;
      return paths;
    },
  };
}

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

afterEach(() => {
  setCommitInspector(realInspector);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
  await testPool.end();
});

type Ctx = {
  orgId: string;
  projectId: string;
  agentId: string;
  repoId: string;
  taskId: string;
  specId: string;
  tokens: { accessToken: string; refreshToken: string };
};

async function setup(options: { cloneUrl?: string | null; loginId?: string } = {}): Promise<Ctx> {
  const { userId, connectKey } = await signup({
    loginId: options.loginId ?? 'minsu',
    password: 'correct-horse-battery',
    nickname: '민수',
  });
  const connected = await connectAgent({
    connectKey,
    agentName: 'laptop',
    harness: 'claude-code@2.1.263',
    skills: ['typescript'],
    maxConcurrent: 2,
  });
  const { orgId } = await createOrganization(userId, 'Acme Inc.');
  const [repo] = await connectRepos({ orgId, actorUserId: userId, repos: [{ fullName: 'acme/web' }] });
  const repoId = repo!.id;
  // 소유 역할은 상속된다. '**'를 정하지 않으면 기본 거부(B-2)로 제출이 전부 막힌다.
  await assignRootOwner(orgId, userId, repoId, 'BACKEND');

  // clone_url이 있어야 V3가 돈다. 없으면 SKIPPED로 기록되는 것이 정상 동작이다.
  await pool.query(`UPDATE repos SET clone_url = $2 WHERE id = $1`, [
    repoId,
    options.cloneUrl === undefined ? 'file:///demo/acme-web.git' : options.cloneUrl,
  ]);

  const projectId = await createTestProject({ orgId, userId });
  await pool.query(`INSERT INTO project_repos (project_id, repo_id) VALUES ($1, $2)`, [projectId, repoId]);
  await pool.query(`INSERT INTO project_members (project_id, agent_id, team_role) VALUES ($1, $2, 'BACKEND')`, [
    projectId,
    connected.agentId,
  ]);
  await pool.query(
    `INSERT INTO project_policies (project_id, action_key, mode, lock_key)
     SELECT $1, action_key, mode_l2, lock_key FROM action_catalog`,
    [projectId],
  );
  const spec = await pool.query(
    `INSERT INTO specs (project_id, feature_key, title, content)
     VALUES ($1, 'F-03', '참여 신청 API', 'WHEN 정원이 차면 THEN 409') RETURNING id`,
    [projectId],
  );
  const specId = spec.rows[0]!.id as string;
  const task = await pool.query(
    `INSERT INTO tasks (project_id, repo_id, spec_id, title, state, kind, team_role)
     VALUES ($1, $2, $3, 'T-042 참여신청 API', 'READY', 'IMPLEMENT', 'BACKEND') RETURNING id`,
    [projectId, repoId, specId],
  );

  await recomputeProjectPolicyHash(pool, projectId);
  const refreshed = await refreshAgentToken(connected.refreshToken);

  return {
    orgId,
    projectId,
    agentId: connected.agentId,
    repoId,
    taskId: task.rows[0]!.id as string,
    specId,
    tokens: { accessToken: refreshed.accessToken, refreshToken: connected.refreshToken },
  };
}

function clientFor(ctx: Ctx): NomosClient {
  return new NomosClient({ baseUrl, tokens: ctx.tokens });
}

type Submitted = { id: string; verification: { stages: { stage: string; result: string }[]; outcome: string } };

async function claimAndSubmit(ctx: Ctx, changedPaths: string[]): Promise<Submitted> {
  const client = clientFor(ctx);
  await client.claimTask(ctx.taskId);
  return (await client.submitArtifact(ctx.taskId, {
    commitSha: 'abc1234',
    changedPaths,
  })) as unknown as Submitted;
}

function resultOf(stages: { stage: string; result: string }[], stage: string): string | undefined {
  return stages.find((s) => s.stage === stage)?.result;
}

async function taskState(taskId: string): Promise<{ state: string; retry_count: number }> {
  const { rows } = await pool.query(`SELECT state, retry_count FROM tasks WHERE id = $1`, [taskId]);
  return rows[0] as { state: string; retry_count: number };
}

describe('V3 — 경로 검사 (server)', () => {
  it('신고한 경로와 실제 diff가 같고 규칙을 지키면 PASS다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['src/api/join.ts']));

    const { verification } = await claimAndSubmit(ctx, ['src/api/join.ts']);

    expect(resultOf(verification.stages, 'V3')).toBe('PASS');
  });

  it('실제로 바꿨는데 신고에서 뺀 파일이 있으면 FAIL이다 — V3가 존재하는 이유다', async () => {
    const ctx = await setup();
    // 모델이 .env도 고쳤지만 제출에서는 숨겼다. 제출 시점 3·4단계는 신고만 보므로 통과한다.
    setCommitInspector(fakeInspector(['src/api/join.ts', 'api/.env']));

    const { id, verification } = await claimAndSubmit(ctx, ['src/api/join.ts']);

    expect(resultOf(verification.stages, 'V3')).toBe('FAIL');
    const { rows } = await pool.query(
      `SELECT detail FROM verifications WHERE artifact_id = $1 AND stage = 'V3'`,
      [id],
    );
    expect(rows[0]!.detail).toMatchObject({ undeclared: ['api/.env'] });
  });

  it('안 바꿨는데 신고한 경로가 있어도 FAIL이다 — 감사 기록이 실제와 달라진다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['src/api/join.ts']));

    const { verification } = await claimAndSubmit(ctx, ['src/api/join.ts', 'src/api/list.ts']);

    expect(resultOf(verification.stages, 'V3')).toBe('FAIL');
  });

  it('신고와 diff가 같아도 실제 경로가 금지 규칙에 걸리면 FAIL이다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['api/.env']));

    // 제출 자체는 3·4단계에서 막히므로 여기까지 오지 않는다. 그 방어선을 확인한다.
    await expect(claimAndSubmit(ctx, ['api/.env'])).rejects.toThrow();
  });

  // 배포 설정(COMMIT_INSPECTOR=github)에서 대표가 GitHub를 아직 연결하지 않은 상태.
  // FAIL로 적으면 retry_count가 올라 에이전트가 자기 잘못이 아닌 일로 재시도를 잃는다.
  it('github 검사기에서 대표가 GitHub 미연결이면 SKIPPED이고 재시도 횟수는 그대로다', async () => {
    const ctx = await setup();
    // github_repo_id를 채우는 API가 아직 없어(연결 시 선택 입력) 직접 넣는다.
    await pool.query(`UPDATE repos SET github_repo_id = 987654321 WHERE id = $1`, [ctx.repoId]);
    const calls: string[] = [];
    setCommitInspector(
      githubInspector({
        db: pool,
        fetchImpl: async (url) => {
          calls.push(url);
          return new Response(null, { status: 500 });
        },
      }),
    );

    const { id, verification } = await claimAndSubmit(ctx, ['src/api/join.ts']);

    expect(resultOf(verification.stages, 'V3')).toBe('SKIPPED');
    expect(calls).toHaveLength(0);
    const { rows } = await pool.query(`SELECT detail FROM verifications WHERE artifact_id = $1 AND stage = 'V3'`, [id]);
    expect(rows[0]!.detail).toMatchObject({ reason: expect.stringContaining('GitHub 미연결'), inspector: 'github' });
    expect(await taskState(ctx.taskId)).toMatchObject({ state: 'VERIFYING', retry_count: 0 });
  });

  it('clone_url이 없으면 PASS가 아니라 SKIPPED이고 사유가 남는다', async () => {
    const ctx = await setup({ cloneUrl: null });

    const { id, verification } = await claimAndSubmit(ctx, ['src/api/join.ts']);

    expect(resultOf(verification.stages, 'V3')).toBe('SKIPPED');
    const { rows } = await pool.query(
      `SELECT detail FROM verifications WHERE artifact_id = $1 AND stage = 'V3'`,
      [id],
    );
    expect(String(rows[0]!.detail.reason)).toContain('clone_url');
  });

  it('없는 커밋은 FAIL, 서버 사정으로 못 읽은 것은 SKIPPED다', async () => {
    const ctx = await setup();
    const { CommitNotFoundError } = await import('../src/domain/verification/commit-inspector.js');
    setCommitInspector(fakeInspector(new CommitNotFoundError('abc1234')));

    const { verification } = await claimAndSubmit(ctx, ['src/api/join.ts']);
    expect(resultOf(verification.stages, 'V3')).toBe('FAIL');

    const other = await setup({ loginId: 'jisu' });
    setCommitInspector(fakeInspector(new Error('네트워크 끊김')));
    const second = await claimAndSubmit(other, ['src/api/join.ts']);
    expect(resultOf(second.verification.stages, 'V3')).toBe('SKIPPED');
  });
});

describe('V1A — 계약(OpenAPI) 대조', () => {
  it('지금은 SKIPPED이고, 사유는 LLM이 아니라 contracts 테이블이 없어서다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['src/api/join.ts']));

    const { id } = await claimAndSubmit(ctx, ['src/api/join.ts']);

    const { rows } = await pool.query(
      `SELECT result, executed_by, detail FROM verifications WHERE artifact_id = $1 AND stage = 'V1A'`,
      [id],
    );
    expect(rows[0]).toMatchObject({ result: 'SKIPPED', executed_by: 'server' });
    const reason = String(rows[0]!.detail.reason);
    expect(reason).toContain('contracts');
    // 회귀 방지: 이 단계는 응답 스키마·상태코드·필드명을 결정적으로 비교하는 자리다.
    // 사유가 "LLM 판정"으로 바뀌면 P2를 근거로 영원히 안 붙게 된다.
    expect(reason).not.toContain('LLM');
  });
});

describe('V1B — 실제 응답', () => {
  it('dev_base_url이 없으면 SKIPPED이고 사유가 남는다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['src/api/join.ts']));

    const { id } = await claimAndSubmit(ctx, ['src/api/join.ts']);

    const { rows } = await pool.query(
      `SELECT result, detail FROM verifications WHERE artifact_id = $1 AND stage = 'V1B'`,
      [id],
    );
    expect(rows[0]!.result).toBe('SKIPPED');
    expect(String(rows[0]!.detail.reason)).toContain('dev_base_url');
  });
});

describe('브릿지 단계 보고 (V2·V4)', () => {
  it('V2·V4가 다 들어오고 하나도 FAIL이 아니면 DONE이다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['src/api/join.ts']));
    const { id } = await claimAndSubmit(ctx, ['src/api/join.ts']);
    const client = clientFor(ctx);

    expect(await taskState(ctx.taskId)).toMatchObject({ state: 'VERIFYING' });

    // 잠긴 시험지가 산출물보다 먼저 있어야 V2 PASS가 유지된다.
    await pool.query(
      `INSERT INTO spec_tests (spec_id, criterion, test_code, locked_at)
       VALUES ($1, '정원 초과는 409', 'expect(1).toBe(1)', now() - interval '1 hour')`,
      [ctx.specId],
    );

    await client.reportVerification(id, { stage: 'V2', result: 'PASS', detail: {} });
    // 아직 V4가 없으므로 끝나지 않는다.
    expect(await taskState(ctx.taskId)).toMatchObject({ state: 'VERIFYING' });

    const summary = (await client.reportVerification(id, {
      stage: 'V4',
      result: 'PASS',
      detail: { command: 'npm run lint' },
    })) as unknown as { outcome: string; taskState: string };

    expect(summary).toMatchObject({ outcome: 'DONE', taskState: 'DONE' });
  });

  it('gateMode가 AUTO가 아니면 AWAITING_APPROVAL이고, 나올 경로가 없다는 안내가 함께 남는다', async () => {
    const ctx = await setup();
    // L2에서 db:migration은 HUMAN이다. V3가 PASS하려면 실제 diff도 같아야 한다.
    setCommitInspector(fakeInspector(['migrations/013_x.sql']));
    const { id } = await claimAndSubmit(ctx, ['migrations/013_x.sql']);
    const client = clientFor(ctx);

    await pool.query(
      `INSERT INTO spec_tests (spec_id, criterion, test_code, locked_at)
       VALUES ($1, '정원 초과는 409', 'expect(1).toBe(1)', now() - interval '1 hour')`,
      [ctx.specId],
    );
    await client.reportVerification(id, { stage: 'V2', result: 'PASS', detail: {} });
    const summary = (await client.reportVerification(id, {
      stage: 'V4',
      result: 'PASS',
      detail: { command: 'npm run lint' },
    })) as unknown as { outcome: string; taskState: string; notice?: string };

    expect(summary).toMatchObject({ outcome: 'AWAITING_APPROVAL', taskState: 'AWAITING_APPROVAL' });

    // 승인 API가 없어서 태스크는 여기서 멈춘다. 조용히 멈추면 로그에서 원인을 찾을 수 없으므로
    // 제출 응답과 이벤트 payload 양쪽에 같은 안내가 남아야 한다.
    expect(summary.notice).toContain('승인 경로 미구현');
    const { rows } = await pool.query(
      `SELECT payload FROM events WHERE type = 'VERIFICATION_COMPLETED' ORDER BY id DESC LIMIT 1`,
    );
    expect((rows[0]!.payload as { notice?: string }).notice).toContain('승인 경로 미구현');
  });

  it('SKIPPED도 "보고됨"으로 세지만 PASS로 기록되지는 않는다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['src/api/join.ts']));
    const { id } = await claimAndSubmit(ctx, ['src/api/join.ts']);
    const client = clientFor(ctx);

    await client.reportVerification(id, {
      stage: 'V2',
      result: 'SKIPPED',
      detail: { reason: '작업공간에 vitest가 설치돼 있지 않다' },
    });
    await client.reportVerification(id, {
      stage: 'V4',
      result: 'SKIPPED',
      detail: { reason: 'package.json에 lint 스크립트가 없다' },
    });

    expect(await taskState(ctx.taskId)).toMatchObject({ state: 'DONE' });
    const { rows } = await pool.query(
      `SELECT result, count(*)::int AS n FROM verifications WHERE artifact_id = $1 GROUP BY result`,
      [id],
    );
    const byResult = Object.fromEntries(rows.map((r) => [r.result, r.n]));
    // V1A·V1B·V2·V4가 SKIPPED, V3만 PASS. SKIPPED가 PASS로 새지 않았다.
    expect(byResult).toEqual({ SKIPPED: 4, PASS: 1 });
  });

  it('사유 없는 SKIPPED는 받지 않는다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['src/api/join.ts']));
    const { id } = await claimAndSubmit(ctx, ['src/api/join.ts']);

    await expect(
      clientFor(ctx).reportVerification(id, { stage: 'V2', result: 'SKIPPED', detail: {} }),
    ).rejects.toThrow(/reason/);
  });

  it('서버가 판정하는 단계는 브릿지가 보고할 수 없다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['src/api/join.ts']));
    const { id } = await claimAndSubmit(ctx, ['src/api/join.ts']);

    await expect(
      clientFor(ctx).reportVerification(id, {
        stage: 'V3' as 'V2',
        result: 'PASS',
        detail: {},
      }),
    ).rejects.toThrow();
  });

  it('같은 단계를 두 번 보고하면 409 — FAIL을 PASS로 갈아치울 수 없다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['src/api/join.ts']));
    const { id } = await claimAndSubmit(ctx, ['src/api/join.ts']);
    const client = clientFor(ctx);

    await client.reportVerification(id, { stage: 'V4', result: 'FAIL', detail: { exitCode: 1 } });
    await expect(
      client.reportVerification(id, { stage: 'V4', result: 'PASS', detail: {} }),
    ).rejects.toThrow();
  });

  it('산출물보다 늦게 잠긴 시험지의 PASS는 서버가 FAIL로 뒤집는다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['src/api/join.ts']));
    const { id } = await claimAndSubmit(ctx, ['src/api/join.ts']);

    // 산출물이 생긴 뒤에 잠근 시험지 — 결과를 보고 맞췄을 수 있다.
    await pool.query(
      `INSERT INTO spec_tests (spec_id, criterion, test_code, locked_at)
       VALUES ($1, '나중에 잠근 기준', 'expect(1).toBe(1)', now() + interval '1 hour')`,
      [ctx.specId],
    );

    await clientFor(ctx).reportVerification(id, { stage: 'V2', result: 'PASS', detail: {} });

    const { rows } = await pool.query(
      `SELECT result, detail FROM verifications WHERE artifact_id = $1 AND stage = 'V2'`,
      [id],
    );
    expect(rows[0]!.result).toBe('FAIL');
    expect(String(rows[0]!.detail.reason)).toContain('늦게 잠긴');
  });
});

describe('FAIL 이후 — 재시도와 에스컬레이션', () => {
  it('FAIL이면 READY로 돌아가고 담당이 비워지며 retry_count가 오른다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['src/api/join.ts', 'api/.env']));

    await claimAndSubmit(ctx, ['src/api/join.ts']);

    const { rows } = await pool.query(
      `SELECT state, retry_count, assignee_agent_id FROM tasks WHERE id = $1`,
      [ctx.taskId],
    );
    expect(rows[0]).toMatchObject({ state: 'READY', retry_count: 1, assignee_agent_id: null });
  });

  it('3회째 FAIL이면 ESCALATED로 멈춘다 — 자동 재시도는 없다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['src/api/join.ts', 'api/.env']));

    await claimAndSubmit(ctx, ['src/api/join.ts']);
    expect(await taskState(ctx.taskId)).toMatchObject({ state: 'READY', retry_count: 1 });
    await claimAndSubmit(ctx, ['src/api/join.ts']);
    expect(await taskState(ctx.taskId)).toMatchObject({ state: 'READY', retry_count: 2 });
    await claimAndSubmit(ctx, ['src/api/join.ts']);
    expect(await taskState(ctx.taskId)).toMatchObject({ state: 'ESCALATED', retry_count: 3 });
  });

  it('결론이 난 뒤 늦게 도착한 보고는 retry_count를 두 번 올리지 않는다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['src/api/join.ts', 'api/.env']));
    const { id } = await claimAndSubmit(ctx, ['src/api/join.ts']);
    expect(await taskState(ctx.taskId)).toMatchObject({ retry_count: 1 });

    // 이 산출물은 이미 결론이 났다. 담당이 비워졌으므로 보고 자체가 거부된다.
    await expect(
      clientFor(ctx).reportVerification(id, { stage: 'V4', result: 'FAIL', detail: {} }),
    ).rejects.toThrow();
    expect(await taskState(ctx.taskId)).toMatchObject({ retry_count: 1 });
  });

  it('VERIFICATION_COMPLETED 이벤트에 단계별 결과가 그대로 남는다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['src/api/join.ts']));

    await claimAndSubmit(ctx, ['src/api/join.ts']);

    const { rows } = await pool.query(
      `SELECT payload FROM events WHERE type = 'VERIFICATION_COMPLETED' ORDER BY ts`,
    );
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as { stages: { stage: string; result: string }[]; outcome: string };
    expect(payload.outcome).toBe('PENDING');
    expect(payload.stages).toEqual(
      expect.arrayContaining([
        { stage: 'V1A', result: 'SKIPPED' },
        { stage: 'V1B', result: 'SKIPPED' },
        { stage: 'V3', result: 'PASS' },
      ]),
    );
  });
});

describe('012_verifications', () => {
  it('SKIPPED는 사유 없이 저장할 수 없다', async () => {
    const ctx = await setup();
    setCommitInspector(fakeInspector(['src/api/join.ts']));
    const { id } = await claimAndSubmit(ctx, ['src/api/join.ts']);

    // 앱을 우회해 직접 넣어도 DB가 막는다. 사유 없는 SKIPPED는 나중에 PASS와 구분되지 않는다.
    await expect(
      pool.query(
        `INSERT INTO verifications (artifact_id, stage, result, executed_by, detail)
         VALUES ($1, 'INTEGRATION', 'SKIPPED', 'server', '{}'::jsonb)`,
        [id],
      ),
    ).rejects.toThrow(/verifications_skip_reason_chk/);
  });

  it('down 후 다시 up 할 수 있다', async () => {
    const hasTable = async () =>
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'verifications'`,
        )
      ).rows[0]!.n === 1;

    await rollbackFrom('012_verifications.sql');
    expect(await hasTable()).toBe(false);

    await reapplyFrom('012_verifications.sql');
    expect(await hasTable()).toBe(true);
  });
});
