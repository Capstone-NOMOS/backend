import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { clearPolicyCache } from '../src/domain/policy/policy-cache.js';
import { setGithubDeviceApi } from '../src/domain/oauth/service.js';
import { env } from '../src/config/env.js';
import { setPmModel } from '../src/domain/pm/model.js';
import { drainPmJobs } from '../src/domain/pm/service.js';
import type { GithubDeviceApi } from '../src/domain/oauth/github-device.js';
import { setGithubRepApi, type GithubRepApi } from '../src/domain/github/rep-api.js';
import {
  gitMirrorInspector,
  setCommitInspector,
} from '../src/domain/verification/commit-inspector.js';
import { loadSpec, seenOperations, toOasPath } from './helpers/openapi-contract.js';
import { resetSchema, testPool } from './test-db.js';

// docs/openapi.yaml이 FE 타입 생성의 원본이다(openapi-typescript). 이 파일은 두 가지를 고정한다.
//   1) 라우트와 문서가 1:1이다 — 문서에 없는 API, 코드에 없는 문서가 없다. 모든 성공 응답에 schema가 있다.
//   2) 모든 성공 응답을 실제 HTTP로 한 번씩 받아 본다. 응답 검사는 setup-invariants.ts가 res.json에서 하므로,
//      여기서는 "빠짐없이 부른다"만 책임진다. 다른 테스트가 서비스 함수만 부르는 API도 여기서 HTTP를 탄다.

const METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;

type RouteLayer = { route?: { path: string; methods: Record<string, boolean> } };

// src/routes/*.ts가 내보내는 Router를 전부 모은다. 라우터 파일을 새로 만들어도 빠지지 않게 목록을 손으로 적지 않는다.
// /docs 라우터는 /api 밖이라 제외한다.
async function collectApiRoutes(): Promise<Set<string>> {
  const modules = import.meta.glob<Record<string, unknown>>(['../src/routes/*.ts', '!../src/routes/docs.ts'], { eager: true });
  expect(Object.keys(modules).length, 'src/routes/*.ts를 하나도 못 읽었다').toBeGreaterThan(0);
  const routes = new Set<string>();
  for (const mod of Object.values(modules)) {
    for (const value of Object.values(mod)) {
      const stack = (value as { stack?: RouteLayer[] } | null)?.stack;
      if (typeof value !== 'function' || !Array.isArray(stack)) continue;
      for (const layer of stack) {
        if (!layer.route) continue;
        for (const [method, on] of Object.entries(layer.route.methods)) {
          if (on && method !== '_all') routes.add(`${method} ${toOasPath(layer.route.path)}`);
        }
      }
    }
  }
  return routes;
}

function documentedOperations(): Map<string, string[]> {
  const ops = new Map<string, string[]>();
  for (const [p, item] of Object.entries(loadSpec().paths)) {
    for (const m of METHODS) {
      const op = (item as Record<string, { responses?: Record<string, unknown> }>)[m];
      if (op) ops.set(`${m} ${p}`, Object.keys(op.responses ?? {}).filter((s) => s.startsWith('2')));
    }
  }
  return ops;
}

describe('문서와 라우트가 1:1이다', () => {
  it('코드의 모든 /api 라우트가 문서에 있고, 문서의 모든 경로가 코드에 있다', async () => {
    const code = await collectApiRoutes();
    const docs = new Set(documentedOperations().keys());
    expect([...code].filter((r) => !docs.has(r)), '문서에 없는 라우트').toEqual([]);
    expect([...docs].filter((r) => !code.has(r)), '코드에 없는 문서').toEqual([]);
  });

  it('모든 성공 응답에 schema가 있다 — example만으로는 FE가 타입을 만들 수 없다', () => {
    const missing: string[] = [];
    for (const [p, item] of Object.entries(loadSpec().paths)) {
      for (const m of METHODS) {
        const op = (item as Record<string, { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }>)[m];
        for (const [status, res] of Object.entries(op?.responses ?? {})) {
          if (status.startsWith('2') && !res.content?.['application/json']?.schema) missing.push(`${m} ${p} ${status}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

// ─── 모든 성공 응답을 HTTP로 한 번씩 ──────────────────────────────────────────

let server: Server;
let baseUrl: string;
let restoreGithub: GithubDeviceApi;
let restoreGithubRep: GithubRepApi;

// 대표 토큰으로 부르는 GitHub 쓰기 API(레포 만들기·협업자 초대)도 가짜로.
const fakeGithubRep: GithubRepApi = {
  async listOrgs() {
    return ['acme'];
  },
  async createOrgRepo(_token, input) {
    return { fullName: `${input.org}/${input.name}`, githubRepoId: 123456, defaultBranch: 'main' };
  },
  async inviteCollaborator() {
    return 'invited';
  },
};

const fakeGithub: GithubDeviceApi = {
  async requestDeviceCode() {
    return { deviceCode: 'dev-code', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 };
  },
  async exchangeDeviceCode(code) {
    return code === 'dev-code'
      ? { status: 'ok', accessToken: 'gho_contract_test', scope: 'repo' }
      : { status: 'pending' };
  },
  async fetchViewer() {
    return { githubId: 424242, githubLogin: 'octo-rep' };
  },
};

beforeAll(async () => {
  await resetSchema();
  clearPolicyCache();
  restoreGithub = setGithubDeviceApi(fakeGithub);
  restoreGithubRep = setGithubRepApi(fakeGithubRep);
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setGithubDeviceApi(restoreGithub);
  setGithubRepApi(restoreGithubRep);
  setCommitInspector(gitMirrorInspector());
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

type Res = { status: number; data: Record<string, unknown> };

async function call(method: string, url: string, token: string | null, body?: unknown): Promise<Res> {
  const res = await fetch(`${baseUrl}/api${url}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { data?: Record<string, unknown>; error?: unknown };
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(json.error)}`);
  return { status: res.status, data: json.data ?? {} };
}

// 한 흐름으로 온보딩부터 검증 보고까지 전부 부른다. 순서가 곧 실제 사용 순서다.
describe('모든 성공 응답을 실제로 받아 문서와 대조한다', () => {
  it('온보딩 → 프로젝트 → 태스크 → 제출 → 검증 → 노트', async () => {
    const pw = 'correct-horse-battery';

    // 인증·계정
    const repSignup = await call('POST', '/auth/signup', null, { loginId: 'rep', password: pw, nickname: '대표' });
    await call('POST', '/auth/signup', null, { loginId: 'be-dev', password: pw, nickname: '백엔드' });
    const rep = (await call('POST', '/auth/login', null, { loginId: 'rep', password: pw })).data.accessToken as string;
    const be = (await call('POST', '/auth/login', null, { loginId: 'be-dev', password: pw })).data.accessToken as string;
    await call('GET', '/me', be); // 조직 없음 → null들
    const rotated = await call('POST', '/me/connect-key/rotate', be);

    // 조직·초대
    const orgId = (await call('POST', '/orgs', rep, { name: 'Acme Inc.' })).data.orgId as string;
    const invite = await call('POST', `/orgs/${orgId}/invites`, rep, { teamRole: 'BACKEND' });
    const inviteToken = invite.data.token as string;
    await call('GET', `/invites/${inviteToken}`, null);
    await call('POST', `/invites/${inviteToken}/accept`, be);
    await call('GET', '/me', rep);
    await call('GET', `/orgs/${orgId}/members`, rep);

    // CLI 연결 — 대표 것은 배정 해제 확인용
    const beConn = await call('POST', '/agents/connect', null, {
      connectKey: rotated.data.connectKey, agentName: 'be-laptop', harness: 'claude-code@test', skills: ['typescript'], maxConcurrent: 1,
    });
    const repConn = await call('POST', '/agents/connect', null, {
      connectKey: repSignup.data.connectKey, agentName: 'rep-laptop', harness: 'claude-code@test',
    });
    await call('GET', `/orgs/${orgId}/agents`, rep);

    // 브라우저 승인(device flow) — 승인 하나, 거부 하나
    const device = await call('POST', '/agents/device/start', null, { agentName: 'web-laptop', harness: 'claude-code' });
    const deviceCode = device.data.deviceCode as string;
    const userCode = device.data.userCode as string;
    await call('POST', '/agents/device/poll', null, { deviceCode });
    await call('GET', `/agents/device/requests/${userCode}`, rep);
    await call('POST', `/agents/device/requests/${userCode}/approve`, rep);
    await pool.query(`UPDATE agent_device_requests SET last_polled_at = NULL`); // poll 간격 검사를 건너뛴다
    await call('POST', '/agents/device/poll', null, { deviceCode });
    const denied = await call('POST', '/agents/device/start', null, { agentName: 'other-laptop', harness: 'claude-code' });
    await call('POST', `/agents/device/requests/${denied.data.userCode as string}/deny`, rep);

    // GitHub 연동(가짜 API) — 대표의 GitHub 연결
    await call('POST', '/auth/github/device/start', rep);
    await call('POST', '/auth/github/device/poll', rep, { deviceCode: 'still-waiting' });
    await call('POST', '/auth/github/device/poll', rep, { deviceCode: 'dev-code' });

    // 레포·경로
    await call('GET', `/orgs/${orgId}/github/repos`, be);
    const connected = await call('POST', `/orgs/${orgId}/repos`, be, { repos: [{ fullName: 'acme/study-api' }] });
    const repoId = (connected.data.repos as { id: string }[])[0]!.id;
    await call('PATCH', `/repos/${repoId}`, rep, { githubRepoId: 987654321, cloneUrl: 'https://github.com/acme/study-api' });
    const paths = (await call('GET', `/repos/${repoId}/paths`, rep)).data.paths as { id: string; pathPattern: string }[];
    const root = paths.find((p) => p.pathPattern === '**')!;
    await call('PATCH', `/repos/${repoId}/paths/${root.id}`, rep, { ownerRole: 'BACKEND' });
    await call('POST', `/repos/${repoId}/paths`, rep, { pathPattern: 'docs/**', access: 'read' });
    await call('GET', `/orgs/${orgId}/repos`, rep);
    // GitHub 조직에 레포 만들기(대표) — 프로젝트에는 위 레포만 넣는다.
    await call('GET', `/orgs/${orgId}/github/orgs`, rep);
    await call('POST', `/orgs/${orgId}/github/repos`, rep, { githubOrg: 'acme', name: 'study-web', ownerRole: 'FRONTEND' });

    // 프로젝트·배정
    const created = await call('POST', `/orgs/${orgId}/projects`, rep, {
      name: '스터디 v1', autonomyPreset: 'L2', pmBudgetUsd: 10, deadline: '2026-12-31', repoIds: [repoId],
    });
    const projectId = (created.data.project as { id: string }).id;
    await call('GET', `/orgs/${orgId}/projects`, rep);
    await call('GET', `/projects/${projectId}`, rep);
    const beAgentId = beConn.data.agentId as string;
    const repAgentId = repConn.data.agentId as string;
    await call('POST', `/projects/${projectId}/members`, rep, { agentId: repAgentId, teamRole: 'FRONTEND' });
    await call('DELETE', `/projects/${projectId}/members/${repAgentId}`, rep);
    await call('POST', `/projects/${projectId}/members`, rep, { agentId: beAgentId, teamRole: 'BACKEND' });
    await call('POST', `/projects/${projectId}/members/${beAgentId}/github-invite`, rep);

    // 명세·태스크 작성
    const spec = await call('POST', `/projects/${projectId}/specs`, rep, {
      featureKey: 'F-03',
      title: '참여 신청',
      content: 'WHEN 정원이 차면 THEN 409',
      tests: [{ criterion: '정원 초과는 409', testCode: 'expect(res.status).toBe(409)', locked: true }],
    });
    await call('GET', `/projects/${projectId}/specs`, rep);
    const task = await call('POST', `/projects/${projectId}/tasks`, rep, {
      title: 'T-1 참여신청 API', teamRole: 'BACKEND', repoId, specId: spec.data.id,
    });
    const taskId = task.data.id as string;

    // 에이전트 — 배정 뒤 재발급해야 project_id가 담긴다
    const agent = (await call('POST', '/agents/token/refresh', null, { refreshToken: beConn.data.refreshToken })).data
      .accessToken as string;
    await call('GET', '/agents/me', agent);
    await call('GET', `/projects/${projectId}/tasks`, agent);
    await call('GET', `/projects/${projectId}/specs`, agent);
    await call('GET', `/projects/${projectId}/tasks`, rep);
    await call('GET', `/projects/${projectId}/events?limit=20`, rep);
    await call('GET', `/tasks/${taskId}/briefing`, agent);
    await call('PATCH', `/tasks/${taskId}/branch`, agent, { branchName: `task/${taskId}` });
    // 프로젝트 시작(G1) — 이때부터 에이전트가 태스크를 받는다(푸시와 같은 목록을 HTTP로도 읽는다).
    await call('POST', `/projects/${projectId}/start`, rep);
    await call('GET', '/agents/me/tasks', agent);
    await call('POST', `/tasks/${taskId}/claim`, agent);
    // 룸: Executor의 실행 시작·도구 사용 보고
    await call('POST', `/tasks/${taskId}/runs/start`, agent);
    await call('POST', `/tasks/${taskId}/activity`, agent, { items: [{ kind: 'read', target: 'src/api/join.ts' }, { kind: 'run', target: 'npm test' }] });

    // 제출 — 커밋 diff는 가짜 검사기로. 신고와 같게 두면 V3는 PASS다.
    setCommitInspector({ kind: 'fake', async changedPaths() { return ['src/api/join.ts']; } });
    const submitted = await call('POST', `/tasks/${taskId}/artifacts`, agent, {
      commitSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', changedPaths: ['src/api/join.ts'],
    });
    const artifactId = submitted.data.id as string;
    await call('POST', `/tasks/${taskId}/runs/end`, agent, { outcome: 'completed', committed: true, durationMs: 1200, exitCode: 0 });
    await call('GET', `/projects/${projectId}/rooms`, rep);
    await call('GET', `/projects/${projectId}/rooms/BACKEND/feed?limit=20`, rep);
    await call('GET', `/tasks/${taskId}/artifacts`, agent);
    await call('GET', `/tasks/${taskId}/artifacts`, rep);
    await call('POST', `/artifacts/${artifactId}/verifications`, agent, { stage: 'V4', result: 'PASS', durationMs: 1200 });
    await call('GET', `/artifacts/${artifactId}/verifications`, agent);
    await call('GET', `/artifacts/${artifactId}/verifications`, rep);

    // 승인 대기열 — L2에서 db:migration은 HUMAN이라 검증을 통과해도 대표 승인을 기다린다. 하나는 승인, 하나는 반려.
    setCommitInspector({ kind: 'fake', async changedPaths() { return ['migrations/020_x.sql']; } });
    const approvalIds: string[] = [];
    for (const title of ['T-2 스키마 추가', 'T-3 인덱스 추가']) {
      const t = (await call('POST', `/projects/${projectId}/tasks`, rep, { title, teamRole: 'BACKEND', repoId, specId: spec.data.id })).data.id as string;
      await call('POST', `/tasks/${t}/claim`, agent);
      const a = await call('POST', `/tasks/${t}/artifacts`, agent, { commitSha: 'b1b2c3d', changedPaths: ['migrations/020_x.sql'] });
      await call('POST', `/artifacts/${a.data.id as string}/verifications`, agent, { stage: 'V2', result: 'SKIPPED', detail: { reason: '시험 실행기 없음' } });
      const v = await call('POST', `/artifacts/${a.data.id as string}/verifications`, agent, { stage: 'V4', result: 'PASS' });
      approvalIds.push(v.data.approvalId as string);
    }
    await call('GET', `/orgs/${orgId}/approvals`, rep);
    await call('POST', `/approvals/${approvalIds[0]!}/approve`, rep);
    await call('POST', `/approvals/${approvalIds[1]!}/reject`, rep, { reason: 'down 마이그레이션이 없다' });
    await call('GET', `/projects/${projectId}/approvals?status=all`, rep);

    // 인계 노트
    await call('POST', `/tasks/${taskId}/notes`, agent, {
      kind: 'DECIDED', headline: '정원 초과는 409로 통일', keyPoints: ['정원 검사는 트랜잭션 안에서 한다'], affects: [],
    });
    // 에러 응답도 공통 Error 형태여야 한다. details가 실리는 유일한 코드(NOTE_INVALID)를 한 번 받아 본다.
    const invalid = await fetch(`${baseUrl}/api/tasks/${taskId}/notes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'DEVIATION', headline: '', keyPoints: [], affects: [] }),
    });
    expect(invalid.status).toBe(422);
    expect(((await invalid.json()) as { error: { details: unknown[] } }).error.details.length).toBeGreaterThan(0);

    await call('GET', `/projects/${projectId}/notes`, agent);
    await call('GET', `/projects/${projectId}/notes?since_seq=0`, rep);

    // 내장 PM(가짜 모델) — 요청 → 초안 → 수정 요청 → 적용
    const draft = (key: string, suffix: string) => ({
      mode: 'SEQUENTIAL',
      rationale: '작다',
      estimate: { workingDays: 3, notes: '' },
      specs: [{ featureKey: key, title: '출석', content: 'WHEN 출석하면 THEN 기록한다' }],
      tasks: [{ ref: 'att', title: `T-20 출석 API${suffix}`, repo: 'acme/study-api', teamRole: 'BACKEND', kind: 'IMPLEMENT', spec: key, dependsOn: [] }],
    });
    const drafts = [draft('F-20', ''), draft('F-21', ' v2')];
    setPmModel({
      kind: 'fake',
      async generate() {
        const d = drafts.shift()!;
        return { stopReason: 'end_turn', servedModel: 'claude-sonnet-5-5', text: JSON.stringify(d), attempts: [{ model: 'claude-sonnet-5-5', inputTokens: 100, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 }] };
      },
    });
    try {
      await call('GET', `/projects/${projectId}/pm/status`, rep);
      const requested = await call('POST', `/projects/${projectId}/pm/plans`, rep, { instruction: '출석 기능' });
      await drainPmJobs();
      const planId = requested.data.id as string;
      await call('GET', `/projects/${projectId}/pm/plans/${planId}`, rep);
      const revised = await call('POST', `/projects/${projectId}/pm/plans/${planId}/revise`, rep, { feedback: '제목에 v2' });
      await drainPmJobs();
      await call('GET', `/projects/${projectId}/pm/plans`, rep);
      await call('POST', `/projects/${projectId}/pm/plans/${revised.data.id as string}/apply`, rep);
    } finally {
      setPmModel(null);
    }

    // 중계 모드 — 대표 노트북의 pm-worker가 가져가고(결과·실패) 돌려준다.
    const mutableEnv = env as { PM_PROVIDER: 'api' | 'relay' };
    mutableEnv.PM_PROVIDER = 'relay';
    try {
      const worker = repConn.data.accessToken as string;
      const nextJob = async () => {
        for (let i = 0; i < 100; i += 1) {
          const { job } = (await call('GET', '/pm/jobs/next', worker)).data as { job: { id: string } | null };
          if (job) return job.id;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error('no relay job');
      };
      const relayed = await call('POST', `/projects/${projectId}/pm/plans`, rep, { instruction: '출석 통계' });
      await call('POST', `/pm/jobs/${await nextJob()}/result`, worker, {
        stopReason: 'end_turn', servedModel: 'claude-sonnet-5-5', text: JSON.stringify(draft('F-22', ' v3')),
        usage: { inputTokens: 100, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 },
      });
      await drainPmJobs();
      // 반려 — 다시 받지 않고 닫는다.
      await call('POST', `/projects/${projectId}/pm/plans/${relayed.data.id as string}/reject`, rep, { reason: '이번 범위가 아니다' });
      await call('POST', `/projects/${projectId}/pm/plans`, rep, { instruction: '출석 알림' });
      await call('POST', `/pm/jobs/${await nextJob()}/failure`, worker, { message: 'Not logged in' });
      await drainPmJobs();
    } finally {
      mutableEnv.PM_PROVIDER = 'api';
    }
  });

  it('문서의 모든 성공 응답을 위 흐름에서 한 번 이상 받았다', () => {
    const expected: string[] = [];
    for (const [op, statuses] of documentedOperations()) for (const s of statuses) expected.push(`${op} ${s}`);
    expect(expected.filter((e) => !seenOperations.has(e)), '한 번도 받아 보지 못한 성공 응답').toEqual([]);
  });
});
