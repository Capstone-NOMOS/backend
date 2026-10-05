import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { NomosClient } from '../src/bridge/nomos-client.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { clearPolicyCache } from '../src/domain/policy/policy-cache.js';
import { recomputeProjectPolicyHash } from '../src/domain/policy/policy-hash.js';
import { connectRepos } from '../src/domain/repo/service.js';
import {
  gitMirrorInspector,
  setCommitInspector,
  type CommitInspector,
} from '../src/domain/verification/commit-inspector.js';
import { buildTaskPrompt } from '../src/executor/prompt.js';
import { assignRootOwner, createTestProject } from './fixtures.js';
import { reapplyFrom, resetSchema, rollbackFrom, testPool, truncateAll } from './test-db.js';

// 승인 대기열(ACTION 게이트) — 검증은 통과했지만 정책 판정이 HUMAN·PM_REVIEW라 멈춘 산출물을 대표가 결정한다.

let server: Server;
let baseUrl: string;
const realInspector = gitMirrorInspector();

function fakeInspector(paths: string[]): CommitInspector {
  return { kind: 'fake', changedPaths: async () => paths };
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
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

const PASSWORD = 'correct-horse-battery';

type Ctx = {
  orgId: string;
  projectId: string;
  taskId: string;
  repToken: string;
  memberToken: string;
  agent: NomosClient;
};

// owner: 'member'면 팀원의 에이전트가, 'rep'이면 대표 자신의 에이전트가 태스크를 맡는다(selfApproval).
async function setup(owner: 'member' | 'rep' = 'member'): Promise<Ctx> {
  const rep = await signup({ loginId: 'boss', password: PASSWORD, nickname: '대표' });
  const member = await signup({ loginId: 'minsu', password: PASSWORD, nickname: '민수' });
  const repAgent = await connectAgent({ connectKey: rep.connectKey, agentName: 'boss-laptop', harness: 'claude-code', skills: [], maxConcurrent: 1 });
  const memberAgent = await connectAgent({ connectKey: member.connectKey, agentName: 'laptop', harness: 'claude-code', skills: [], maxConcurrent: 1 });
  const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
  const { token } = await createInvite(orgId, rep.userId, { teamRole: 'BACKEND' });
  await acceptInvite(token, member.userId);

  const [repo] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/web' }] });
  await assignRootOwner(orgId, rep.userId, repo!.id, 'BACKEND');
  await pool.query(`UPDATE repos SET clone_url = 'file:///demo/acme-web.git' WHERE id = $1`, [repo!.id]);

  const worker = owner === 'rep' ? repAgent : memberAgent;
  const projectId = await createTestProject({ orgId, userId: rep.userId, started: true });
  // 아래는 verifications.test.ts와 같은 구성이다(프로젝트 서비스가 L2 정책 사본·명세를 따로 만들지 않는 테스트용 프로젝트).
  await pool.query(`INSERT INTO project_repos (project_id, repo_id) VALUES ($1, $2)`, [projectId, repo!.id]);
  await pool.query(`INSERT INTO project_members (project_id, agent_id, team_role) VALUES ($1, $2, 'BACKEND')`, [projectId, worker.agentId]);
  await pool.query(
    `INSERT INTO project_policies (project_id, action_key, mode, lock_key)
     SELECT $1, action_key, mode_l2, lock_key FROM action_catalog`,
    [projectId],
  );
  const task = await pool.query(
    `INSERT INTO tasks (project_id, repo_id, title, state, kind, team_role)
     VALUES ($1, $2, 'T-050 스키마 추가', 'READY', 'INTEGRATION', 'BACKEND') RETURNING id`,
    [projectId, repo!.id],
  );
  await recomputeProjectPolicyHash(pool, projectId);
  const refreshed = await refreshAgentToken(worker.refreshToken);

  return {
    orgId,
    projectId,
    taskId: task.rows[0]!.id as string,
    repToken: (await login({ loginId: 'boss', password: PASSWORD })).accessToken,
    memberToken: (await login({ loginId: 'minsu', password: PASSWORD })).accessToken,
    agent: new NomosClient({ baseUrl, tokens: { accessToken: refreshed.accessToken, refreshToken: worker.refreshToken } }),
  };
}

// 수령 → 제출 → V2·V4 보고까지. L2에서 db:migration은 HUMAN, dep:add(requirements.txt)는 PM_REVIEW다.
async function submitToApproval(ctx: Ctx, path = 'migrations/020_x.sql', commitSha = 'abc1234'): Promise<{ artifactId: string; approvalId: string }> {
  setCommitInspector(fakeInspector([path]));
  await ctx.agent.claimTask(ctx.taskId);
  const { id } = (await ctx.agent.submitArtifact(ctx.taskId, { commitSha, changedPaths: [path] })) as unknown as { id: string };
  await ctx.agent.reportVerification(id, { stage: 'V2', result: 'SKIPPED', detail: { reason: '시험지 없음' } });
  const summary = (await ctx.agent.reportVerification(id, { stage: 'V4', result: 'SKIPPED', detail: { reason: 'lint 없음' } })) as unknown as {
    taskState: string;
    approvalId: string;
  };
  expect(summary.taskState).toBe('AWAITING_APPROVAL');
  return { artifactId: id, approvalId: summary.approvalId };
}

type ApprovalJson = { id: string; decision: string | null; reason: string | null; taskState: string | null; gateMode: string | null; decidedAt: string | null };
type ApiJson = { data: ApprovalJson & { approvals: ApprovalJson[] }; error: { code: string } };

async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: ApiJson }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as ApiJson };
}

async function taskRow(taskId: string): Promise<{ state: string; retry_count: number; assignee_agent_id: string | null }> {
  const { rows } = await pool.query(`SELECT state, retry_count, assignee_agent_id FROM tasks WHERE id = $1`, [taskId]);
  return rows[0];
}

async function lastEvent(type: string): Promise<{ payload: Record<string, unknown>; on_behalf_of: string }> {
  const { rows } = await pool.query(`SELECT payload, on_behalf_of FROM events WHERE type = $1 ORDER BY id DESC LIMIT 1`, [type]);
  return rows[0];
}

describe('승인 카드 생성과 조회', () => {
  it('AWAITING_APPROVAL로 가면 카드와 APPROVAL_REQUESTED가 남고, 조직 대기열은 대표만 본다', async () => {
    const ctx = await setup();
    const { artifactId, approvalId } = await submitToApproval(ctx);

    const requested = await lastEvent('APPROVAL_REQUESTED');
    expect(requested.payload).toMatchObject({ approvalId, gate: 'ACTION', taskId: ctx.taskId, artifactId, gateMode: 'HUMAN' });

    const list = await call('GET', `/orgs/${ctx.orgId}/approvals`, ctx.repToken);
    expect(list.status).toBe(200);
    expect(list.json.data.approvals).toHaveLength(1);
    expect(list.json.data.approvals[0]).toMatchObject({
      id: approvalId,
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      taskState: 'AWAITING_APPROVAL',
      gateMode: 'HUMAN',
      decision: null,
      payload: { commitSha: 'abc1234', changedPaths: ['migrations/020_x.sql'], attempt: 1 },
    });

    expect((await call('GET', `/orgs/${ctx.orgId}/approvals`, ctx.memberToken)).status).toBe(403);

    // 프로젝트 이력은 배정된 팀원도 본다(결정은 못 한다).
    const projectList = await call('GET', `/projects/${ctx.projectId}/approvals?status=all`, ctx.memberToken);
    expect(projectList.status).toBe(200);
    expect(projectList.json.data.approvals.map((a: { id: string }) => a.id)).toEqual([approvalId]);
    const denied = await call('POST', `/approvals/${approvalId}/approve`, ctx.memberToken);
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('NOT_REPRESENTATIVE');
  });

  it('status=decided는 결정된 것만, 기본(pending)은 대기 중만 준다', async () => {
    const ctx = await setup();
    const { approvalId } = await submitToApproval(ctx);
    await call('POST', `/approvals/${approvalId}/approve`, ctx.repToken);

    expect((await call('GET', `/orgs/${ctx.orgId}/approvals`, ctx.repToken)).json.data.approvals).toEqual([]);
    const decided = await call('GET', `/orgs/${ctx.orgId}/approvals?status=decided`, ctx.repToken);
    expect(decided.json.data.approvals).toHaveLength(1);
    expect(decided.json.data.approvals[0]).toMatchObject({ decision: 'APPROVE', taskState: 'DONE' });
  });
});

describe('승인', () => {
  it('승인하면 태스크가 DONE이고, 팀원 에이전트의 산출물이면 selfApproval은 false다', async () => {
    const ctx = await setup();
    const { approvalId, artifactId } = await submitToApproval(ctx);

    const res = await call('POST', `/approvals/${approvalId}/approve`, ctx.repToken);
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ id: approvalId, decision: 'APPROVE', taskState: 'DONE', reason: null });
    expect(res.json.data.decidedAt).toEqual(expect.any(String));
    expect((await taskRow(ctx.taskId)).state).toBe('DONE');

    const result = await lastEvent('APPROVAL_RESULT');
    expect(result.payload).toMatchObject({
      approvalId,
      taskId: ctx.taskId,
      artifactId,
      decision: 'APPROVE',
      gateMode: 'HUMAN',
      reviewer: 'human',
      selfApproval: false,
      taskState: 'DONE',
    });
    expect(result.payload).not.toHaveProperty('retryCause');
  });

  it('대표가 자기 에이전트의 산출물을 승인하면 selfApproval: true로 남는다', async () => {
    const ctx = await setup('rep');
    const { approvalId } = await submitToApproval(ctx);

    await call('POST', `/approvals/${approvalId}/approve`, ctx.repToken);
    expect((await lastEvent('APPROVAL_RESULT')).payload).toMatchObject({ selfApproval: true });
  });

  it('PM_REVIEW 카드도 대표가 처리하고 reviewer: human_fallback으로 구분된다', async () => {
    const ctx = await setup();
    const { approvalId } = await submitToApproval(ctx, 'requirements.txt');

    const res = await call('POST', `/approvals/${approvalId}/approve`, ctx.repToken);
    expect(res.json.data.gateMode).toBe('PM_REVIEW');
    expect((await lastEvent('APPROVAL_RESULT')).payload).toMatchObject({ gateMode: 'PM_REVIEW', reviewer: 'human_fallback' });
  });

  it('두 번 결정할 수 없다 — 409 APPROVAL_ALREADY_DECIDED', async () => {
    const ctx = await setup();
    const { approvalId } = await submitToApproval(ctx);
    await call('POST', `/approvals/${approvalId}/approve`, ctx.repToken);

    const again = await call('POST', `/approvals/${approvalId}/reject`, ctx.repToken, { reason: '늦은 반려' });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('APPROVAL_ALREADY_DECIDED');
  });

  it('태스크가 더 이상 승인 대기가 아니면 결정을 받지 않는다 — 409 APPROVAL_STALE', async () => {
    const ctx = await setup();
    const { approvalId } = await submitToApproval(ctx);
    // 승인 경로 밖에서 상태가 바뀐 경우(사람이 DB를 고침 등)를 흉내 낸다.
    await pool.query(`UPDATE tasks SET state = 'ESCALATED' WHERE id = $1`, [ctx.taskId]);

    const res = await call('POST', `/approvals/${approvalId}/approve`, ctx.repToken);
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('APPROVAL_STALE');
    expect((await pool.query(`SELECT decision FROM approvals WHERE id = $1`, [approvalId])).rows[0]!.decision).toBeNull();
  });

  it('없는 승인은 404, 다른 조직의 대표는 403', async () => {
    const ctx = await setup();
    const { approvalId } = await submitToApproval(ctx);

    const missing = await call('POST', `/approvals/00000000-0000-4000-8000-000000000000/approve`, ctx.repToken);
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('APPROVAL_NOT_FOUND');

    const other = await signup({ loginId: 'rival', password: PASSWORD, nickname: '경쟁사' });
    await createOrganization(other.userId, 'Rival Inc.');
    const otherToken = (await login({ loginId: 'rival', password: PASSWORD })).accessToken;
    const cross = await call('POST', `/approvals/${approvalId}/approve`, otherToken);
    expect(cross.status).toBe(403);
    expect(cross.json.error.code).toBe('CROSS_ORG_ACCESS');
  });
});

describe('반려', () => {
  it('사유가 없으면 400이다', async () => {
    const ctx = await setup();
    const { approvalId } = await submitToApproval(ctx);

    expect((await call('POST', `/approvals/${approvalId}/reject`, ctx.repToken, {})).status).toBe(400);
    expect((await call('POST', `/approvals/${approvalId}/reject`, ctx.repToken, { reason: '   ' })).status).toBe(400);
  });

  it('반려하면 READY로 돌아가 담당이 비고 재시도 +1, 다음 시도의 브리핑에 사유가 실린다', async () => {
    const ctx = await setup();
    const { approvalId, artifactId } = await submitToApproval(ctx);

    const res = await call('POST', `/approvals/${approvalId}/reject`, ctx.repToken, { reason: 'down 마이그레이션이 없다' });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ decision: 'REJECT', reason: 'down 마이그레이션이 없다', taskState: 'READY' });
    expect(await taskRow(ctx.taskId)).toMatchObject({ state: 'READY', retry_count: 1, assignee_agent_id: null });

    expect((await lastEvent('APPROVAL_RESULT')).payload).toMatchObject({
      decision: 'REJECT',
      reason: 'down 마이그레이션이 없다',
      taskState: 'READY',
      retryCount: 1,
      retryCause: 'REJECTED',
    });

    // 같은 역할의 에이전트가 다시 받는다 — 브리핑에 직전 반려가 있다.
    await ctx.agent.claimTask(ctx.taskId);
    const briefing = (await ctx.agent.getBriefing(ctx.taskId)) as {
      lastRejection: { approvalId: string; reason: string; artifactId: string; commitSha: string } | null;
    };
    expect(briefing.lastRejection).toMatchObject({ approvalId, reason: 'down 마이그레이션이 없다', artifactId, commitSha: 'abc1234' });

    // 프롬프트는 같은 브랜치에서 이어서 고치라고 한다.
    const prompt = buildTaskPrompt(
      {
        task: { id: ctx.taskId, title: 'T-050', teamRole: 'BACKEND' },
        repo: { fullName: 'acme/web' },
        spec: null,
        notesBlock: '',
        lastRejection: briefing.lastRejection,
        writablePaths: [],
      },
      'nomos/T-050',
    );
    expect(prompt).toContain('down 마이그레이션이 없다');
    expect(prompt).toContain('abc1234');
  });

  it('반려 이력이 없는 태스크의 브리핑은 lastRejection이 null이다', async () => {
    const ctx = await setup();
    await ctx.agent.claimTask(ctx.taskId);
    expect(((await ctx.agent.getBriefing(ctx.taskId)) as { lastRejection: unknown }).lastRejection).toBeNull();
  });

  it('3회째 반려면 ESCALATED — 검증 실패와 같은 재시도 횟수를 쓴다', async () => {
    const ctx = await setup();
    for (const [i, expected] of [
      [1, 'READY'],
      [2, 'READY'],
      [3, 'ESCALATED'],
    ] as const) {
      const { approvalId } = await submitToApproval(ctx, 'migrations/020_x.sql', `abc000${i}`);
      const res = await call('POST', `/approvals/${approvalId}/reject`, ctx.repToken, { reason: `반려 ${i}` });
      expect(res.json.data.taskState).toBe(expected);
      expect(await taskRow(ctx.taskId)).toMatchObject({ state: expected, retry_count: i });
    }
    expect((await lastEvent('APPROVAL_RESULT')).payload).toMatchObject({ taskState: 'ESCALATED', retryCount: 3, retryCause: 'REJECTED' });
  });
});

describe('015 마이그레이션', () => {
  it('승인 기능 이전부터 AWAITING_APPROVAL에 멈춰 있던 태스크는 backfilled 카드를 받는다', async () => {
    const ctx = await setup();
    const { artifactId } = await submitToApproval(ctx);

    // 카드가 없던 시절을 재현한다: 015를 내렸다가 다시 올리면 지금 DB의 값으로 카드를 만든다.
    await rollbackFrom('015_approvals.sql');
    await reapplyFrom('015_approvals.sql');

    const { rows } = await pool.query(`SELECT id, subject_id, artifact_id, gate, gate_mode, decision, payload FROM approvals`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject_id: ctx.taskId,
      artifact_id: artifactId,
      gate: 'ACTION',
      gate_mode: 'HUMAN',
      decision: null,
      payload: { backfilled: true, commitSha: 'abc1234', changedPaths: ['migrations/020_x.sql'], attempt: 1 },
    });

    // backfilled 카드도 보통 카드처럼 결정할 수 있다.
    const res = await call('POST', `/approvals/${rows[0]!.id}/approve`, ctx.repToken);
    expect(res.status).toBe(200);
    expect((await taskRow(ctx.taskId)).state).toBe('DONE');
  });
});
