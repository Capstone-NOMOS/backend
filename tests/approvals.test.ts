import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { NomosClient } from '../src/bridge/nomos-client.js';
import { pool, withTransaction } from '../src/config/db.js';
import { requestActionApproval } from '../src/domain/approval/service.js';
import { findArtifactById, findTaskById } from '../src/domain/task/repository.js';
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

// 승인 대기열(ACTION 게이트) — 검증은 통과했지만 정책 판정이 HUMAN·PM_REVIEW라 멈춘 산출물을
// 역할 담당이 1차 검토(role_review)하고 대표가 최종 승인(final)한다(030).

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
  memberUserId: string;
  repUserId: string;
  workerAgentId: string;
  agent: NomosClient;
};

// owner: 'member'면 팀원의 에이전트가, 'rep'이면 대표 자신의 에이전트가 태스크를 맡는다(selfApproval).
// teamRole: null이면 역할 제한이 없는 태스크 — 역할 담당이 없어 1차 검토를 건너뛴다.
async function setup(owner: 'member' | 'rep' = 'member', teamRole: 'BACKEND' | null = 'BACKEND'): Promise<Ctx> {
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
     VALUES ($1, $2, 'T-050 스키마 추가', 'READY', 'INTEGRATION', $3) RETURNING id`,
    [projectId, repo!.id, teamRole],
  );
  await recomputeProjectPolicyHash(pool, projectId);
  const refreshed = await refreshAgentToken(worker.refreshToken);

  return {
    orgId,
    projectId,
    taskId: task.rows[0]!.id as string,
    repToken: (await login({ loginId: 'boss', password: PASSWORD })).accessToken,
    memberToken: (await login({ loginId: 'minsu', password: PASSWORD })).accessToken,
    memberUserId: member.userId,
    repUserId: rep.userId,
    workerAgentId: worker.agentId,
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

type ApprovalJson = {
  id: string;
  gate: string;
  stage: string;
  reviewer: { userId: string; nickname: string | null } | null;
  roleReview: { by: string; nickname: string | null; at: string; decidedByRepresentative: boolean; note?: string } | null;
  decision: string | null;
  reason: string | null;
  taskState: string | null;
  gateMode: string | null;
  decidedAt: string | null;
  payload: Record<string, unknown>;
};
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

// 1차 검토를 통과해 생긴 대표의 final 카드(대기 중).
async function pendingFinalOf(taskId: string): Promise<string> {
  const { rows } = await pool.query(`SELECT id FROM approvals WHERE subject_id = $1 AND decision IS NULL AND stage = 'final'`, [taskId]);
  expect(rows).toHaveLength(1);
  return rows[0]!.id as string;
}

// 역할 담당 1차 승인 → 대표 최종 승인. 최종 승인 응답을 돌려준다.
async function approveBoth(ctx: Ctx, approvalId: string): Promise<{ finalId: string; res: { status: number; json: ApiJson } }> {
  expect((await call('POST', `/approvals/${approvalId}/approve`, ctx.memberToken)).status).toBe(200);
  const finalId = await pendingFinalOf(ctx.taskId);
  return { finalId, res: await call('POST', `/approvals/${finalId}/approve`, ctx.repToken) };
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
    expect(requested.payload).toMatchObject({
      approvalId, gate: 'ACTION', taskId: ctx.taskId, artifactId, gateMode: 'HUMAN', stage: 'role_review', reviewerUserId: ctx.memberUserId,
    });

    const list = await call('GET', `/orgs/${ctx.orgId}/approvals`, ctx.repToken);
    expect(list.status).toBe(200);
    expect(list.json.data.approvals).toHaveLength(1);
    expect(list.json.data.approvals[0]).toMatchObject({
      id: approvalId,
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      taskState: 'AWAITING_APPROVAL',
      gateMode: 'HUMAN',
      stage: 'role_review',
      reviewer: { userId: ctx.memberUserId, nickname: '민수' },
      roleReview: null,
      decision: null,
      payload: { commitSha: 'abc1234', changedPaths: ['migrations/020_x.sql'], attempt: 1, teamRole: 'BACKEND' },
    });

    expect((await call('GET', `/orgs/${ctx.orgId}/approvals`, ctx.memberToken)).status).toBe(403);

    // 프로젝트 이력은 배정된 팀원도 본다.
    const projectList = await call('GET', `/projects/${ctx.projectId}/approvals?status=all`, ctx.memberToken);
    expect(projectList.status).toBe(200);
    expect(projectList.json.data.approvals.map((a: { id: string }) => a.id)).toEqual([approvalId]);
  });

  it('status=decided는 결정된 것만, 기본(pending)은 대기 중만 준다', async () => {
    const ctx = await setup();
    const { approvalId } = await submitToApproval(ctx);
    await approveBoth(ctx, approvalId);

    // 이 승인으로 프로젝트의 마지막 태스크가 DONE이 되어 G3(통합 확인) 카드가 대기에 생긴다 — ACTION 카드는 대기에 없다.
    const pending = (await call('GET', `/orgs/${ctx.orgId}/approvals`, ctx.repToken)).json.data.approvals as { gate: string }[];
    expect(pending.map((a) => a.gate)).toEqual(['G3']);
    // 결정된 것은 1차 검토 카드와 최종 카드 둘이다.
    const decided = await call('GET', `/orgs/${ctx.orgId}/approvals?status=decided`, ctx.repToken);
    expect(decided.json.data.approvals).toHaveLength(2);
    expect(decided.json.data.approvals.map((a) => a.stage).sort()).toEqual(['final', 'role_review']);
    expect(decided.json.data.approvals.every((a) => a.decision === 'APPROVE' && a.taskState === 'DONE')).toBe(true);
  });
});

describe('승인', () => {
  it('최종 승인하면 태스크가 DONE이고, 팀원 에이전트의 산출물이면 selfApproval은 false다', async () => {
    const ctx = await setup();
    const { approvalId, artifactId } = await submitToApproval(ctx);

    const { finalId, res } = await approveBoth(ctx, approvalId);
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ id: finalId, stage: 'final', decision: 'APPROVE', taskState: 'DONE', reason: null });
    expect(res.json.data.decidedAt).toEqual(expect.any(String));
    expect((await taskRow(ctx.taskId)).state).toBe('DONE');

    const result = await lastEvent('APPROVAL_RESULT');
    expect(result.payload).toMatchObject({
      approvalId: finalId,
      stage: 'final',
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

    const { res } = await approveBoth(ctx, approvalId);
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

describe('두 단계 승인 (030) — 역할 담당 1차 검토 → 대표 최종', () => {
  it('전체 흐름: 담당 1차 승인 → 대표 대기열에 final 카드(1차 결과 포함) → 대표 승인 → DONE', async () => {
    const ctx = await setup();
    const { approvalId, artifactId } = await submitToApproval(ctx);

    // 팀원의 "검토 요청"에 보인다.
    const mine = await call('GET', '/me/approvals', ctx.memberToken);
    expect(mine.status).toBe(200);
    expect(mine.json.data.approvals.map((a) => a.id)).toEqual([approvalId]);

    const first = await call('POST', `/approvals/${approvalId}/approve`, ctx.memberToken, { note: 'down까지 봤다' });
    expect(first.status).toBe(200);
    expect(first.json.data).toMatchObject({ id: approvalId, stage: 'role_review', decision: 'APPROVE', reason: 'down까지 봤다', taskState: 'AWAITING_APPROVAL' });
    expect((await taskRow(ctx.taskId)).state).toBe('AWAITING_APPROVAL');

    const result = await lastEvent('APPROVAL_RESULT');
    expect(result.on_behalf_of).toBe(ctx.memberUserId);
    expect(result.payload).toMatchObject({
      approvalId, stage: 'role_review', decision: 'APPROVE', reviewer: 'role_owner', decidedByRepresentative: false,
      taskState: 'AWAITING_APPROVAL', selfApproval: true, teamRole: 'BACKEND', deciderNickname: '민수',
    });
    const finalId = result.payload.nextApprovalId as string;
    expect((await lastEvent('APPROVAL_REQUESTED')).payload).toMatchObject({ approvalId: finalId, stage: 'final', reviewerUserId: null, artifactId, roleReviewApprovalId: approvalId });

    // 담당의 목록에서는 빠지고, 대표 대기열에는 final 카드가 같은 스냅샷 + 1차 검토 결과로 보인다.
    expect((await call('GET', '/me/approvals', ctx.memberToken)).json.data.approvals).toEqual([]);
    const queue = (await call('GET', `/orgs/${ctx.orgId}/approvals`, ctx.repToken)).json.data.approvals;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: finalId,
      stage: 'final',
      reviewer: null,
      roleReview: { by: ctx.memberUserId, nickname: '민수', decidedByRepresentative: false, note: 'down까지 봤다' },
      payload: { commitSha: 'abc1234', changedPaths: ['migrations/020_x.sql'], attempt: 1, roleReviewApprovalId: approvalId },
    });

    const final = await call('POST', `/approvals/${finalId}/approve`, ctx.repToken);
    expect(final.json.data).toMatchObject({ id: finalId, stage: 'final', decision: 'APPROVE', taskState: 'DONE' });
    expect((await taskRow(ctx.taskId)).state).toBe('DONE');
    expect((await lastEvent('APPROVAL_RESULT')).payload).toMatchObject({ approvalId: finalId, stage: 'final', reviewer: 'human', selfApproval: false });

    // 룸에 1차 승인 줄이 나온다.
    const feed = await call('GET', `/projects/${ctx.projectId}/rooms/BACKEND/feed?limit=50`, ctx.repToken);
    const texts = (feed.json.data as unknown as { messages: { text: string }[] }).messages.map((m) => m.text);
    expect(texts).toContain('BE 담당 민수이 1차 승인 — 대표 승인을 기다립니다');
    expect(texts.some((t) => t.includes('담당 검토를 기다립니다'))).toBe(true);
  });

  it('담당이 반려하면 READY·재시도 +1·브리핑에 담당 반려로 실리고 대표 대기열에 오지 않는다 — 3회째 ESCALATED', async () => {
    const ctx = await setup();
    const { approvalId } = await submitToApproval(ctx);

    const res = await call('POST', `/approvals/${approvalId}/reject`, ctx.memberToken, { reason: '인덱스 이름이 규칙과 다르다' });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ stage: 'role_review', decision: 'REJECT', taskState: 'READY' });
    expect(await taskRow(ctx.taskId)).toMatchObject({ state: 'READY', retry_count: 1, assignee_agent_id: null });
    expect((await lastEvent('APPROVAL_RESULT')).payload).toMatchObject({
      stage: 'role_review', decision: 'REJECT', reviewer: 'role_owner', retryCause: 'REJECTED', retryCount: 1, decidedByRepresentative: false,
    });
    expect((await call('GET', `/orgs/${ctx.orgId}/approvals`, ctx.repToken)).json.data.approvals).toEqual([]);

    await ctx.agent.claimTask(ctx.taskId);
    const briefing = (await ctx.agent.getBriefing(ctx.taskId)) as { lastRejection: { reason: string; rejectedBy: string; commitSha: string | null } };
    expect(briefing.lastRejection).toMatchObject({ reason: '인덱스 이름이 규칙과 다르다', rejectedBy: 'role_owner' });
    expect(buildTaskPrompt({ task: { id: ctx.taskId, title: 'T', teamRole: 'BACKEND' }, repo: { fullName: 'acme/web' }, spec: null, notesBlock: '', lastRejection: briefing.lastRejection, writablePaths: [] }, 'b'))
      .toContain('역할 담당(검토자)에게 반려됐다');

    // 같은 재시도 횟수 — 2·3회째(담당 반려)면 ESCALATED.
    await pool.query(`UPDATE tasks SET state = 'READY', assignee_agent_id = NULL WHERE id = $1`, [ctx.taskId]);
    for (const [i, expected] of [[2, 'READY'], [3, 'ESCALATED']] as const) {
      const next = await submitToApproval(ctx, 'migrations/020_x.sql', `def000${i}`);
      const r = await call('POST', `/approvals/${next.approvalId}/reject`, ctx.memberToken, { reason: `반려 ${i}` });
      expect(r.json.data.taskState).toBe(expected);
    }
    expect(await taskRow(ctx.taskId)).toMatchObject({ state: 'ESCALATED', retry_count: 3 });
    const feed = await call('GET', `/projects/${ctx.projectId}/rooms/BACKEND/feed?limit=100`, ctx.repToken);
    expect((feed.json.data as unknown as { messages: { text: string }[] }).messages.map((m) => m.text)).toContain('BE 담당 민수이 반려 — 인덱스 이름이 규칙과 다르다');
  });

  it('역할 담당이 없거나(역할 제한 없는 태스크) 대표 본인이면 처음부터 final — 건너뛴 이유가 남는다', async () => {
    const none = await setup('member', null);
    const { approvalId } = await submitToApproval(none);
    const card = (await call('GET', `/orgs/${none.orgId}/approvals`, none.repToken)).json.data.approvals[0]!;
    expect(card).toMatchObject({ id: approvalId, stage: 'final', reviewer: null, roleReview: null, payload: { roleReviewSkipped: 'no_owner' } });
    expect((await lastEvent('APPROVAL_REQUESTED')).payload).toMatchObject({ stage: 'final', roleReviewSkipped: 'no_owner' });
    expect((await call('POST', `/approvals/${approvalId}/approve`, none.repToken)).json.data.taskState).toBe('DONE');

    await truncateAll();
    const self = await setup('rep');
    const second = await submitToApproval(self);
    const card2 = (await call('GET', `/orgs/${self.orgId}/approvals`, self.repToken)).json.data.approvals[0]!;
    expect(card2).toMatchObject({ id: second.approvalId, stage: 'final', payload: { roleReviewSkipped: 'owner_is_representative' } });
  });

  it('담당의 에이전트 연결이 끊겨 있어도 담당(사람)이 1차 검토한다', async () => {
    const ctx = await setup();
    const { approvalId, artifactId } = await submitToApproval(ctx);

    // 승인 대기 중에 담당이 에이전트 연결을 해제한다(진행 중 태스크가 아니라 해제할 수 있다) — 담당은 사람이라 그대로다.
    expect((await call('DELETE', `/agents/${ctx.workerAgentId}`, ctx.memberToken)).status).toBe(200);
    const { rows: m } = await pool.query(`SELECT user_id, agent_id FROM project_members WHERE project_id = $1`, [ctx.projectId]);
    expect(m[0]).toMatchObject({ user_id: ctx.memberUserId, agent_id: null });
    expect((await call('GET', '/me/approvals', ctx.memberToken)).json.data.approvals.map((a) => a.id)).toEqual([approvalId]);
    expect((await call('POST', `/approvals/${approvalId}/approve`, ctx.memberToken)).status).toBe(200);
    expect((await call('POST', `/approvals/${await pendingFinalOf(ctx.taskId)}/reject`, ctx.repToken, { reason: '다시' })).status).toBe(200);

    // 에이전트가 없는 상태에서 새 카드를 만들어도 1차 검토 카드다(settle과 같은 함수).
    const card = await withTransaction(async (tx) => {
      const task = (await findTaskById(tx, ctx.taskId))!;
      const artifact = (await findArtifactById(tx, artifactId))!;
      return requestActionApproval(tx, { orgId: ctx.orgId, projectId: ctx.projectId, onBehalfOf: ctx.memberUserId, policyHash: 'x' }, { task, artifact, stages: [] });
    });
    expect(card.stage).toBe('role_review');
    const { rows } = await pool.query(`SELECT reviewer_user_id FROM approvals WHERE id = $1`, [card.id]);
    expect(rows[0]!.reviewer_user_id).toBe(ctx.memberUserId);
  });

  it('권한: 다른 멤버는 1차 검토 403, 담당은 최종 403, 대표는 1차 검토를 대신 처리한다', async () => {
    const ctx = await setup();
    const other = await signup({ loginId: 'jiyoung', password: PASSWORD, nickname: '지영' });
    const { token } = await createInvite(ctx.orgId, ctx.repUserId, { teamRole: 'FRONTEND' });
    await acceptInvite(token, other.userId);
    const otherToken = (await login({ loginId: 'jiyoung', password: PASSWORD })).accessToken;

    const { approvalId } = await submitToApproval(ctx);
    expect((await call('GET', '/me/approvals', otherToken)).json.data.approvals).toEqual([]);
    for (const [method, body] of [['approve', undefined], ['reject', { reason: '남의 것' }]] as const) {
      const denied = await call('POST', `/approvals/${approvalId}/${method}`, otherToken, body);
      expect(denied.status).toBe(403);
      expect(denied.json.error.code).toBe('NOT_APPROVAL_REVIEWER');
    }

    // 대표가 대신 1차 승인 — final 카드가 생기고 대신 처리했다는 표시가 남는다.
    const byRep = await call('POST', `/approvals/${approvalId}/approve`, ctx.repToken);
    expect(byRep.json.data).toMatchObject({ stage: 'role_review', decision: 'APPROVE', taskState: 'AWAITING_APPROVAL' });
    expect((await lastEvent('APPROVAL_RESULT')).payload).toMatchObject({ stage: 'role_review', decidedByRepresentative: true });
    const finalId = await pendingFinalOf(ctx.taskId);
    const finalCard = (await call('GET', `/orgs/${ctx.orgId}/approvals?stage=final`, ctx.repToken)).json.data.approvals[0]!;
    expect(finalCard.roleReview).toMatchObject({ by: ctx.repUserId, decidedByRepresentative: true });
    const roomFeed = await call('GET', `/projects/${ctx.projectId}/rooms/BACKEND/feed?limit=50`, ctx.repToken);
    expect((roomFeed.json.data as unknown as { messages: { text: string }[] }).messages.map((m) => m.text)).toContain('대표가 BE 담당 검토를 대신해 1차 승인 — 대표 승인을 기다립니다');

    // 담당은 최종을 결정할 수 없다.
    const ownerFinal = await call('POST', `/approvals/${finalId}/approve`, ctx.memberToken);
    expect(ownerFinal.status).toBe(403);
    expect(ownerFinal.json.error.code).toBe('NOT_APPROVAL_REVIEWER');
    expect((await call('POST', `/approvals/${finalId}/approve`, ctx.repToken)).json.data.taskState).toBe('DONE');
  });

  it('대표 대기열은 stage로 거른다(기본 전부)', async () => {
    const ctx = await setup();
    const { approvalId } = await submitToApproval(ctx);
    const ids = async (q: string) => (await call('GET', `/orgs/${ctx.orgId}/approvals${q}`, ctx.repToken)).json.data.approvals.map((a) => a.id);

    expect(await ids('')).toEqual([approvalId]);
    expect(await ids('?stage=role_review')).toEqual([approvalId]);
    expect(await ids('?stage=final')).toEqual([]);
    await call('POST', `/approvals/${approvalId}/approve`, ctx.memberToken);
    const finalId = await pendingFinalOf(ctx.taskId);
    expect(await ids('?stage=role_review')).toEqual([]);
    expect(await ids('?stage=final')).toEqual([finalId]);
    expect(await ids('?stage=all&status=all')).toHaveLength(2);
    expect((await call('GET', `/projects/${ctx.projectId}/approvals?status=all&stage=role_review`, ctx.memberToken)).json.data.approvals.map((a) => a.id)).toEqual([approvalId]);
  });

  it('담당과 대표가 동시에 결정하면 한쪽만 이긴다', async () => {
    const ctx = await setup();
    const { approvalId } = await submitToApproval(ctx);
    const results = await Promise.all([
      call('POST', `/approvals/${approvalId}/approve`, ctx.memberToken),
      call('POST', `/approvals/${approvalId}/reject`, ctx.repToken, { reason: '동시에' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.json.error.code).toBe('APPROVAL_ALREADY_DECIDED');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM approvals WHERE subject_id = $1 AND decision IS NULL`, [ctx.taskId]);
    const approved = results.some((r) => r.status === 200 && r.json.data.decision === 'APPROVE');
    expect(rows[0]!.n).toBe(approved ? 1 : 0);
    expect((await taskRow(ctx.taskId)).state).toBe(approved ? 'AWAITING_APPROVAL' : 'READY');
  });

  it('태스크가 승인 대기가 아니면 담당도 409 APPROVAL_STALE', async () => {
    const ctx = await setup();
    const { approvalId } = await submitToApproval(ctx);
    await pool.query(`UPDATE tasks SET state = 'ESCALATED' WHERE id = $1`, [ctx.taskId]);
    const res = await call('POST', `/approvals/${approvalId}/approve`, ctx.memberToken);
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('APPROVAL_STALE');
  });

  it('중단한 프로젝트의 카드는 409, 지운 프로젝트의 카드는 404', async () => {
    const ctx = await setup();
    const { approvalId } = await submitToApproval(ctx);
    expect((await call('POST', `/projects/${ctx.projectId}/abort`, ctx.repToken, { reason: '중단' })).status).toBe(200);
    for (const token of [ctx.memberToken, ctx.repToken]) {
      const res = await call('POST', `/approvals/${approvalId}/approve`, token);
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe('PROJECT_NOT_OPEN');
    }
    expect((await call('GET', '/me/approvals', ctx.memberToken)).json.data.approvals).toEqual([]);

    expect((await call('DELETE', `/projects/${ctx.projectId}`, ctx.repToken)).status).toBe(200);
    const gone = await call('POST', `/approvals/${approvalId}/approve`, ctx.repToken);
    expect(gone.status).toBe(404);
    expect(gone.json.error.code).toBe('APPROVAL_NOT_FOUND');
  });

  it('030 이전에 대기 중이던 카드는 final이 되어 대표가 결정한다', async () => {
    const ctx = await setup();
    const { approvalId } = await submitToApproval(ctx);

    // 두 단계가 없던 시절을 재현한다: 030을 내렸다가 다시 올린다.
    await rollbackFrom('030_approval_role_review.sql');
    await reapplyFrom('030_approval_role_review.sql');
    const { rows } = await pool.query(`SELECT stage, reviewer_user_id FROM approvals WHERE id = $1`, [approvalId]);
    expect(rows[0]).toMatchObject({ stage: 'final', reviewer_user_id: null });

    expect((await call('POST', `/approvals/${approvalId}/approve`, ctx.memberToken)).status).toBe(403);
    expect((await call('POST', `/approvals/${approvalId}/approve`, ctx.repToken)).json.data.taskState).toBe('DONE');
  });

  it('DB가 단계 규칙을 막는다 — role_review에는 검토자, G3는 final만', async () => {
    const ctx = await setup();
    await expect(
      pool.query(`INSERT INTO approvals (project_id, gate, subject_id, payload, stage) VALUES ($1, 'G3', $1, '{}', 'role_review')`, [ctx.projectId]),
    ).rejects.toThrow(/approvals_reviewer_chk|approvals_role_review_gate_chk/);
    await expect(
      pool.query(`INSERT INTO approvals (project_id, gate, subject_id, payload, stage, reviewer_user_id) VALUES ($1, 'G3', $1, '{}', 'role_review', $2)`, [ctx.projectId, ctx.memberUserId]),
    ).rejects.toThrow(/approvals_role_review_gate_chk/);
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
