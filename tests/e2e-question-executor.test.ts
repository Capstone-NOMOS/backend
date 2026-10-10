import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { createSpec, createTask } from '../src/domain/authoring/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { attachAgentStream, type AgentStream } from '../src/realtime/agent-stream.js';
import { resetSchema, testPool } from './test-db.js';

// 질문 중계의 재개(C1)·답할 쪽 꺼짐(C3) — **배포되는 CLI 빌드 그대로**(packages/cli/dist) Executor 둘을 띄워 확인한다.
//   C1: BE Executor는 켜져 있고 BE 코드에 답이 없다 → 상담 '미정' → FE가 기다리다 내려놓음(BLOCKED·QUESTION)
//       → BE 담당자가 답 → READY → FE Executor가 푸시를 받아 같은 작업공간에서 재개 → 커밋·제출
//   C3: BE Executor가 꺼져 있고 BE 코드에 답이 있다 → FE가 내려놓음 → 나중에 BE Executor를 켬
//       → 연결 직후 확인으로 밀린 질문을 상담 → 전부 코드에 정해져 있어 곧 답(agent_answered) → 사람 없이 FE 재개
// 사용자 구독으로 돈다: npm run build:cli && RUN_CLAUDE_E2E=1 npx vitest run tests/e2e-question-executor.test.ts
// 결과(Executor 로그·타임라인)는 실행마다 임시 폴더에 남기고 경로를 출력한다.

const RUN = process.env.RUN_CLAUDE_E2E === '1';
const PASSWORD = 'correct-horse-battery';
// 기본 3분 대신 짧게 — 재개 경로를 보는 실험이라 기다림 자체는 줄인다.
const INLINE_WAIT_MS = Number(process.env.E2E_INLINE_WAIT_MS ?? 90_000);
const CLI = path.resolve('packages/cli/dist/executor/cli.js');
const HUMAN_DECISION = 'BE 결정: 200 { data: { members: [ { userId, nickname, memberSince } ] } } — memberSince는 ISO-8601 UTC 문자열, 페이지네이션 없음';
// 서버 비밀값·테스트 DB 주소는 Executor에 넘기지 않는다. API 키가 있으면 구독 대신 API로 과금되므로 뺀다.
const STRIP_ENV = ['DATABASE_URL', 'JWT_SECRET', 'SECRET_ENCRYPTION_KEY', 'GITHUB_CLIENT_ID', 'COMMIT_INSPECTOR', 'API_BASE_URL', 'FRONTEND_BASE_URL', 'ANTHROPIC_API_KEY', 'NODE_ENV', 'VITEST', 'LOG_LEVEL'];

let server: Server;
let stream: AgentStream;
let baseUrl: string;

beforeAll(async () => {
  await resetSchema();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  stream = attachAgentStream(server);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await stream.close();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
}

function gitInit(dir: string): void {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=e2e@test', '-c', 'user.name=e2e', 'add', '-A');
  git('-c', 'user.email=e2e@test', '-c', 'user.name=e2e', 'commit', '-qm', 'init');
}

const MEMBERS_CODE =
  "import { ok } from '../http.ts';\n\n// GET /api/studies/:id/members — 페이지네이션 없음(정원 최대 30명).\n// 가입일 필드 이름은 memberSince(ISO-8601 UTC). 닉네임은 nickname, 식별자는 userId.\ntype MemberView = { userId: string; nickname: string; memberSince: string };\n\nexport function listMembers(rows: { user_id: string; nickname: string; joined_at: Date }[]) {\n  const members: MemberView[] = rows.map((r) => ({ userId: r.user_id, nickname: r.nickname, memberSince: r.joined_at.toISOString() }));\n  return ok({ members });\n}\n";

type Scenario = { name: string; beHasAnswer: boolean; beOnlineFromStart: boolean };

async function runScenario(s: Scenario) {
  const prefix = s.name.toLowerCase();
  const rep = await signup({ loginId: `${prefix}-rep`, password: PASSWORD, nickname: 'rep' });
  const fe = await signup({ loginId: `${prefix}-fe`, password: PASSWORD, nickname: 'fe' });
  const be = await signup({ loginId: `${prefix}-be`, password: PASSWORD, nickname: 'be' });
  const { orgId } = await createOrganization(rep.userId, `Acme-${s.name}`);
  for (const u of [fe, be]) {
    const { token } = await createInvite(orgId, rep.userId);
    await acceptInvite(token, u.userId);
  }
  const [web, api] = await connectRepos({
    orgId,
    actorUserId: rep.userId,
    actorOrgRole: 'REPRESENTATIVE',
    repos: [{ fullName: `${prefix}/study-web`, ownerRole: 'FRONTEND' }, { fullName: `${prefix}/study-api`, ownerRole: 'BACKEND' }],
  });
  const { project } = await createProject(orgId, rep.userId, { name: `E2E-${s.name}`, autonomyPreset: 'L2', pmBudgetUsd: 5, repoIds: [web!.id, api!.id] });
  const repActor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' as const };
  const feAgent = await connectAgent({ connectKey: fe.connectKey, agentName: 'fe-mbp', harness: 'claude-code', skills: [], maxConcurrent: 1 });
  const beAgent = await connectAgent({ connectKey: be.connectKey, agentName: 'be-mbp', harness: 'claude-code', skills: [], maxConcurrent: 1 });
  await assignMember(repActor, project.id, feAgent.agentId, 'FRONTEND');
  await assignMember(repActor, project.id, beAgent.agentId, 'BACKEND');
  const spec = await createSpec(rep.userId, project.id, {
    featureKey: 'F-10',
    title: '스터디 멤버 목록 화면',
    content:
      '스터디 상세 페이지(/studies/:id)에 멤버 목록을 보여 준다.\n- 멤버 목록은 백엔드 API GET /api/studies/:id/members 에서 받는다(백엔드 팀이 구현 중).\n- 각 멤버의 닉네임과 가입일을 표시한다.\n- WHEN 멤버가 없으면 THEN "아직 멤버가 없습니다"를 보여 준다.',
    tests: [],
  });
  const task = await createTask(rep.userId, project.id, { title: 'F-10 스터디 멤버 목록 화면', teamRole: 'FRONTEND', kind: 'IMPLEMENT', repoId: web!.id, specId: spec.id, dependsOn: [] });

  // --- 레포·NOMOS_HOME(에이전트마다) ---
  const root = mkdtempSync(path.join(tmpdir(), `nomos-e2e-${prefix}-`));
  const beDir = path.join(root, 'study-api');
  write(beDir, {
    'package.json': '{ "name": "study-api", "private": true, "type": "module" }\n',
    'src/http.ts': '// 모든 성공 응답은 { data: ... }로 감싼다. 목록은 { data: { <복수명>: [...] } }.\nexport const ok = <T>(body: T) => ({ status: 200, json: { data: body } });\n',
    ...(s.beHasAnswer ? { 'src/routes/members.ts': MEMBERS_CODE } : {}),
  });
  gitInit(beDir);
  const feDir = path.join(root, 'study-web');
  write(feDir, {
    'package.json': '{ "name": "study-web", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
    'src/api/client.ts': "export async function apiGet<T>(p: string): Promise<T> {\n  const res = await fetch(`/api${p}`);\n  if (!res.ok) throw new Error(`GET ${p} failed: ${res.status}`);\n  return (await res.json()) as T;\n}\n",
    'src/pages/StudyPage.tsx': 'export function StudyPage({ studyId }: { studyId: string }) {\n  return <main><h1>스터디 {studyId}</h1></main>;\n}\n',
  });
  gitInit(feDir);

  const homeFor = async (name: string, agent: { agentId: string; refreshToken: string }, repos: Record<string, string>) => {
    const home = path.join(root, `${name}-home`);
    mkdirSync(home, { recursive: true });
    // 배정 뒤 재발급해야 토큰에 project_id가 실린다.
    const { accessToken } = await refreshAgentToken(agent.refreshToken);
    writeFileSync(path.join(home, 'credentials'), JSON.stringify({ baseUrl, accessToken, refreshToken: agent.refreshToken, agentId: agent.agentId }, null, 2));
    writeFileSync(path.join(home, 'repos.json'), JSON.stringify(repos, null, 2));
    return home;
  };
  const feHome = await homeFor('fe', feAgent, { [`${prefix}/study-web`]: feDir });
  const beHome = await homeFor('be', beAgent, { [`${prefix}/study-api`]: beDir });

  const children: ChildProcess[] = [];
  const startExecutor = (name: string, home: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NOMOS_HOME: home, NOMOS_QUESTION_INLINE_WAIT_MS: String(INLINE_WAIT_MS) };
    for (const k of STRIP_ENV) delete env[k];
    const child = spawn(process.execPath, [CLI, 'start'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = createWriteStream(path.join(root, `${name}-executor.log`));
    child.stdout!.pipe(out);
    child.stderr!.pipe(out);
    children.push(child);
    return child;
  };

  const t0 = Date.now();
  const timeline: string[] = [];
  const mark = (line: string) => timeline.push(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s ${line}`);
  const taskState = async () => (await pool.query(`SELECT state, blocked_reason, retry_count FROM tasks WHERE id = $1`, [task.id])).rows[0] as { state: string; blocked_reason: string | null; retry_count: number };
  const waitFor = async (what: string, cond: () => Promise<boolean>, maxMs: number) => {
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      if (await cond()) {
        mark(what);
        return true;
      }
      await sleep(2_000);
    }
    mark(`시간 초과: ${what}`);
    return false;
  };

  try {
    if (s.beOnlineFromStart) startExecutor('be', beHome);
    startExecutor('fe', feHome);
    await startProject(repActor, project.id);
    mark(`프로젝트 시작 (BE Executor ${s.beOnlineFromStart ? '켜짐' : '꺼짐'}, BE 코드에 답 ${s.beHasAnswer ? '있음' : '없음'})`);

    await waitFor('FE가 질문함', async () => (await pool.query(`SELECT 1 FROM agent_questions WHERE task_id = $1`, [task.id])).rowCount! > 0, 15 * 60_000);
    await waitFor('FE가 태스크를 내려놓음(BLOCKED·QUESTION)', async () => {
      const st = await taskState();
      return st.state !== 'CLAIMED' && st.state !== 'READY';
    }, INLINE_WAIT_MS + 5 * 60_000);
    mark(`태스크 ${JSON.stringify(await taskState())}`);

    if (!s.beOnlineFromStart) {
      await sleep(5_000);
      startExecutor('be', beHome);
      mark('BE Executor를 켬');
    }

    if (!s.beHasAnswer) {
      // 상담 초안(미정)이 올라오기를 기다렸다가 BE 담당자가 답한다 — 초안에서 정해진 것은 그대로, 미정인 것은 결정해서.
      await waitFor('BE 상담 초안', async () => (await pool.query(`SELECT 1 FROM agent_questions WHERE task_id = $1 AND draft IS NOT NULL`, [task.id])).rowCount! > 0, 5 * 60_000);
      const beToken = (await login({ loginId: `${prefix}-be`, password: PASSWORD })).accessToken;
      const mine = await fetch(`${baseUrl}/api/me/questions`, { headers: { Authorization: `Bearer ${beToken}` } });
      type Q = { id: string; questions: { question: string }[]; draft: { answers: Record<string, string>; decided: Record<string, boolean> } | null };
      const body = (await mine.json()) as { data?: { questions: { question: Q; projectName: string; taskTitle: string }[] } };
      if (!body.data) throw new Error(`/me/questions ${mine.status}: ${JSON.stringify(body)}`);
      mark(`BE 담당자의 /me/questions: ${body.data.questions.map((x) => `${x.projectName} · ${x.taskTitle}`).join(', ')}`);
      for (const { question: q } of body.data.questions) {
        const answers = Object.fromEntries(q.questions.map((x) => [x.question, q.draft?.decided[x.question] ? q.draft.answers[x.question]! : HUMAN_DECISION]));
        const res = await fetch(`${baseUrl}/api/questions/${q.id}/answer`, { method: 'POST', headers: { Authorization: `Bearer ${beToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) });
        mark(`BE 담당자 답 ${res.status}`);
      }
    }

    await waitFor('태스크 결론(제출 이후 또는 멈춤)', async () => ['VERIFYING', 'AWAITING_APPROVAL', 'DONE', 'ESCALATED'].includes((await taskState()).state) || (await taskState()).blocked_reason === 'AGENT_STOPPED', 25 * 60_000);
    // 제출 뒤 Executor의 V2·V4 보고까지
    await waitFor('검증 결론', async () => ['AWAITING_APPROVAL', 'DONE', 'ESCALATED', 'BLOCKED', 'READY'].includes((await taskState()).state), 5 * 60_000);
  } finally {
    for (const c of children) c.kill();
  }

  // --- 결과 ---
  const final = await taskState();
  const events = (await pool.query(
    `SELECT ts, type, payload FROM events WHERE project_id = $1 AND type NOT IN ('PROJECT_CREATED','MEMBER_ASSIGNED','SPEC_CREATED','TASK_CREATED') ORDER BY ts`,
    [project.id],
  )).rows.map((e) => `${String(Math.round((new Date(e.ts as string).getTime() - t0) / 1000)).padStart(4)}s ${e.type} ${JSON.stringify(e.payload).slice(0, 160)}`);
  const questions = (await pool.query(`SELECT status, answer_source, draft, created_at, answered_at FROM agent_questions WHERE task_id = $1 ORDER BY created_at`, [task.id])).rows;
  const ws = path.join(feHome, 'workspaces', project.id, task.id);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: ws }).toString().trim();
  let commits: string[] = [];
  let code = '';
  try {
    commits = git('log', '--format=%h %s', 'main..HEAD').split('\n').filter(Boolean);
    code = git('diff', 'main..HEAD').toString();
  } catch (err) {
    commits = [`작업공간 읽기 실패: ${(err as Error).message}`];
  }
  const repToken = (await login({ loginId: `${prefix}-rep`, password: PASSWORD })).accessToken;
  const feed = (await (await fetch(`${baseUrl}/api/projects/${project.id}/rooms/FRONTEND/feed`, { headers: { Authorization: `Bearer ${repToken}` } })).json()) as { data: { messages: { speaker: string; text: string }[] } };
  const report = {
    scenario: s,
    root,
    final,
    timeline,
    questions: questions.map((q) => ({ status: q.status, source: q.answer_source, decided: q.draft?.decided ?? null })),
    events,
    commits,
    usesAnswer: { memberSince: code.includes('memberSince'), members: code.includes('members') },
    room: [...feed.data.messages].reverse().map((m) => `[${m.speaker}] ${m.text}`),
  };
  writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  return report;
}

describe.skipIf(!RUN)('질문 중계 — 재개·답할 쪽 꺼짐 (Executor 실물)', () => {
  it('C1: 상담이 미정이면 FE가 내려놓고, BE 담당자가 답하면 같은 작업공간에서 재개해 제출한다', { timeout: 60 * 60_000 }, async () => {
    const r = await runScenario({ name: 'C1', beHasAnswer: false, beOnlineFromStart: true });
    expect(r.events.some((e) => e.includes('TASK_BLOCKED_ON_QUESTION'))).toBe(true);
    expect(r.final.retry_count).toBe(0);
    expect(r.usesAnswer.memberSince).toBe(true);
  });

  it('C3: BE가 꺼져 있다 켜지면 밀린 질문을 상담해 곧 답하고, 사람 없이 FE가 재개한다', { timeout: 60 * 60_000 }, async () => {
    const r = await runScenario({ name: 'C3', beHasAnswer: true, beOnlineFromStart: false });
    expect(r.questions[0]?.source).toBe('agent');
    expect(r.usesAnswer.memberSince).toBe(true);
  });
});
