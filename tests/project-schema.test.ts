import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withTransaction } from '../src/config/db.js';
import { appendEvent } from '../src/domain/events/append.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { createTestAgent, createTestOrg, createTestProject } from './fixtures.js';
import { reapplyFrom, resetSchema, rollbackFrom, testPool, truncateAll } from './test-db.js';

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

async function setup() {
  const { userId, orgId } = await createTestOrg('rep');
  const projectId = await createTestProject({ orgId, userId });
  const agentId = await createTestAgent(userId);
  const [repo] = await connectRepos({ orgId, actorUserId: userId, repos: [{ fullName: 'acme/web' }] });
  return { userId, orgId, projectId, agentId, repoId: repo!.id };
}

async function insertTask(projectId: string, repoId: string, overrides: Record<string, unknown> = {}) {
  const values = { title: 'T-042', state: 'READY', blocked_reason: null, kind: 'IMPLEMENT', ...overrides };
  return pool.query(
    `INSERT INTO tasks (project_id, repo_id, title, state, blocked_reason, kind)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [projectId, repoId, values.title, values.state, values.blocked_reason, values.kind],
  );
}

describe('projects', () => {
  it('정지 사유 없이 halted로 바꾸면 CHECK 위반이다', async () => {
    const { projectId } = await setup();

    await expect(pool.query(`UPDATE projects SET status = 'halted' WHERE id = $1`, [projectId])).rejects.toThrow(
      /projects_halt_chk/,
    );
    await pool.query(`UPDATE projects SET status = 'halted', halt_reason = 'budget' WHERE id = $1`, [projectId]);
    const { rows } = await pool.query(`SELECT status, halt_reason FROM projects WHERE id = $1`, [projectId]);
    expect(rows[0]).toEqual({ status: 'halted', halt_reason: 'budget' });
  });

  it('허용 레벨과 상태는 고정 어휘만 받는다', async () => {
    const { projectId } = await setup();

    await expect(
      pool.query(`UPDATE projects SET autonomy_preset = 'L5' WHERE id = $1`, [projectId]),
    ).rejects.toThrow(/projects_preset_chk/);
    await expect(pool.query(`UPDATE projects SET status = 'paused' WHERE id = $1`, [projectId])).rejects.toThrow(
      /projects_status_chk/,
    );
  });

  it('PM 예산 없이는 프로젝트를 만들 수 없다', async () => {
    const { userId, orgId } = await createTestOrg('rep');

    await expect(
      pool.query(
        `INSERT INTO projects (org_id, name, autonomy_preset, policy_hash, created_by)
         VALUES ($1, 'no budget', 'L2', 'h', $2)`,
        [orgId, userId],
      ),
    ).rejects.toThrow(/pm_budget_usd/);
  });
});

describe('project_members', () => {
  it('프로젝트당 역할은 하나씩만 배정된다', async () => {
    const { userId, projectId, agentId } = await setup();
    const second = await createTestAgent(userId, 'laptop-2');

    await pool.query(`INSERT INTO project_members (project_id, agent_id, team_role) VALUES ($1, $2, 'BACKEND')`, [
      projectId,
      agentId,
    ]);

    await expect(
      pool.query(`INSERT INTO project_members (project_id, agent_id, team_role) VALUES ($1, $2, 'BACKEND')`, [
        projectId,
        second,
      ]),
    ).rejects.toThrow(/uq_project_members_role/);
    await expect(
      pool.query(`INSERT INTO project_members (project_id, agent_id, team_role) VALUES ($1, $2, 'QA')`, [
        projectId,
        second,
      ]),
    ).rejects.toThrow(/project_members_role_chk/);
  });
});

describe('specs · plans', () => {
  it('같은 기능의 같은 버전은 두 번 들어가지 않는다', async () => {
    const { projectId } = await setup();
    const insert = () =>
      pool.query(
        `INSERT INTO specs (project_id, feature_key, title, content) VALUES ($1, 'F-03', '참여신청', 'WHEN …')`,
        [projectId],
      );

    await insert();
    await expect(insert()).rejects.toThrow(/specs_project_id_feature_key_version_key/);
  });

  it("plans.source는 'planner'와 'replay'만 받는다", async () => {
    const { projectId } = await setup();
    const insert = (source: string) =>
      pool.query(
        `INSERT INTO plans (project_id, dag_snapshot, dag_hash, source) VALUES ($1, '{"tasks":[]}'::jsonb, 'h', $2)`,
        [projectId, source],
      );

    await insert('replay');
    await expect(insert('guess')).rejects.toThrow(/plans_source_chk/);
  });
});

describe('tasks', () => {
  it('8개 상태만 받는다', async () => {
    const { projectId, repoId } = await setup();

    await insertTask(projectId, repoId, { state: 'AWAITING_APPROVAL' });
    await expect(insertTask(projectId, repoId, { state: 'SUBMITTED' })).rejects.toThrow(/tasks_state_chk/);
  });

  it('BLOCKED와 차단 사유는 짝이다 — M2 분모가 오염되지 않게', async () => {
    const { projectId, repoId } = await setup();

    await insertTask(projectId, repoId, { state: 'BLOCKED', blocked_reason: 'DISPUTE' });
    await expect(insertTask(projectId, repoId, { state: 'BLOCKED' })).rejects.toThrow(/tasks_blocked_pair_chk/);
    await expect(
      insertTask(projectId, repoId, { state: 'IN_PROGRESS', blocked_reason: 'QUESTION' }),
    ).rejects.toThrow(/tasks_blocked_pair_chk/);
    await expect(
      insertTask(projectId, repoId, { state: 'BLOCKED', blocked_reason: 'WAITING' }),
    ).rejects.toThrow(/tasks_blocked_reason_chk/);
  });

  it('자기 자신에게 의존할 수 없다', async () => {
    const { projectId, repoId } = await setup();
    const { rows } = await insertTask(projectId, repoId);
    const taskId = rows[0]!.id;

    await expect(
      pool.query(`INSERT INTO task_deps (task_id, depends_on) VALUES ($1, $1)`, [taskId]),
    ).rejects.toThrow(/task_deps_self_chk/);
  });
});

describe('events FK', () => {
  it('없는 프로젝트로는 이벤트를 남길 수 없다', async () => {
    const { orgId, userId } = await setup();

    await expect(
      withTransaction((tx) =>
        appendEvent(tx, {
          orgId,
          projectId: '22222222-2222-2222-2222-222222222222',
          type: 'REPO_PATH_UPDATED',
          onBehalfOf: userId,
          payload: { pathId: 'x', before: {}, after: {} },
        }),
      ),
    ).rejects.toThrow(/events_project_id_fkey/);
  });
});

describe('프로젝트 삭제', () => {
  it('프로젝트를 지우면 계획·명세·태스크·멤버 링크가 함께 지워진다', async () => {
    const { projectId, repoId, agentId } = await setup();
    await pool.query(`INSERT INTO project_repos (project_id, repo_id) VALUES ($1, $2)`, [projectId, repoId]);
    await pool.query(`INSERT INTO project_members (project_id, agent_id, team_role) VALUES ($1, $2, 'FRONTEND')`, [
      projectId,
      agentId,
    ]);
    await pool.query(
      `INSERT INTO specs (project_id, feature_key, title, content) VALUES ($1, 'F-03', 't', 'c')`,
      [projectId],
    );
    await insertTask(projectId, repoId);

    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);

    for (const table of ['project_repos', 'project_members', 'specs', 'tasks']) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0]!.n, table).toBe(0);
    }
    // 레포와 에이전트는 남는다 — 프로젝트보다 오래 산다.
    const repos = await pool.query(`SELECT count(*)::int AS n FROM repos`);
    expect(repos.rows[0]!.n).toBe(1);
  });
});

describe('006_projects_and_tasks', () => {
  const tableExists = async (table: string) =>
    (await pool.query(`SELECT to_regclass($1) AS t`, [table])).rows[0]!.t !== null;

  it('down 후 다시 up 할 수 있다', async () => {
    await rollbackFrom('006_projects_and_tasks.sql');
    expect(await tableExists('tasks')).toBe(false);
    expect(await tableExists('projects')).toBe(false);

    await reapplyFrom('006_projects_and_tasks.sql');
    expect(await tableExists('tasks')).toBe(true);
    expect(await tableExists('task_deps')).toBe(true);
  });
});
