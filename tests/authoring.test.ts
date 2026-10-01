import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { lockProjectForAuthoring } from '../src/domain/authoring/repository.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { assignMember, createProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { assignRootOwner } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 대표가 화면에서 명세·태스크를 만든다(POST /projects/:id/specs·tasks). 검증과 쓰기는 seed:tasks와 같은 한 벌이다.

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
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

type Body = { data?: Record<string, never>; error?: { code: string; message: string; details?: { where: string; message: string }[] } };

async function call(method: string, url: string, token: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${baseUrl}/api${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

async function account(loginId: string) {
  const { userId, connectKey } = await signup({ loginId, password: 'correct-horse-battery', nickname: loginId });
  const { accessToken } = await login({ loginId, password: 'correct-horse-battery' });
  return { userId, token: accessToken, connectKey };
}

async function world() {
  const rep = await account('rep');
  const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
  const be = await account('be-dev');
  const { token: inviteToken } = await createInvite(orgId, rep.userId);
  await acceptInvite(inviteToken, be.userId);
  const [api, web, unlinked] = await connectRepos({
    orgId,
    actorUserId: rep.userId,
    repos: [{ fullName: 'acme/study-api' }, { fullName: 'acme/study-web' }, { fullName: 'acme/unlinked' }],
  });
  await assignRootOwner(orgId, rep.userId, api!.id, 'BACKEND');
  await assignRootOwner(orgId, rep.userId, web!.id, 'FRONTEND');
  const { project } = await createProject(orgId, rep.userId, {
    name: 'p1',
    autonomyPreset: 'L2',
    pmBudgetUsd: 10,
    repoIds: [api!.id, web!.id],
  });
  return { rep, be, orgId, projectId: project.id, apiRepoId: api!.id, webRepoId: web!.id, unlinkedRepoId: unlinked!.id };
}

const SPEC = {
  featureKey: 'F-05',
  title: '대기열 신청',
  content: 'WHEN 정원이 차면 THEN 대기열에 올린다',
  tests: [
    { criterion: '202를 준다', testCode: 'expect(1).toBe(1)', locked: true },
    { criterion: '초안', testCode: 'expect(2).toBe(2)', locked: false },
  ],
};

describe('POST /projects/:projectId/specs', () => {
  it('대표가 명세와 시험지를 만든다 — locked인 시험지만 잠금 시각이 있다', async () => {
    const w = await world();
    const res = await call('POST', `/projects/${w.projectId}/specs`, w.rep.token, SPEC);
    expect(res.status).toBe(201);
    const spec = res.body.data as unknown as { featureKey: string; version: number; tests: { lockedAt: string | null }[] };
    expect(spec).toMatchObject({ featureKey: 'F-05', version: 1 });
    expect(spec.tests.map((t) => t.lockedAt !== null)).toEqual([true, false]);
  });

  it('시험지의 locked는 필수다 — 빠뜨리면 400', async () => {
    const w = await world();
    const res = await call('POST', `/projects/${w.projectId}/specs`, w.rep.token, {
      ...SPEC,
      tests: [{ criterion: 'x', testCode: 'y' }],
    });
    expect(res.status).toBe(400);
  });

  it('같은 featureKey는 422 PLAN_INVALID로 이유와 함께 돌려준다', async () => {
    const w = await world();
    await call('POST', `/projects/${w.projectId}/specs`, w.rep.token, SPEC);
    const res = await call('POST', `/projects/${w.projectId}/specs`, w.rep.token, SPEC);
    expect(res.status).toBe(422);
    expect(res.body.error!.code).toBe('PLAN_INVALID');
    expect(res.body.error!.details!.map((d) => d.message).join('\n')).toMatch(/F-05.*이미 있다/);
  });

  it('팀원은 만들 수 없다(403), 명세 목록은 볼 수 있다 — 에이전트에게는 잠긴 시험지만', async () => {
    const w = await world();
    await call('POST', `/projects/${w.projectId}/specs`, w.rep.token, SPEC);
    expect((await call('POST', `/projects/${w.projectId}/specs`, w.be.token, { ...SPEC, featureKey: 'F-06' })).status).toBe(403);

    // 팀원은 배정된 프로젝트만 본다 — 배정 전에는 403, 배정 뒤에는 초안까지 본다.
    expect((await call('GET', `/projects/${w.projectId}/specs`, w.be.token)).status).toBe(403);
    const agent = await connectAgent({ connectKey: w.be.connectKey, agentName: 'be-laptop', harness: 'test', skills: [], maxConcurrent: 1 });
    await assignMember({ userId: w.rep.userId, orgId: w.orgId, orgRole: 'REPRESENTATIVE' }, w.projectId, agent.agentId, 'BACKEND');
    const human = await call('GET', `/projects/${w.projectId}/specs`, w.be.token);
    expect((human.body.data as unknown as { specs: { tests: unknown[] }[] }).specs[0]!.tests).toHaveLength(2);

    const { accessToken } = await refreshAgentToken(agent.refreshToken);
    const asAgent = await call('GET', `/projects/${w.projectId}/specs`, accessToken);
    expect((asAgent.body.data as unknown as { specs: { tests: { criterion: string }[] }[] }).specs[0]!.tests.map((t) => t.criterion)).toEqual([
      '202를 준다',
    ]);
  });
});

describe('POST /projects/:projectId/tasks', () => {
  async function withSpec() {
    const w = await world();
    const spec = (await call('POST', `/projects/${w.projectId}/specs`, w.rep.token, SPEC)).body.data as unknown as { id: string };
    return { ...w, specId: spec.id };
  }

  it('만든 태스크는 READY이고, 배정된 에이전트는 프로젝트 시작 뒤에 수령할 수 있다', async () => {
    const w = await withSpec();
    const res = await call('POST', `/projects/${w.projectId}/tasks`, w.rep.token, {
      title: 'T-051 대기열 API',
      teamRole: 'BACKEND',
      repoId: w.apiRepoId,
      specId: w.specId,
    });
    expect(res.status).toBe(201);
    const task = res.body.data as unknown as { id: string; state: string; kind: string; specId: string };
    expect(task).toMatchObject({ state: 'READY', kind: 'IMPLEMENT', specId: w.specId });

    const agent = await connectAgent({ connectKey: w.be.connectKey, agentName: 'be-laptop', harness: 'test', skills: [], maxConcurrent: 1 });
    await assignMember({ userId: w.rep.userId, orgId: w.orgId, orgRole: 'REPRESENTATIVE' }, w.projectId, agent.agentId, 'BACKEND');
    const { accessToken } = await refreshAgentToken(agent.refreshToken);
    // 시작(G1) 전에는 가져갈 수 없다.
    const early = await call('POST', `/tasks/${task.id}/claim`, accessToken);
    expect(early.status).toBe(409);
    expect(early.body.error!.code).toBe('PROJECT_NOT_STARTED');

    expect((await call('POST', `/projects/${w.projectId}/start`, w.rep.token)).status).toBe(200);
    const claimed = await call('POST', `/tasks/${task.id}/claim`, accessToken);
    expect(claimed.status).toBe(200);
    expect((claimed.body.data as unknown as { state: string }).state).toBe('CLAIMED');
  });

  it('이벤트는 대표 명의 TASK_CREATED(source=human)이고 선행 관계가 담긴다', async () => {
    const w = await withSpec();
    const first = (await call('POST', `/projects/${w.projectId}/tasks`, w.rep.token, {
      title: 'A', teamRole: 'BACKEND', repoId: w.apiRepoId, specId: w.specId,
    })).body.data as unknown as { id: string };
    await call('POST', `/projects/${w.projectId}/tasks`, w.rep.token, {
      title: 'B', teamRole: 'FRONTEND', repoId: w.webRepoId, specId: w.specId, dependsOn: [first.id],
    });

    const events = await pool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'TASK_CREATED' ORDER BY id`);
    expect(events.rows.map((e) => [e.on_behalf_of, e.payload.source])).toEqual([
      [w.rep.userId, 'human'],
      [w.rep.userId, 'human'],
    ]);
    expect(events.rows[1]!.payload.dependsOn).toEqual([first.id]);
    const spec = await pool.query(`SELECT on_behalf_of, payload FROM events WHERE type = 'SPEC_CREATED'`);
    expect(spec.rows[0]).toMatchObject({ on_behalf_of: w.rep.userId, payload: { source: 'human', lockedTestCount: 1 } });
  });

  it('INTEGRATION은 명세 없이 만들 수 있고, IMPLEMENT는 명세가 필요하다', async () => {
    const w = await withSpec();
    const integration = await call('POST', `/projects/${w.projectId}/tasks`, w.rep.token, {
      title: '통합', teamRole: null, kind: 'INTEGRATION', repoId: w.apiRepoId,
    });
    expect(integration.status).toBe(201);
    expect(integration.body.data).toMatchObject({ specId: null, teamRole: null });

    const implement = await call('POST', `/projects/${w.projectId}/tasks`, w.rep.token, {
      title: '구현', teamRole: 'BACKEND', repoId: w.apiRepoId,
    });
    expect(implement.status).toBe(422);
    expect(implement.body.error!.details!.map((d) => d.message).join()).toContain('명세가 필요하다');
  });

  it('틀린 곳을 전부 모아 돌려준다 — 연결 안 된 레포, 남의 프로젝트 명세·선행, 같은 제목', async () => {
    const w = await withSpec();
    await call('POST', `/projects/${w.projectId}/tasks`, w.rep.token, {
      title: '있는 제목', teamRole: 'BACKEND', repoId: w.apiRepoId, specId: w.specId,
    });
    // 다른 프로젝트의 태스크·명세
    const [other] = await connectRepos({ orgId: w.orgId, actorUserId: w.rep.userId, repos: [{ fullName: 'acme/other' }] });
    await assignRootOwner(w.orgId, w.rep.userId, other!.id, 'BACKEND');
    const { project: p2 } = await createProject(w.orgId, w.rep.userId, { name: 'p2', autonomyPreset: 'L2', pmBudgetUsd: 1, repoIds: [other!.id] });
    const foreignSpec = (await call('POST', `/projects/${p2.id}/specs`, w.rep.token, SPEC)).body.data as unknown as { id: string };
    const foreignTask = (await call('POST', `/projects/${p2.id}/tasks`, w.rep.token, {
      title: 'X', teamRole: 'BACKEND', repoId: other!.id, specId: foreignSpec.id,
    })).body.data as unknown as { id: string };

    const res = await call('POST', `/projects/${w.projectId}/tasks`, w.rep.token, {
      title: '있는 제목',
      teamRole: 'BACKEND',
      repoId: w.unlinkedRepoId,
      specId: foreignSpec.id,
      dependsOn: [foreignTask.id],
    });
    expect(res.status).toBe(422);
    const all = res.body.error!.details!.map((d) => d.message).join('\n');
    expect(all).toContain('이 프로젝트에 연결돼 있지 않다');
    expect(all).toContain('이 프로젝트의 명세가 아니다');
    expect(all).toContain('이 프로젝트의 태스크가 아니다');
    expect(all).toContain('이미 있다');
    expect(await pool.query(`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1`, [w.projectId]).then((r) => r.rows[0].n)).toBe(1);
  });

  it('팀원은 403, 다른 조직의 대표는 403 CROSS_ORG_ACCESS', async () => {
    const w = await withSpec();
    const body = { title: 'T', teamRole: 'BACKEND', repoId: w.apiRepoId, specId: w.specId };
    expect((await call('POST', `/projects/${w.projectId}/tasks`, w.be.token, body)).status).toBe(403);

    const outsider = await account('outsider');
    await createOrganization(outsider.userId, 'Other');
    const res = await call('POST', `/projects/${w.projectId}/tasks`, outsider.token, body);
    expect(res.status).toBe(403);
    expect(res.body.error!.code).toBe('CROSS_ORG_ACCESS');
  });

  // 끝났거나 멈춘 프로젝트에는 만들 수 없다. 상태를 바꾸는 API가 아직 없어 직접 UPDATE한다.
  it.each(['halted', 'completed', 'aborted'])('%s 프로젝트에서는 409 PROJECT_NOT_OPEN', async (status) => {
    const w = await withSpec();
    await pool.query(
      `UPDATE projects SET status = $2, halt_reason = CASE WHEN $2 = 'halted' THEN 'manual' END WHERE id = $1`,
      [w.projectId, status],
    );
    const res = await call('POST', `/projects/${w.projectId}/tasks`, w.rep.token, {
      title: 'T', teamRole: 'BACKEND', repoId: w.apiRepoId, specId: w.specId,
    });
    expect(res.status).toBe(409);
    expect(res.body.error!.code).toBe('PROJECT_NOT_OPEN');
    expect((await call('POST', `/projects/${w.projectId}/specs`, w.rep.token, { ...SPEC, featureKey: 'F-09' })).status).toBe(409);
  });

  // 사전 검사(같은 제목)와 INSERT 사이에 다른 작성이 끼면 둘 다 통과해 중복이 생긴다. 요청을 그냥 동시에 보내면
  // 거의 순서대로 도착해 경합이 재현되지 않으므로(잠금을 빼도 통과했다), 다른 작성이 진행 중인 상황을 직접 만든다:
  // 별도 연결이 프로젝트 행을 잠근 채 같은 제목을 넣는 동안 요청은 기다려야 하고, 풀린 뒤에는 그 제목을 보고 거부해야 한다.
  it('진행 중인 다른 작성이 끝날 때까지 기다린 뒤 검사한다 — 같은 제목이 둘 생기지 않는다', async () => {
    const w = await withSpec();
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await lockProjectForAuthoring(other, w.projectId); // 다른 작성이 진행 중인 것과 같은 상태

      let settled = false;
      const request = call('POST', `/projects/${w.projectId}/tasks`, w.rep.token, {
        title: '동시', teamRole: 'BACKEND', repoId: w.apiRepoId, specId: w.specId,
      }).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled, '잠금이 없으면 요청이 기다리지 않고 끝난다').toBe(false);

      await other.query(
        `INSERT INTO tasks (project_id, repo_id, spec_id, title, kind, team_role) VALUES ($1, $2, $3, '동시', 'IMPLEMENT', 'BACKEND')`,
        [w.projectId, w.apiRepoId, w.specId],
      );
      await other.query('COMMIT');

      const res = await request;
      expect(res.status).toBe(422);
      expect(await pool.query(`SELECT count(*)::int AS n FROM tasks WHERE title = '동시'`).then((r) => r.rows[0].n)).toBe(1);
    } finally {
      other.release();
    }
  });

  // FOR UPDATE였다면 작성 중에 이 프로젝트를 참조하는 모든 INSERT(이벤트·노트·제출)가 줄을 섰다.
  // FOR NO KEY UPDATE는 외래 키 검사(FOR KEY SHARE)와 충돌하지 않는다.
  it('프로젝트를 잠근 동안에도 그 프로젝트를 참조하는 INSERT는 막히지 않는다', async () => {
    const w = await withSpec();
    const locker = await pool.connect();
    try {
      await locker.query('BEGIN');
      await lockProjectForAuthoring(locker, w.projectId); // 작성이 쓰는 잠금 그대로
      // 외래 키로 projects를 참조하는 행 — 막히면 lock_timeout으로 실패한다.
      const writer = await pool.connect();
      try {
        await writer.query(`SET lock_timeout = '1s'`);
        await writer.query(
          `INSERT INTO events (org_id, project_id, type, on_behalf_of, payload) VALUES ($1, $2, 'TEST_PROBE', $3, '{}')`,
          [w.orgId, w.projectId, w.rep.userId],
        );
        await writer.query(`DELETE FROM events WHERE type = 'TEST_PROBE'`);
      } finally {
        writer.release();
      }
      await locker.query('ROLLBACK');
    } finally {
      locker.release();
    }
  });
});
