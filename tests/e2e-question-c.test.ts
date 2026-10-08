import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { writeBriefingNotes } from '../src/bridge/briefing-notes.js';
import { buildClaudeArgs } from '../src/bridge/claude-args.js';
import { NomosClient } from '../src/bridge/nomos-client.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { createSpec, createTask } from '../src/domain/authoring/service.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { buildClaudePermissions } from '../src/domain/repo/claude-settings.js';
import { SEED_PATH_RULES } from '../src/domain/repo/seed-paths.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { runConsult } from '../src/executor/consult.js';
import { buildTaskPrompt, type PromptBriefing } from '../src/executor/prompt.js';
import { resolveClaudeCommand } from '../src/executor/runner.js';
import { resetSchema, testPool } from './test-db.js';

// C안 E2E — 진짜 헤드리스 Claude 셋(FE 태스크 실행, BE 상담 실행, 필요하면 FE 재개 실행).
//   ① FE가 BE 소관을 묻는다 → 서버 → BE 상담 실행(runConsult, 읽기 전용)이 BE 코드를 읽어 초안 → 전부 정해진 것이면 곧 답
//   ② 정해지지 않은 게 섞이면 FE는 90초만 기다리고 태스크를 내려놓는다(BLOCKED) → BE 담당(스크립트)이 답 → READY → FE 재개 실행
// 마지막 코드에 BE 코드에만 있는 필드 이름(memberSince)이 들어갔는지로 "답이 코드에서 왔다"를 확인한다.
// 사용자 구독으로 돈다: RUN_CLAUDE_E2E=1 npx vitest run tests/e2e-question-c.test.ts

const RUN = process.env.RUN_CLAUDE_E2E === '1';
const PASSWORD = 'correct-horse-battery';
const INLINE_WAIT_MS = 90_000;
// E2E_BE_EMPTY=1이면 BE에 멤버 API 코드가 아직 없다 — 상담은 '미정'으로 답하고, ②(멈춤 → 담당자 답 → 재개) 경로를 탄다.
const BE_EMPTY = process.env.E2E_BE_EMPTY === '1';
const HUMAN_DECISION = 'BE 결정: 200 { data: { members: [ { userId, nickname, memberSince } ] } } — memberSince는 ISO-8601 UTC 문자열, 페이지네이션 없음';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await resetSchema();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

function gitInit(dir: string): (...a: string[]) => string {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir }).toString().trim();
  git('init', '-q');
  git('-c', 'user.email=e2e@test', '-c', 'user.name=e2e', 'add', '-A');
  git('-c', 'user.email=e2e@test', '-c', 'user.name=e2e', 'commit', '-qm', 'init');
  return git;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
}

describe.skipIf(!RUN)('C안 E2E (진짜 Claude)', () => {
  it('BE 코드에 정해진 것은 상담 실행이 바로 답하고, 정해지지 않은 것은 멈췄다가 사람이 답하면 재개된다', { timeout: 40 * 60_000 }, async () => {
    // --- 세계 ---
    const rep = await signup({ loginId: 'rep', password: PASSWORD, nickname: 'rep' });
    const fe = await signup({ loginId: 'fe', password: PASSWORD, nickname: 'fe' });
    const be = await signup({ loginId: 'be', password: PASSWORD, nickname: 'be' });
    const { orgId } = await createOrganization(rep.userId, 'Acme');
    for (const u of [fe, be]) {
      const { token } = await createInvite(orgId, rep.userId);
      await acceptInvite(token, u.userId);
    }
    const [web, api] = await connectRepos({
      orgId,
      actorUserId: rep.userId,
      actorOrgRole: 'REPRESENTATIVE',
      repos: [{ fullName: 'acme/study-web', ownerRole: 'FRONTEND' }, { fullName: 'acme/study-api', ownerRole: 'BACKEND' }],
    });
    const { project } = await createProject(orgId, rep.userId, { name: 'E2E-C', autonomyPreset: 'L2', pmBudgetUsd: 5, repoIds: [web!.id, api!.id] });
    const repActor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' as const };
    const feAgent = await connectAgent({ connectKey: fe.connectKey, agentName: 'fe-mbp', harness: 'claude-code', skills: [], maxConcurrent: 1 });
    const beAgent = await connectAgent({ connectKey: be.connectKey, agentName: 'be-mbp', harness: 'claude-code', skills: [], maxConcurrent: 1 });
    await assignMember(repActor, project.id, feAgent.agentId, 'FRONTEND');
    await assignMember(repActor, project.id, beAgent.agentId, 'BACKEND');
    const specContent =
      '스터디 상세 페이지(/studies/:id)에 멤버 목록을 보여 준다.\n- 멤버 목록은 백엔드 API GET /api/studies/:id/members 에서 받는다(백엔드 팀이 구현 중).\n- 각 멤버의 닉네임과 가입일을 표시한다.\n- WHEN 멤버가 없으면 THEN "아직 멤버가 없습니다"를 보여 준다.';
    const spec = await createSpec(rep.userId, project.id, { featureKey: 'F-10', title: '스터디 멤버 목록 화면', content: specContent, tests: [] });
    const task = await createTask(rep.userId, project.id, { title: 'F-10 스터디 멤버 목록 화면', teamRole: 'FRONTEND', kind: 'IMPLEMENT', repoId: web!.id, specId: spec.id, dependsOn: [] });
    await startProject(repActor, project.id);
    const feTokens = { refreshToken: feAgent.refreshToken, accessToken: (await refreshAgentToken(feAgent.refreshToken)).accessToken };
    const beClient = new NomosClient({ baseUrl, tokens: { refreshToken: beAgent.refreshToken, accessToken: (await refreshAgentToken(beAgent.refreshToken)).accessToken } });
    const feClient = new NomosClient({ baseUrl, tokens: feTokens });

    // --- BE 레포: 멤버 응답 계약이 코드에 있다(memberSince는 추측으로 나오기 어려운 이름) ---
    const root = mkdtempSync(path.join(tmpdir(), 'nomos-e2e-c-'));
    const beDir = path.join(root, 'study-api');
    write(beDir, {
      'package.json': '{ "name": "study-api", "private": true, "type": "module" }\n',
      'src/http.ts': '// 모든 성공 응답은 { data: ... }로 감싼다. 목록은 { data: { <복수명>: [...] } }.\nexport const ok = <T>(body: T) => ({ status: 200, json: { data: body } });\n',
      ...(BE_EMPTY ? {} : { 'src/routes/members.ts':
        "import { ok } from '../http.ts';\n\n// GET /api/studies/:id/members — 페이지네이션 없음(정원 최대 30명).\n// 가입일 필드 이름은 memberSince(ISO-8601 UTC). 닉네임은 nickname, 식별자는 userId.\ntype MemberView = { userId: string; nickname: string; memberSince: string };\n\nexport function listMembers(rows: { user_id: string; nickname: string; joined_at: Date }[]) {\n  const members: MemberView[] = rows.map((r) => ({ userId: r.user_id, nickname: r.nickname, memberSince: r.joined_at.toISOString() }));\n  return ok({ members });\n}\n" }),
    });
    gitInit(beDir);

    // --- FE 작업공간 ---
    const feDir = path.join(root, 'study-web');
    write(feDir, {
      'package.json': '{ "name": "study-web", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
      'src/api/client.ts': "export async function apiGet<T>(p: string): Promise<T> {\n  const res = await fetch(`/api${p}`);\n  if (!res.ok) throw new Error(`GET ${p} failed: ${res.status}`);\n  return (await res.json()) as T;\n}\n",
      'src/pages/StudyPage.tsx': 'export function StudyPage({ studyId }: { studyId: string }) {\n  return <main><h1>스터디 {studyId}</h1></main>;\n}\n',
    });
    const git = gitInit(feDir);
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', `nomos/${task.id}`);
    write(feDir, { '.claude/settings.json': JSON.stringify(buildClaudePermissions(SEED_PATH_RULES.map((r) => ({ pathPattern: r.pathPattern, access: r.access, priority: r.priority }))), null, 2) });
    writeFileSync(path.join(feDir, '.git', 'info', 'exclude'), '.claude/\n.nomos-*\n');
    writeBriefingNotes(feDir, task.id, []);

    const require = createRequire(import.meta.url);
    const tsx = pathToFileURL(require.resolve('tsx/esm')).href;
    const home = path.join(root, 'home');
    mkdirSync(home);
    const mcpConfigPath = path.join(root, 'mcp.json');
    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        nomos: {
          command: process.execPath,
          args: ['--import', tsx, path.resolve('src/bridge/mcp-server.ts')],
          env: {
            NOMOS_WORKSPACE_DIR: feDir, NOMOS_BASE_URL: baseUrl, NOMOS_ACCESS_TOKEN: feTokens.accessToken, NOMOS_REFRESH_TOKEN: feTokens.refreshToken,
            USERPROFILE: home, HOME: home, NOMOS_QUESTION_INLINE_WAIT_MS: String(INLINE_WAIT_MS),
          },
        },
      },
    }));

    const runFe = async (briefing: PromptBriefing): Promise<string> => {
      const { command, commandArgs } = resolveClaudeCommand(buildClaudeArgs({ prompt: buildTaskPrompt(briefing, `nomos/${task.id}`), mcpConfigPath, cwd: feDir }));
      const child = spawn(command, commandArgs, { cwd: feDir, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      await new Promise((r) => child.on('close', r));
      const result = out.trim().split('\n').map((l) => { try { return JSON.parse(l) as { type?: string; result?: string }; } catch { return {}; } }).find((e) => e.type === 'result');
      return (result?.result ?? '').replace(/\s+/g, ' ');
    };

    // --- BE 쪽: 상담 실행(실물) + 담당자(스크립트) ---
    const log: string[] = [];
    const stamp = () => new Date().toISOString().slice(11, 19);
    const beToken = (await login({ loginId: 'be', password: PASSWORD })).accessToken;
    let stop = false;
    const consulted = new Set<string>();
    const beLoop = (async () => {
      while (!stop) {
        const { questions } = await beClient.listConsultJobs();
        for (const q of questions.filter((x) => !consulted.has(x.id))) {
          consulted.add(q.id);
          const started = Date.now();
          const draft = await runConsult({ dir: beDir, role: 'BACKEND', repoName: 'acme/study-api', question: q });
          const res = await beClient.submitDraft(q.id, draft);
          log.push(`${stamp()} 상담 ${Math.round((Date.now() - started) / 1000)}초 → ${res.status} decided=${JSON.stringify(Object.values(draft.decided))} :: ${q.questions.map((x) => x.question).join(' / ')}`);
        }
        // 담당자: 태스크가 멈춘(BLOCKED) 질문에만 답한다 — 사람은 늦게 온다는 가정. 초안이 있으면 그걸 바탕으로, 미정인 것은 결정해서.
        const state = (await pool.query(`SELECT state FROM tasks WHERE id = $1`, [task.id])).rows[0]!.state as string;
        if (state === 'BLOCKED') {
          const list = await fetch(`${baseUrl}/api/projects/${project.id}/questions`, { headers: { Authorization: `Bearer ${beToken}` } });
          const { data } = (await list.json()) as { data: { questions: { id: string; questions: { question: string }[]; draft: { answers: Record<string, string>; decided: Record<string, boolean> } | null }[] } };
          for (const q of data.questions) {
            // 초안에서 코드로 정해진 것은 그대로, 미정인 것은 담당자가 정한다(이 실험에서는 미리 정해 둔 계약).
            const answers = Object.fromEntries(q.questions.map((x) => [x.question, q.draft?.decided[x.question] ? q.draft.answers[x.question]! : HUMAN_DECISION]));
            const res = await fetch(`${baseUrl}/api/questions/${q.id}/answer`, { method: 'POST', headers: { Authorization: `Bearer ${beToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) });
            log.push(`${stamp()} 담당자 답 ${res.status} :: ${q.questions.map((x) => x.question).join(' / ')}`);
          }
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
    })();

    // --- FE 실행(필요하면 재개) ---
    const briefingFor = async (): Promise<PromptBriefing> => {
      const b = (await feClient.getBriefing(task.id)) as unknown as PromptBriefing;
      return { ...b, task: { id: task.id, title: 'F-10 스터디 멤버 목록 화면', teamRole: 'FRONTEND' }, repo: { fullName: 'acme/study-web' } };
    };
    const runs: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const briefing = await briefingFor();
      log.push(`${stamp()} FE 실행 ${attempt} 시작 (받은 답 ${briefing.answeredQuestions?.length ?? 0}개)`);
      runs.push(await runFe(briefing));
      const state = (await pool.query(`SELECT state FROM tasks WHERE id = $1`, [task.id])).rows[0]!.state as string;
      log.push(`${stamp()} FE 실행 ${attempt} 끝 — 태스크 ${state}`);
      if (state !== 'BLOCKED' && state !== 'READY') break;
      // 멈췄다 — 답이 와서 READY가 될 때까지 기다렸다가 Executor처럼 다시 돌린다.
      for (let i = 0; i < 300 && (await pool.query(`SELECT state FROM tasks WHERE id = $1`, [task.id])).rows[0]!.state !== 'READY'; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    stop = true;
    await beLoop;

    // --- 결과 ---
    const events = (await pool.query(`SELECT type, payload FROM events WHERE project_id = $1 AND (type LIKE 'QUESTION_%' OR type IN ('TASK_BLOCKED_ON_QUESTION','TASK_CLAIMED','ARTIFACT_SUBMITTED')) ORDER BY id`, [project.id])).rows;
    const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
    const code = changed.filter((f) => f.startsWith('src/')).map((f) => readFileSync(path.join(feDir, f), 'utf8')).join('\n');
    const report = {
      root,
      timeline: log,
      events: events.map((e) => `${e.type} ${JSON.stringify(e.payload).slice(0, 140)}`),
      commits: Number(git('rev-list', '--count', `${base}..HEAD`)),
      changed,
      usesBeCode: { memberSince: code.includes('memberSince'), members: code.includes('members'), joinedAtGuess: code.includes('joinedAt') },
      finals: runs.map((r) => r.slice(0, 400)),
    };
    console.log(JSON.stringify(report, null, 2));

    expect(report.commits).toBeGreaterThan(0);
    expect(report.usesBeCode.memberSince).toBe(true);
  });
});
