import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withTransaction } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { clearPolicyCache, getPolicySnapshot } from '../src/domain/policy/policy-cache.js';
import { computePolicyHash, recomputeProjectPolicyHash } from '../src/domain/policy/policy-hash.js';
import { checkScope, inspectPaths, type ActionAttempt } from '../src/domain/policy/scope-check.js';
import type { RepoId, RepoPathId } from '../src/domain/ids.js';
import { SEED_PATH_RULES } from '../src/domain/repo/seed-paths.js';
import type { RepoPath } from '../src/domain/repo/types.js';
import type { TeamRole } from '../src/domain/roles.js';
import { connectRepos, updatePathOwnership } from '../src/domain/repo/service.js';
import { authenticateAgent } from '../src/middleware/agent-auth.js';
import { signJwt } from '../src/utils/tokens.js';
import { assignRootOwner, createTestAgent, createTestOrg, createTestProject, createTestUser } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

beforeAll(async () => {
  await resetSchema();
});

beforeEach(async () => {
  await truncateAll();
  clearPolicyCache();
});

afterAll(async () => {
  await pool.end();
  await testPool.end();
});

type Ctx = {
  userId: string;
  orgId: string;
  projectId: string;
  agentId: string;
  repoId: string;
  policyHash: string;
};

// 프로젝트 하나 + 레포 하나 + 에이전트 하나. 정책 17행을 L2로 복사하고 해시를 고정한다.
async function setup(teamRole: 'BACKEND' | 'FRONTEND' = 'BACKEND'): Promise<Ctx> {
  const { userId, orgId } = await createTestOrg('rep');
  const projectId = await createTestProject({ orgId, userId });
  const agentId = await createTestAgent(userId);
  const [repo] = await connectRepos({ orgId, actorUserId: userId, repos: [{ fullName: 'acme/web' }] });
  const repoId = repo!.id;
  // 소유 역할은 상속된다. '**'를 정하지 않으면 기본 거부(B-2)로 아무 경로에도 쓸 수 없다.
  await assignRootOwner(orgId, userId, repoId, teamRole);

  await pool.query(`INSERT INTO project_repos (project_id, repo_id) VALUES ($1, $2)`, [projectId, repoId]);
  await pool.query(`INSERT INTO project_members (project_id, agent_id, team_role) VALUES ($1, $2, $3)`, [
    projectId,
    agentId,
    teamRole,
  ]);
  await pool.query(
    `INSERT INTO project_policies (project_id, action_key, mode, lock_key)
     SELECT $1, action_key, mode_l2, lock_key FROM action_catalog`,
    [projectId],
  );
  const policyHash = await recomputeProjectPolicyHash(pool, projectId);
  return { userId, orgId, projectId, agentId, repoId, policyHash };
}

function attemptOf(ctx: Ctx, over: Partial<ActionAttempt> = {}): ActionAttempt {
  return {
    agentId: ctx.agentId,
    onBehalfOf: ctx.userId,
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    policyHash: ctx.policyHash,
    actionKey: 'code:own_path',
    repoId: ctx.repoId,
    paths: ['src/index.ts'],
    ...over,
  };
}

const run = (attempt: ActionAttempt) => withTransaction((tx) => checkScope(tx, attempt));

async function lastDenial(): Promise<{
  stage: string;
  path: string | null;
  pathViolation: boolean;
  ownerRole: string | null;
}> {
  const { rows } = await pool.query(
    `SELECT payload, path_violation, owner_role FROM events WHERE type = 'TOOL_DENIED' ORDER BY id DESC LIMIT 1`,
  );
  const row = rows[0]!;
  return {
    stage: row.payload.stage,
    path: row.payload.path,
    pathViolation: row.path_violation,
    ownerRole: row.owner_role,
  };
}

async function pathIdOf(repoId: string, pattern: string): Promise<string> {
  const { rows } = await pool.query(`SELECT id FROM repo_paths WHERE repo_id = $1 AND path_pattern = $2`, [
    repoId,
    pattern,
  ]);
  return rows[0]!.id as string;
}

describe('policy_hash', () => {
  it('경로 규칙이 바뀌면 해시가 바뀐다', async () => {
    const ctx = await setup(); // '**' = BACKEND

    await updatePathOwnership(ctx.orgId, ctx.userId, ctx.repoId, await pathIdOf(ctx.repoId, '**'), {
      ownerRole: 'FRONTEND',
    });

    expect(await computePolicyHash(pool, ctx.projectId)).not.toBe(ctx.policyHash);
  });

  it('경로 규칙을 바꾸면 프로젝트의 policy_hash도 함께 갱신된다', async () => {
    const ctx = await setup();

    await updatePathOwnership(ctx.orgId, ctx.userId, ctx.repoId, await pathIdOf(ctx.repoId, '**'), {
      ownerRole: 'FRONTEND',
    });

    const { rows } = await pool.query(`SELECT policy_hash FROM projects WHERE id = $1`, [ctx.projectId]);
    expect(rows[0]!.policy_hash).not.toBe(ctx.policyHash);
    expect(rows[0]!.policy_hash).toBe(await computePolicyHash(pool, ctx.projectId));
  });

  it('정책 사본이 바뀌어도 해시가 바뀐다', async () => {
    const ctx = await setup();
    await pool.query(
      `UPDATE project_policies SET mode = 'HUMAN' WHERE project_id = $1 AND action_key = 'contract:propose'`,
      [ctx.projectId],
    );
    expect(await computePolicyHash(pool, ctx.projectId)).not.toBe(ctx.policyHash);
  });

  it('해시가 맞지 않는 스냅샷은 캐시에 넣지 않는다', async () => {
    const ctx = await setup(); // '**' = BACKEND, ctx.policyHash는 그 상태의 해시
    // policy_hash 갱신을 빠뜨린 상황을 흉내낸다. 이때 캐시에 굳으면 이후 판정이 조용히 어긋난다.
    await pool.query(`UPDATE repo_paths SET owner_role = 'FRONTEND' WHERE repo_id = $1 AND path_pattern = '**'`, [
      ctx.repoId,
    ]);
    const first = await getPolicySnapshot(pool, ctx.projectId, ctx.policyHash);
    expect(first.repoPaths.find((p) => p.pathPattern === '**')?.ownerRole).toBe('FRONTEND');

    // 해시가 안 맞던 첫 스냅샷이 캐시에 굳었다면 여기서도 FRONTEND가 나온다.
    await pool.query(`UPDATE repo_paths SET owner_role = 'BACKEND' WHERE repo_id = $1 AND path_pattern = '**'`, [
      ctx.repoId,
    ]);
    const second = await getPolicySnapshot(pool, ctx.projectId, ctx.policyHash);
    expect(second.repoPaths.find((p) => p.pathPattern === '**')?.ownerRole).toBe('BACKEND');
  });
});

// ── 소유 역할 상속 (B-2) ─────────────────────────────────────────────────
// 접근·행동 키는 가장 높은 행에서, 소유 역할은 owner가 지정된 가장 높은 행에서 가져온다.
// 상속할 게 없으면 기본 거부. 판정기(inspectPaths)는 순수 함수이므로 시드 규칙을 그대로 넣어 본다.
describe('소유 역할 상속 — 기본 거부(B-2)', () => {
  const REPO = 'repo-1' as RepoId;
  let seq = 0;
  // 시드 15행 + 필요한 소유자 지정. 대표가 온보딩에서 하는 일을 그대로 흉내 낸다.
  function rulesWith(owners: Record<string, TeamRole>, extra: RepoPath[] = []): RepoPath[] {
    const seeded = SEED_PATH_RULES.map(
      (r): RepoPath => ({
        id: `p-${(seq += 1)}` as RepoPathId,
        repoId: REPO,
        pathPattern: r.pathPattern,
        ownerRole: owners[r.pathPattern] ?? null,
        access: r.access,
        actionKey: r.actionKey,
        priority: r.priority,
        source: 'seed',
        createdAt: '2026-01-01T00:00:00Z',
      }),
    );
    return [...seeded, ...extra];
  }
  function manual(pathPattern: string, priority: number, ownerRole: TeamRole): RepoPath {
    return {
      id: `m-${(seq += 1)}` as RepoPathId,
      repoId: REPO,
      pathPattern,
      ownerRole,
      access: 'write',
      actionKey: null,
      priority,
      source: 'manual',
      createdAt: '2026-01-01T00:00:00Z',
    };
  }

  it("owner가 NULL인 tests/**는 '**'의 소유 역할을 물려받는다 — 행동 키는 tests/**에서", () => {
    const rules = rulesWith({ '**': 'BACKEND' });

    expect(inspectPaths(rules, ['tests/foo.ts'], 'BACKEND', true)).toEqual({ ok: true, actionKeys: ['test:write'] });
    // 상속 전에는 이 경로를 FE도 쓸 수 있었다(NULL = 누구나).
    expect(inspectPaths(rules, ['tests/foo.ts'], 'FRONTEND', true)).toMatchObject({
      ok: false,
      stage: 'ownership',
      ownerRole: 'BACKEND',
      pathViolation: true,
      detail: '** belongs to BACKEND',
      reason: 'owned_by_other',
    });
  });

  it('상속받은 소유권으로 통과해도 접근·행동 키는 가장 높은 행을 따른다', () => {
    const rules = rulesWith({ '**': 'BACKEND' });

    expect(inspectPaths(rules, ['migrations/013_x.sql'], 'BACKEND', true)).toEqual({ ok: true, actionKeys: ['db:migration'] });
    expect(inspectPaths(rules, ['.github/workflows/ci.yml'], 'BACKEND', true)).toEqual({ ok: true, actionKeys: ['infra:ci'] });
    // 읽기 전용·금지는 소유권보다 먼저다. 소유자여도 못 쓴다.
    expect(inspectPaths(rules, ['contracts/F-03.yaml'], 'BACKEND', true)).toMatchObject({ ok: false, detail: 'contracts/** is read-only', reason: 'read_only' });
    expect(inspectPaths(rules, ['api/.env'], 'BACKEND', true)).toMatchObject({ ok: false, stage: 'forbidden_path', pathViolation: false, reason: 'denied_path' });
    // .env.example 예외(950)는 owner가 NULL이지만 '**'를 물려받는다.
    expect(inspectPaths(rules, ['.env.example'], 'FRONTEND', true)).toMatchObject({ ok: false, ownerRole: 'BACKEND' });
    expect(inspectPaths(rules, ['.env.example'], 'BACKEND', true)).toMatchObject({ ok: true });
  });

  it('더 높은 priority의 소유 행이 있으면 그쪽을 물려받는다', () => {
    const rules = rulesWith({ '**': 'BACKEND' }, [manual('web/**', 200, 'FRONTEND')]);

    expect(inspectPaths(rules, ['web/src/App.tsx'], 'FRONTEND', true)).toMatchObject({ ok: true });
    expect(inspectPaths(rules, ['web/src/App.tsx'], 'BACKEND', true)).toMatchObject({
      ok: false,
      ownerRole: 'FRONTEND',
      detail: 'web/** belongs to FRONTEND',
    });
    // web/ 밖은 여전히 '**'(BACKEND)
    expect(inspectPaths(rules, ['api/join.ts'], 'FRONTEND', true)).toMatchObject({ ok: false, ownerRole: 'BACKEND' });
  });

  it('상속할 소유자가 없으면 아무도 못 쓴다 — 남의 영역 침범이 아니므로 path_violation은 아니다', () => {
    const rules = rulesWith({});

    for (const role of ['BACKEND', 'FRONTEND'] as const) {
      expect(inspectPaths(rules, ['src/index.ts'], role, true)).toMatchObject({
        ok: false,
        stage: 'ownership',
        ownerRole: null,
        pathViolation: false,
        reason: 'unowned',
      });
      expect(inspectPaths(rules, ['tests/foo.ts'], role, true)).toMatchObject({ ok: false, ownerRole: null, reason: 'unowned' });
    }
  });

  it('모노레포 — 루트를 비워 두고 하위만 나누면 루트 파일은 거부된다(열리지 않는다)', () => {
    const rules = rulesWith({}, [manual('apps/web/**', 200, 'FRONTEND'), manual('apps/api/**', 201, 'BACKEND')]);

    expect(inspectPaths(rules, ['apps/web/page.tsx'], 'FRONTEND', true)).toMatchObject({ ok: true });
    expect(inspectPaths(rules, ['apps/api/join.ts'], 'BACKEND', true)).toMatchObject({ ok: true });
    expect(inspectPaths(rules, ['package-lock.json'], 'FRONTEND', true)).toMatchObject({ ok: false, pathViolation: false });
  });

  it('소유권은 쓰기에만 적용한다 — 읽기는 금지 경로만 막는다', () => {
    const rules = rulesWith({ '**': 'BACKEND' });

    expect(inspectPaths(rules, ['src/index.ts'], 'FRONTEND', false)).toMatchObject({ ok: true });
    expect(inspectPaths(rules, ['api/.env'], 'FRONTEND', false)).toMatchObject({ ok: false, stage: 'forbidden_path' });
  });
});

describe('검증 파이프라인 2~4단계', () => {
  it('소유 역할이 맞으면 판정(gate)을 돌려준다', async () => {
    const ctx = await setup('BACKEND');

    expect(await run(attemptOf(ctx))).toEqual({ ok: true, gate: 'AUTO', teamRole: 'BACKEND' });

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'TOOL_DENIED'`);
    expect(rows[0]!.n).toBe(0);
  });

  it('프로젝트 멤버가 아니면 2단계에서 막힌다', async () => {
    const ctx = await setup();
    await pool.query(`DELETE FROM project_members WHERE project_id = $1`, [ctx.projectId]);

    expect(await run(attemptOf(ctx))).toMatchObject({ ok: false, stage: 'membership' });
    expect((await lastDenial()).stage).toBe('membership');
  });

  it('정책 사본에 없는 행동은 열지 않고 닫는다', async () => {
    const ctx = await setup();
    await pool.query(`DELETE FROM project_policies WHERE project_id = $1 AND action_key = 'code:own_path'`, [
      ctx.projectId,
    ]);
    const policyHash = await recomputeProjectPolicyHash(pool, ctx.projectId);

    expect(await run(attemptOf(ctx, { policyHash }))).toMatchObject({ ok: false, stage: 'unknown_action' });
  });

  it('FORBIDDEN 행동은 경로를 보기도 전에 막는다', async () => {
    const ctx = await setup();

    expect(await run(attemptOf(ctx, { actionKey: 'deploy', paths: [] }))).toMatchObject({
      ok: false,
      stage: 'forbidden_action',
    });
  });

  it('남의 소유 경로를 건드리면 3단계에서 막고 path_violation을 남긴다', async () => {
    const ctx = await setup('BACKEND');
    await pool.query(`UPDATE repo_paths SET owner_role = 'FRONTEND' WHERE repo_id = $1 AND path_pattern = '**'`, [
      ctx.repoId,
    ]);

    expect(await run(attemptOf(ctx, { paths: ['src/index.ts'] }))).toMatchObject({
      ok: false,
      stage: 'ownership',
      path: 'src/index.ts',
    });

    const denial = await lastDenial();
    expect(denial.pathViolation).toBe(true); // M5′ 집계가 읽는 열
    expect(denial.ownerRole).toBe('FRONTEND');
  });

  it('읽기 전용 경로에 쓰면 막고, 읽기만 하면 통과한다', async () => {
    const ctx = await setup();

    expect(await run(attemptOf(ctx, { paths: ['contracts/F-03.yaml'] }))).toMatchObject({
      ok: false,
      stage: 'ownership',
    });
    expect(await run(attemptOf(ctx, { paths: ['contracts/F-03.yaml'], write: false }))).toMatchObject({ ok: true });
  });

  it('금지 경로는 소유권이 아니라 4단계로 기록된다', async () => {
    const ctx = await setup();

    expect(await run(attemptOf(ctx, { paths: ['api/.env'] }))).toMatchObject({ ok: false, stage: 'forbidden_path' });

    // 소유권 위반이 아니다 — .env는 아무도 소유하지 않는다. 섞이면 M5′ 분자가 오염된다.
    expect((await lastDenial()).pathViolation).toBe(false);
  });

  it('.env.example 예외는 통과한다', async () => {
    const ctx = await setup();
    expect(await run(attemptOf(ctx, { paths: ['.env.example'] }))).toMatchObject({ ok: true });
  });
});

describe('에이전트 인증 0a·0b', () => {
  function tokenFor(ctx: Ctx, over: Record<string, unknown> = {}): string {
    return signJwt(
      {
        sub: ctx.agentId,
        kind: 'agent',
        on_behalf_of: ctx.userId,
        org_id: ctx.orgId,
        project_id: ctx.projectId,
        policy_hash: ctx.policyHash,
        ...over,
      },
      3600,
      env.JWT_SECRET,
    );
  }

  async function runAuth(token: string): Promise<{ req: Request; err: unknown }> {
    const req = {
      header: (name: string) => (name === 'Authorization' ? `Bearer ${token}` : undefined),
    } as unknown as Request;
    let err: unknown = null;
    const next: NextFunction = (e?: unknown) => {
      err = e ?? null;
    };
    await authenticateAgent(req, {} as Response, next);
    return { req, err };
  }

  it('정상 토큰은 req.agent를 붙인다', async () => {
    const ctx = await setup();
    const { req, err } = await runAuth(tokenFor(ctx));

    expect(err).toBeNull();
    expect(req.agent).toMatchObject({ id: ctx.agentId, onBehalfOf: ctx.userId, projectId: ctx.projectId });
  });

  it('사람 토큰으로는 에이전트 API를 부를 수 없다', async () => {
    const ctx = await setup();
    expect((await runAuth(tokenFor(ctx, { kind: 'user' }))).err).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('0a — 정지된 프로젝트는 토큰이 살아 있어도 거부한다', async () => {
    const ctx = await setup();
    await pool.query(`UPDATE projects SET status = 'halted', halt_reason = 'budget' WHERE id = $1`, [ctx.projectId]);

    expect((await runAuth(tokenFor(ctx))).err).toMatchObject({ code: 'PROJECT_HALTED', status: 403 });
    expect((await lastDenial()).stage).toBe('halted');
  });

  it('0b — 정책이 바뀌면 옛 토큰은 401 policy_stale', async () => {
    const ctx = await setup();
    const stale = tokenFor(ctx);
    await pool.query(`UPDATE repo_paths SET owner_role = 'FRONTEND' WHERE repo_id = $1 AND path_pattern = '**'`, [
      ctx.repoId,
    ]);
    await recomputeProjectPolicyHash(pool, ctx.projectId);

    expect((await runAuth(stale)).err).toMatchObject({
      code: 'POLICY_STALE',
      status: 401,
      details: { reason: 'policy_stale' },
    });
    expect((await lastDenial()).stage).toBe('policy_stale');
  });

  it('지워진 에이전트의 토큰은 만료 전이라도 거부된다', async () => {
    const ctx = await setup();
    const token = tokenFor(ctx);
    await pool.query(`DELETE FROM project_members WHERE agent_id = $1`, [ctx.agentId]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [ctx.agentId]);

    expect((await runAuth(token)).err).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('org_id는 토큰이 아니라 DB에서 읽는다', async () => {
    const ctx = await setup();
    // 조직에 들기 전 발급된 토큰(org_id null)이라도 현재 소속으로 판정해야 한다.
    const { req, err } = await runAuth(tokenFor(ctx, { org_id: null }));

    expect(err).toBeNull();
    expect(req.agent!.orgId).toBe(ctx.orgId);
  });

  it('책임 귀속이 실제 소유자와 어긋난 토큰은 거부된다', async () => {
    const ctx = await setup();
    const other = await createTestUser('other');

    expect((await runAuth(tokenFor(ctx, { on_behalf_of: other }))).err).toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('0a가 0b보다 먼저다 — 정지된 프로젝트는 재발급으로도 뚫리지 않는다', async () => {
    const ctx = await setup();
    const stale = tokenFor(ctx, { policy_hash: 'outdated' });
    await pool.query(`UPDATE projects SET status = 'halted', halt_reason = 'manual' WHERE id = $1`, [ctx.projectId]);

    expect((await runAuth(stale)).err).toMatchObject({ code: 'PROJECT_HALTED' });
  });
});
