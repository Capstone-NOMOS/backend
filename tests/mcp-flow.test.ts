import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { NomosClient, PolicyStaleLoopError } from '../src/bridge/nomos-client.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { clearPolicyCache } from '../src/domain/policy/policy-cache.js';
import { recomputeProjectPolicyHash } from '../src/domain/policy/policy-hash.js';
import { connectRepos, updatePathOwnership } from '../src/domain/repo/service.js';
import { env } from '../src/config/env.js';
import { signJwt } from '../src/utils/tokens.js';
import { assignRootOwner, createTestProject } from './fixtures.js';
import { expectDenied } from './helpers/assert-denied.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await resetSchema();
  // 포트 0 = OS가 빈 포트를 고른다. 테스트가 서로 포트를 다투지 않는다.
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await truncateAll();
  clearPolicyCache();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
  await testPool.end();
});

type Ctx = {
  userId: string;
  orgId: string;
  projectId: string;
  agentId: string;
  repoId: string;
  taskId: string;
  tokens: { accessToken: string; refreshToken: string };
};

// 실제 온보딩 순서 그대로: 가입 → CLI 연결 → 조직 → 레포 → 프로젝트 배정 → 토큰 재발급.
// 연결 시점에는 아직 프로젝트가 없으므로 토큰에 project_id가 없다. 배정 후 refresh해야 채워진다.
// rootOwner: '**'의 소유 역할. 기본은 에이전트 역할 — 온보딩을 끝낸 레포다. 소유 역할은 상속되므로
// 이걸 정하지 않으면 기본 거부(B-2)로 아무 경로에도 쓸 수 없다.
async function setup(
  teamRole: 'BACKEND' | 'FRONTEND' = 'BACKEND',
  // null이면 소유자를 지정하지 않는다 — 온보딩을 빠뜨린 레포(기본 거부)
  rootOwner: 'BACKEND' | 'FRONTEND' | null = teamRole,
): Promise<Ctx> {
  const { userId, connectKey } = await signup({
    loginId: 'minsu',
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
  if (rootOwner !== null) await assignRootOwner(orgId, userId, repoId, rootOwner);

  // 아래 네 테이블은 아직 서비스 함수가 없다 (Phase 2 스키마). 그래서 직접 INSERT한다.
  const projectId = await createTestProject({ orgId, userId });
  await pool.query(`INSERT INTO project_repos (project_id, repo_id) VALUES ($1, $2)`, [projectId, repoId]);
  await pool.query(`INSERT INTO project_members (project_id, agent_id, team_role) VALUES ($1, $2, $3)`, [
    projectId,
    connected.agentId,
    teamRole,
  ]);
  await pool.query(
    `INSERT INTO project_policies (project_id, action_key, mode, lock_key)
     SELECT $1, action_key, mode_l2, lock_key FROM action_catalog`,
    [projectId],
  );
  const { rows } = await pool.query(
    `INSERT INTO tasks (project_id, repo_id, title, state, kind, team_role)
     VALUES ($1, $2, 'T-042 참여신청 API', 'READY', 'IMPLEMENT', $3) RETURNING id`,
    [projectId, repoId, teamRole],
  );

  await recomputeProjectPolicyHash(pool, projectId);
  // 프로젝트에 들어간 뒤 재발급해야 토큰에 project_id·policy_hash가 담긴다.
  const refreshed = await refreshAgentToken(connected.refreshToken);

  return {
    userId,
    orgId,
    projectId,
    agentId: connected.agentId,
    repoId,
    taskId: rows[0]!.id,
    tokens: { accessToken: refreshed.accessToken, refreshToken: connected.refreshToken },
  };
}

function clientFor(ctx: Ctx, fetchImpl?: typeof fetch): NomosClient {
  return new NomosClient({ baseUrl, tokens: ctx.tokens, fetchImpl });
}

async function pathIdOf(repoId: string, pattern: string): Promise<string> {
  const { rows } = await pool.query(`SELECT id FROM repo_paths WHERE repo_id = $1 AND path_pattern = $2`, [
    repoId,
    pattern,
  ]);
  return rows[0]!.id as string;
}

describe('claim_task', () => {
  it('READY 태스크를 잡으면 CLAIMED가 되고 이벤트가 남는다', async () => {
    const ctx = await setup();

    const task = await clientFor(ctx).claimTask(ctx.taskId);

    expect(task).toMatchObject({ state: 'CLAIMED', assigneeAgentId: ctx.agentId });
    const { rows } = await pool.query(`SELECT payload FROM events WHERE type = 'TASK_CLAIMED'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ taskId: ctx.taskId, teamRole: 'BACKEND' });
  });

  it('이미 잡힌 태스크는 409 — 경합에서 진 쪽이 받는 답이다', async () => {
    const ctx = await setup();
    await clientFor(ctx).claimTask(ctx.taskId);

    await expect(clientFor(ctx).claimTask(ctx.taskId)).rejects.toMatchObject({
      status: 409,
      code: 'TASK_ALREADY_CLAIMED',
    });
  });

  it('동시에 잡으면 정확히 하나만 성공한다', async () => {
    const ctx = await setup();

    const results = await Promise.allSettled([
      clientFor(ctx).claimTask(ctx.taskId),
      clientFor(ctx).claimTask(ctx.taskId),
      clientFor(ctx).claimTask(ctx.taskId),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('다른 역할의 태스크는 403', async () => {
    const ctx = await setup('BACKEND');
    await pool.query(`UPDATE tasks SET team_role = 'FRONTEND' WHERE id = $1`, [ctx.taskId]);

    await expect(clientFor(ctx).claimTask(ctx.taskId)).rejects.toMatchObject({
      status: 403,
      code: 'TASK_ROLE_MISMATCH',
    });
    const { rows } = await pool.query(`SELECT payload FROM events WHERE type = 'TOOL_DENIED'`);
    expect(rows[0]!.payload).toMatchObject({ stage: 'membership', actionKey: 'task:claim' });
  });

  it('선행 태스크가 DONE이 아니면 409', async () => {
    const ctx = await setup();
    const { rows } = await pool.query(
      `INSERT INTO tasks (project_id, repo_id, title, state, kind) VALUES ($1, $2, '선행', 'READY', 'IMPLEMENT')
       RETURNING id`,
      [ctx.projectId, ctx.repoId],
    );
    await pool.query(`INSERT INTO task_deps (task_id, depends_on) VALUES ($1, $2)`, [ctx.taskId, rows[0]!.id]);

    await expect(clientFor(ctx).claimTask(ctx.taskId)).rejects.toMatchObject({ code: 'TASK_DEPS_NOT_DONE' });

    await pool.query(`UPDATE tasks SET state = 'DONE' WHERE id = $1`, [rows[0]!.id]);
    await expect(clientFor(ctx).claimTask(ctx.taskId)).resolves.toMatchObject({ state: 'CLAIMED' });
  });
});

describe('submit_artifact', () => {
  async function claimed(ctx: Ctx): Promise<NomosClient> {
    const client = clientFor(ctx);
    await client.claimTask(ctx.taskId);
    return client;
  }

  it('제출하면 판정이 artifacts에 고정되고 태스크가 VERIFYING으로 간다', async () => {
    const ctx = await setup();
    const client = await claimed(ctx);

    const artifact = await client.submitArtifact(ctx.taskId, {
      commitSha: 'a1b2c3d4e5f6',
      changedPaths: ['src/index.ts', 'tests/index.test.ts'],
    });

    expect(artifact).toMatchObject({ attempt: 1, gateMode: 'AUTO' });
    // ** → code:own_path, tests/** → test:write, 그리고 제출 자체.
    expect(artifact.triggeredActions).toEqual(['artifact:submit', 'code:own_path', 'test:write']);

    const { rows } = await pool.query(`SELECT state FROM tasks WHERE id = $1`, [ctx.taskId]);
    expect(rows[0]!.state).toBe('VERIFYING');
  });

  it('여러 칸에 걸리면 가장 엄격한 판정이 이긴다', async () => {
    const ctx = await setup();
    const client = await claimed(ctx);

    // L2에서 db:migration은 HUMAN, code:own_path는 AUTO.
    const artifact = await client.submitArtifact(ctx.taskId, {
      commitSha: 'a1b2c3d4e5f6',
      changedPaths: ['src/index.ts', 'migrations/010_x.sql'],
    });

    expect(artifact.gateMode).toBe('HUMAN');
    expect(artifact.triggeredActions).toContain('db:migration');
  });

  it('비밀 파일은 제출 시점에도 막힌다 — 로컬 편집기로 고쳤어도', async () => {
    const ctx = await setup();
    const client = await claimed(ctx);

    // 거부 이벤트는 남고 artifacts에는 행이 생기지 않아야 한다.
    const denial = await expectDenied(
      client.submitArtifact(ctx.taskId, { commitSha: 'a1b2c3d4e5f6', changedPaths: ['api/.env'] }),
      { code: 'FORBIDDEN_PATH', stage: 'forbidden_path', emptyTables: ['artifacts'] },
    );
    expect(denial.payload).toMatchObject({ actionKey: 'artifact:submit' });
    expect(denial.pathViolation).toBe(false);
  });

  it('남의 소유 경로를 제출하면 403이고 path_violation이 남는다', async () => {
    const ctx = await setup('BACKEND');
    const client = await claimed(ctx);
    await pool.query(`UPDATE repo_paths SET owner_role = 'FRONTEND' WHERE repo_id = $1 AND path_pattern = '**'`, [
      ctx.repoId,
    ]);
    await recomputeProjectPolicyHash(pool, ctx.projectId);
    clearPolicyCache();

    const denial = await expectDenied(
      client.submitArtifact(ctx.taskId, { commitSha: 'a1b2c3d4e5f6', changedPaths: ['src/index.ts'] }),
      { code: 'SCOPE_DENIED', stage: 'ownership', emptyTables: ['artifacts'] },
    );
    expect(denial.pathViolation).toBe(true);
  });

  // B-2 복구의 확인 시나리오. tests/**는 owner가 NULL인 시드 행이다 — 예전에는 NULL을 "누구나"로 읽어
  // FE 에이전트가 BACKEND 레포의 테스트를 고칠 수 있었다. 이제 '**'의 소유 역할을 물려받아 막힌다.
  it("'**'=BACKEND 레포에서 FE 에이전트가 tests/foo.ts를 내면 거부되고 path_violation이 남는다", async () => {
    const ctx = await setup('FRONTEND', 'BACKEND');
    const client = await claimed(ctx);

    const denial = await expectDenied(
      client.submitArtifact(ctx.taskId, { commitSha: 'a1b2c3d4e5f6', changedPaths: ['tests/foo.ts'] }),
      { code: 'SCOPE_DENIED', stage: 'ownership', emptyTables: ['artifacts'] },
    );
    expect(denial.pathViolation).toBe(true); // M5′ 집계가 읽는 열
    expect(denial.ownerRole).toBe('BACKEND'); // 물려받은 소유 역할
    expect(denial.payload).toMatchObject({ path: 'tests/foo.ts', memberRole: 'FRONTEND', reason: 'owned_by_other' });
  });

  // 소유자 없음은 에이전트 잘못이 아니다(온보딩 누락). M5′ 분자(path_violation)에는 넣지 않되,
  // "온보딩 소유권 지정 누락"으로 따로 셀 수 있어야 한다 — detail 문구가 아니라 구조화된 reason으로.
  it('소유자가 없는 레포에 내면 거부되고 reason=unowned — M5′와 따로 셀 수 있다', async () => {
    const ctx = await setup('BACKEND', null);
    const client = await claimed(ctx);

    const denial = await expectDenied(
      client.submitArtifact(ctx.taskId, { commitSha: 'a1b2c3d4e5f6', changedPaths: ['src/index.ts'] }),
      { code: 'SCOPE_DENIED', stage: 'ownership', emptyTables: ['artifacts'] },
    );
    expect(denial).toMatchObject({ pathViolation: false, ownerRole: null, payload: { reason: 'unowned' } });

    // 두 지표를 실제 집계 쿼리로 가른다.
    const metric = async (where: string) =>
      (await pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'TOOL_DENIED' AND ${where}`)).rows[0]!.n;
    expect(await metric(`payload->>'reason' = 'unowned'`)).toBe(1); // 온보딩 소유권 지정 누락
    expect(await metric(`path_violation = true`)).toBe(0); // M5′ 분자에는 들어가지 않는다
  });

  it('같은 레포의 BE 에이전트는 물려받은 소유권으로 tests/foo.ts를 낼 수 있다 — 행동 키는 test:write', async () => {
    const ctx = await setup('BACKEND', 'BACKEND');
    const client = await claimed(ctx);

    const artifact = await client.submitArtifact(ctx.taskId, {
      commitSha: 'a1b2c3d4e5f6',
      changedPaths: ['tests/foo.ts'],
    });
    expect(artifact.triggeredActions).toEqual(['artifact:submit', 'test:write']);
  });

  it('CLAIM하지 않은 태스크에는 제출할 수 없다', async () => {
    const ctx = await setup();

    await expect(
      clientFor(ctx).submitArtifact(ctx.taskId, { commitSha: 'a1b2c3d4e5f6', changedPaths: ['src/index.ts'] }),
    ).rejects.toMatchObject({ status: 403, code: 'NOT_TASK_ASSIGNEE' });
  });

  it('재제출하면 attempt가 올라간다', async () => {
    const ctx = await setup();
    const client = await claimed(ctx);
    await client.submitArtifact(ctx.taskId, { commitSha: 'aaaaaaa', changedPaths: ['src/a.ts'] });
    await pool.query(`UPDATE tasks SET state = 'IN_PROGRESS' WHERE id = $1`, [ctx.taskId]);

    const second = await client.submitArtifact(ctx.taskId, { commitSha: 'bbbbbbb', changedPaths: ['src/b.ts'] });

    expect(second.attempt).toBe(2);
  });
});

describe('401 policy_stale 재시도', () => {
  const COMMIT = { commitSha: 'a1b2c3d4e5f6', changedPaths: ['src/index.ts'] };

  async function makeStale(ctx: Ctx, pattern: string): Promise<void> {
    // 대표가 경로 규칙을 바꾸면 projects.policy_hash가 갱신되고, 이미 발급된 토큰은 옛 스냅샷 기준이 된다.
    await updatePathOwnership(ctx.orgId, ctx.userId, ctx.repoId, await pathIdOf(ctx.repoId, pattern), {
      ownerRole: 'BACKEND',
    });
    clearPolicyCache();
  }

  it('정책이 바뀌면 재발급 후 원 요청을 1회 재시도해 성공한다', async () => {
    const ctx = await setup();
    const client = clientFor(ctx);
    await client.claimTask(ctx.taskId);

    await makeStale(ctx, 'tests/**');

    const artifact = await client.submitArtifact(ctx.taskId, COMMIT);

    expect(artifact).toMatchObject({ attempt: 1 });
    expect(client.refreshCount).toBe(1);
    // 재발급된 토큰은 새 해시를 담고 있어 이후 호출은 그냥 통과한다.
    await pool.query(`UPDATE tasks SET state = 'IN_PROGRESS' WHERE id = $1`, [ctx.taskId]);
    await client.submitArtifact(ctx.taskId, { ...COMMIT, commitSha: 'bbbbbbb' });
    expect(client.refreshCount).toBe(1);
  });

  it('재발급 직후 또 바뀌면 2회차에서 멈춘다 — 무한 루프 금지', async () => {
    const ctx = await setup();
    await clientFor(ctx).claimTask(ctx.taskId);
    await makeStale(ctx, 'tests/**');

    // refresh 응답이 돌아온 직후 정책을 또 바꾼다. 재발급된 토큰도 곧바로 옛것이 된다.
    const racingFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input as string, init);
      if (String(input).endsWith('/api/agents/token/refresh')) {
        await makeStale(ctx, 'Dockerfile');
      }
      return res;
    };
    const client = clientFor(ctx, racingFetch);

    await expect(client.submitArtifact(ctx.taskId, COMMIT)).rejects.toBeInstanceOf(PolicyStaleLoopError);
    // 두 번째 재발급을 시도하지 않았다는 것이 이 테스트의 핵심이다.
    expect(client.refreshCount).toBe(1);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM events WHERE type = 'TOOL_DENIED' AND payload->>'stage' = 'policy_stale'`,
    );
    expect(rows[0]!.n).toBe(2); // 첫 요청과 재시도, 둘 다 기록된다
  });

  it('정지된 프로젝트는 재발급으로도 뚫리지 않는다', async () => {
    const ctx = await setup();
    const client = clientFor(ctx);
    await pool.query(`UPDATE projects SET status = 'halted', halt_reason = 'budget' WHERE id = $1`, [ctx.projectId]);

    await expect(client.claimTask(ctx.taskId)).rejects.toMatchObject({ status: 403, code: 'PROJECT_HALTED' });
    expect(client.refreshCount).toBe(0); // 403은 재시도 대상이 아니다
  });
});

describe('publish_note · read_notes (HTTP 관통)', () => {
  const NOTE = {
    kind: 'IMPLEMENTED',
    headline: '참여신청 API 구현 완료',
    keyPoints: ['정원 초과는 409로 거절'],
    affects: [],
  };

  it('노트를 발행하고 쿼리 파라미터로 다시 읽는다', async () => {
    const ctx = await setup();
    const client = clientFor(ctx);
    await client.claimTask(ctx.taskId);

    const note = await client.publishNote(ctx.taskId, NOTE);

    // 이 태스크는 spec_id가 없어 제목에서 feature_key가 빠진다.
    expect(note.title).toBe('#1 - 백엔드 구현 완료 — 참여신청 API 구현 완료');

    const notes = await client.readNotes(ctx.projectId, { limit: 5 });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ seq: 1, kind: 'IMPLEMENTED' });

    // 목록 응답은 다른 목록 API와 같은 모양이어야 한다({ data: { notes } }).
    // 여기만 배열을 그대로 내면 클라이언트가 엔드포인트별로 다르게 풀어야 한다.
    const raw = await fetch(`${baseUrl}/api/projects/${ctx.projectId}/notes?limit=5`, {
      headers: { Authorization: `Bearer ${ctx.tokens.accessToken}` },
    });
    expect(await raw.json()).toMatchObject({ data: { notes: [{ seq: 1 }] } });

    // 읽기는 이벤트를 남기지 않는다.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM events WHERE type = 'NOTE_PUBLISHED'`,
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('형식 위반은 422로 어디가 틀렸는지 돌려준다', async () => {
    const ctx = await setup();
    const client = clientFor(ctx);
    await client.claimTask(ctx.taskId);

    // 위반 목록이 HTTP 응답까지 나와야 한다. 코드와 메시지만 오면 모델은 무엇을 줄여야 할지
    // 모른 채 같은 요청을 반복한다 — error-handler의 PUBLIC_DETAIL_CODES가 이걸 지킨다.
    await expect(
      client.publishNote(ctx.taskId, { ...NOTE, keyPoints: ['가'.repeat(121)] }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'NOTE_INVALID',
      details: [{ field: 'keyPoints', index: 0, length: 121 }],
    });

    // 모델은 err.message만 본다. 위반이 그 문장에 실려 있어야 한다.
    await expect(
      client.publishNote(ctx.taskId, { ...NOTE, headline: '가'.repeat(61) }),
    ).rejects.toThrow(/headline/);
  });
});

describe('태스크 조회와 브리핑', () => {
  it('에이전트는 자기 역할 태스크만 본다 — teamRole 질의는 무시된다', async () => {
    const ctx = await setup('BACKEND');
    await pool.query(
      `INSERT INTO tasks (project_id, repo_id, title, state, kind, team_role)
       VALUES ($1, $2, 'FE 것', 'READY', 'IMPLEMENT', 'FRONTEND'), ($1, $2, '역할 없음', 'READY', 'IMPLEMENT', NULL)`,
      [ctx.projectId, ctx.repoId],
    );
    const client = clientFor(ctx);

    const tasks = await client.listTasks(ctx.projectId, { state: 'READY' });

    // 남의 역할 태스크가 목록에 없어야 "잡아보고 403"을 반복하지 않는다.
    expect(tasks.map((t) => t.teamRole)).toEqual(['BACKEND']);
  });

  it('브리핑은 명세·노트·수정 가능 경로·settings를 한 번에 준다', async () => {
    const ctx = await setup('BACKEND');
    const client = clientFor(ctx);
    await client.claimTask(ctx.taskId);
    // 이 태스크엔 spec_id가 없어 "같은 명세" 갈래로는 안 걸린다.
    // affects가 내가 수정할 수 있는 경로와 겹치는 갈래로 선택되는지 본다.
    await client.publishNote(ctx.taskId, {
      kind: 'IMPLEMENTED',
      headline: 'earlier note',
      keyPoints: ['keep the 409'],
      affects: ['src/index.ts'],
    });

    const briefing = (await client.getBriefing(ctx.taskId)) as unknown as {
      task: { id: string; teamRole: string };
      repo: { fullName: string };
      notes: { headline: string }[];
      writablePaths: { pathPattern: string }[];
      claudeSettings: { permissions: { deny: string[] } };
      policyHash: string;
    };

    expect(briefing.task).toMatchObject({ id: ctx.taskId, teamRole: 'BACKEND' });
    expect(briefing.repo.fullName).toBe('acme/web');
    // 인계 노트는 read_notes 호출 없이 서버가 골라 넣는다.
    expect(briefing.notes.map((n) => n.headline)).toContain('earlier note');
    expect(briefing.writablePaths.map((p) => p.pathPattern)).toContain('**');
    // 로컬 방어선의 재료. .env는 반드시 막혀 있어야 한다.
    // '**/'로 시작하는 패턴은 루트 고정('/')을 붙이지 않는다 — 모든 깊이에 걸려야 하기 때문이다.
    expect(briefing.claudeSettings.permissions.deny).toContain('Read(**/.env*)');
    expect(briefing.policyHash).toHaveLength(64);
  });

  // 프롬프트에 들어가는 "수정 가능 경로"도 제출 판정과 같은 결론이어야 한다. 예전에는 owner가 NULL인
  // tests/**·migrations/** 등을 모든 역할에게 "수정 가능"으로 보여줬다 — 모델이 그걸 믿고 고치면 제출에서 막힌다.
  it('수정 가능 경로는 상속된 소유권을 따른다 — 제출 판정과 같은 결론', async () => {
    const be = await setup('BACKEND', 'BACKEND');
    const beBriefing = (await clientFor(be).getBriefing(be.taskId)) as unknown as {
      writablePaths: { pathPattern: string; ownerRole: string }[];
    };
    const patterns = beBriefing.writablePaths.map((p) => p.pathPattern);
    // '**'와, 그걸 물려받는 owner NULL 쓰기 행들
    expect(patterns).toEqual(expect.arrayContaining(['**', 'tests/**', 'migrations/**', '**/.env.example']));
    // 읽기 전용·금지 행은 절대 안 나온다
    expect(patterns).not.toContain('contracts/**');
    expect(patterns).not.toContain('**/.env*');
    expect(beBriefing.writablePaths.every((p) => p.ownerRole === 'BACKEND')).toBe(true);

    await truncateAll();
    clearPolicyCache();
    const fe = await setup('FRONTEND', 'BACKEND');
    const feBriefing = (await clientFor(fe).getBriefing(fe.taskId)) as unknown as { writablePaths: unknown[] };
    // BACKEND 레포에서 FE가 쓸 수 있는 곳은 없다 — tests/**도 BACKEND를 물려받는다.
    expect(feBriefing.writablePaths).toEqual([]);
  });

  it('남의 역할 태스크의 브리핑은 받을 수 없다', async () => {
    const ctx = await setup('BACKEND');
    const { rows } = await pool.query(
      `INSERT INTO tasks (project_id, repo_id, title, state, kind, team_role)
       VALUES ($1, $2, 'FE 것', 'READY', 'IMPLEMENT', 'FRONTEND') RETURNING id`,
      [ctx.projectId, ctx.repoId],
    );

    await expect(clientFor(ctx).getBriefing(rows[0]!.id)).rejects.toMatchObject({
      status: 403,
      code: 'TASK_ROLE_MISMATCH',
    });
  });
});

describe('만료된 access token', () => {
  it('만료되면 재발급하고 원 요청을 1회 재시도한다', async () => {
    const ctx = await setup();
    // exp를 과거로 둔 토큰. 서버는 401 UNAUTHENTICATED로 답한다 — POLICY_STALE이 아니다.
    const expired = signJwt(
      {
        sub: ctx.agentId,
        kind: 'agent',
        on_behalf_of: ctx.userId,
        org_id: ctx.orgId,
        project_id: ctx.projectId,
        policy_hash: 'whatever',
      },
      -10,
      env.JWT_SECRET,
    );
    const client = new NomosClient({
      baseUrl,
      tokens: { accessToken: expired, refreshToken: ctx.tokens.refreshToken },
    });

    // 만료를 재발급 대상에서 빼면 Executor가 한 시간 뒤부터 조용히 죽는다.
    await expect(client.claimTask(ctx.taskId)).resolves.toMatchObject({ state: 'CLAIMED' });
    expect(client.refreshCount).toBe(1);
  });

  it('refresh 토큰까지 죽어 있으면 재발급에서 멈춘다', async () => {
    const ctx = await setup();
    const expired = signJwt({ sub: ctx.agentId, kind: 'agent', on_behalf_of: ctx.userId }, -10, env.JWT_SECRET);
    const client = new NomosClient({
      baseUrl,
      tokens: { accessToken: expired, refreshToken: 'not-a-real-refresh-token' },
    });

    // 루프로 빠지지 않고 재발급 실패를 그대로 올린다.
    await expect(client.claimTask(ctx.taskId)).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
    expect(client.refreshCount).toBe(1);
  });
});

// 사람 토큰으로 진행 상황을 본다. 에이전트만 읽을 수 있으면 대표는 "VERIFYING에서 멈췄다"까지만
// 보이고 무엇이 왜 실패했는지를 볼 수 없다. 두 경로가 같은 라우트를 쓰므로 함께 고정한다.
describe('사람 토큰으로 진행 상황 보기 (HTTP)', () => {
  async function userToken(loginId = 'minsu'): Promise<string> {
    const { accessToken } = await login({ loginId, password: 'correct-horse-battery' });
    return accessToken;
  }

  async function get(path: string, token: string): Promise<{ status: number; body: Record<string, never> }> {
    const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json()) as Record<string, never> };
  }

  it('산출물 목록 → 검증 결과까지 사람 토큰으로 이어진다', async () => {
    const ctx = await setup();
    const client = clientFor(ctx);
    await client.claimTask(ctx.taskId);
    await client.submitArtifact(ctx.taskId, { commitSha: 'a1b2c3d4e5f6', changedPaths: ['src/index.ts'] });

    // 에이전트 경로(Executor가 방금 제출된 산출물의 id를 찾는다)는 그대로 동작한다.
    const asAgent = await client.listArtifacts(ctx.taskId);
    expect(asAgent).toHaveLength(1);

    const token = await userToken();
    const listed = await get(`/api/tasks/${ctx.taskId}/artifacts`, token);
    expect(listed.status).toBe(200);
    const artifacts = (listed.body as unknown as { data: { artifacts: { id: string; commitSha: string }[] } }).data
      .artifacts;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.commitSha).toBe('a1b2c3d4e5f6');

    // 이 id가 있어야 검증 결과에 닿는다 — 사람 경로가 없으면 이 화면이 성립하지 않는다.
    const verifications = await get(`/api/artifacts/${artifacts[0]!.id}/verifications`, token);
    expect(verifications.status).toBe(200);
    const stages = (
      verifications.body as unknown as { data: { verifications: { stage: string }[] } }
    ).data.verifications.map((v) => v.stage);
    expect(stages).toContain('V3');
  });

  it('인계 노트도 사람이 읽는다 — 읽기는 이벤트를 남기지 않는다', async () => {
    const ctx = await setup();
    const client = clientFor(ctx);
    await client.claimTask(ctx.taskId);
    await client.publishNote(ctx.taskId, {
      kind: 'IMPLEMENTED',
      headline: '참여신청 API 구현 완료',
      keyPoints: ['정원 초과는 409로 거절'],
      affects: [],
    });

    const listed = await get(`/api/projects/${ctx.projectId}/notes?limit=5`, await userToken());
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ data: { notes: [{ seq: 1, kind: 'IMPLEMENTED' }] } });

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'NOTE_PUBLISHED'`);
    expect(rows[0]!.n).toBe(1);
  });

  it('다른 조직 사람은 산출물도 노트도 볼 수 없다', async () => {
    const ctx = await setup();
    const client = clientFor(ctx);
    await client.claimTask(ctx.taskId);
    await client.submitArtifact(ctx.taskId, { commitSha: 'a1b2c3d4e5f6', changedPaths: ['src/index.ts'] });

    const outsider = await signup({
      loginId: 'outsider',
      password: 'correct-horse-battery',
      nickname: '외부인',
    });
    await createOrganization(outsider.userId, 'Other Inc.');
    const token = await userToken('outsider');

    const artifacts = await get(`/api/tasks/${ctx.taskId}/artifacts`, token);
    expect(artifacts.status).toBe(403);
    expect(artifacts.body).toMatchObject({ error: { code: 'CROSS_ORG_ACCESS' } });

    const notes = await get(`/api/projects/${ctx.projectId}/notes`, token);
    expect(notes.status).toBe(403);
    expect(notes.body).toMatchObject({ error: { code: 'CROSS_ORG_ACCESS' } });
  });

  it('조직 안이지만 그 프로젝트에 배정되지 않은 팀원은 403이다', async () => {
    const ctx = await setup();
    const client = clientFor(ctx);
    await client.claimTask(ctx.taskId);

    // 같은 조직의 일반 멤버(대표가 아니고, 이 프로젝트의 멤버도 아니다).
    const teammate = await signup({
      loginId: 'jihoon',
      password: 'correct-horse-battery',
      nickname: '지훈',
    });
    await pool.query(`UPDATE users SET org_id = $1, org_role = 'MEMBER' WHERE id = $2`, [
      ctx.orgId,
      teammate.userId,
    ]);

    const notes = await get(`/api/projects/${ctx.projectId}/notes`, await userToken('jihoon'));
    expect(notes.status).toBe(403);
    expect(notes.body).toMatchObject({ error: { code: 'NOT_PROJECT_MEMBER' } });
  });
});
