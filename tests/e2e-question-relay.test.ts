import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
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
import { buildTaskPrompt } from '../src/executor/prompt.js';
import { resolveClaudeCommand } from '../src/executor/runner.js';
import { resetSchema, testPool } from './test-db.js';

// 실험 ② E2E — 진짜 헤드리스 Claude(FE 에이전트)가 명세에 없는 BE 결정을 AskUserQuestion으로 묻고,
// 브릿지 권한 도구 → 서버 → (BE 담당 역할을 흉내 낸 스크립트가 API로 답) → 브릿지 → 같은 실행에서 이어서 구현·커밋·제출.
// 사용자 구독으로 Claude가 돌기 때문에 기본은 건너뛴다: RUN_CLAUDE_E2E=1 npx vitest run tests/e2e-question-relay.test.ts

const RUN = process.env.RUN_CLAUDE_E2E === '1';
const PASSWORD = 'correct-horse-battery';
// BE 담당이 답하는 내용 — FE 코드에 그대로 반영됐는지 본다.
const BE_ANSWER = 'BE 결정: 200 { "data": { "members": [ { "userId": string, "nickname": string, "joinedAt": ISO-8601 string } ] } } — 필드는 camelCase, 페이지네이션 없음';

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

describe.skipIf(!RUN)('실험 ② — 질문 중계 E2E (진짜 Claude)', () => {
  it('FE 에이전트가 BE 결정을 묻고, BE 담당의 답을 받아 같은 실행에서 이어서 구현한다', { timeout: 20 * 60_000 }, async () => {
    // --- 세계: 대표, FE·BE 담당, FE 레포, 명세(응답 형식 없음), FE 태스크 ---
    const rep = await signup({ loginId: 'rep', password: PASSWORD, nickname: 'rep' });
    const fe = await signup({ loginId: 'fe', password: PASSWORD, nickname: 'fe' });
    const be = await signup({ loginId: 'be', password: PASSWORD, nickname: 'be' });
    const { orgId } = await createOrganization(rep.userId, 'Acme');
    for (const u of [fe, be]) {
      const { token } = await createInvite(orgId, rep.userId);
      await acceptInvite(token, u.userId);
    }
    const [web] = await connectRepos({ orgId, actorUserId: rep.userId, actorOrgRole: 'REPRESENTATIVE', repos: [{ fullName: 'acme/study-web', ownerRole: 'FRONTEND' }] });
    const { project } = await createProject(orgId, rep.userId, { name: 'E2E', autonomyPreset: 'L2', pmBudgetUsd: 5, repoIds: [web!.id] });
    const repActor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' as const };
    const feAgent = await connectAgent({ connectKey: fe.connectKey, agentName: 'fe-mbp', harness: 'claude-code', skills: [], maxConcurrent: 1 });
    const beAgent = await connectAgent({ connectKey: be.connectKey, agentName: 'be-mbp', harness: 'claude-code', skills: [], maxConcurrent: 1 });
    await assignMember(repActor, project.id, feAgent.agentId, 'FRONTEND');
    await assignMember(repActor, project.id, beAgent.agentId, 'BACKEND');
    const spec = await createSpec(rep.userId, project.id, {
      featureKey: 'F-10',
      title: '스터디 멤버 목록 화면',
      content: '스터디 상세 페이지(/studies/:id)에 멤버 목록을 보여 준다.\n- 멤버 목록은 백엔드 API GET /api/studies/:id/members 에서 받는다(백엔드 팀이 구현 중).\n- 각 멤버의 닉네임과 가입일을 표시한다.\n- WHEN 멤버가 없으면 THEN "아직 멤버가 없습니다"를 보여 준다.',
      tests: [],
    });
    const task = await createTask(rep.userId, project.id, { title: 'F-10 스터디 멤버 목록 화면', teamRole: 'FRONTEND', kind: 'IMPLEMENT', repoId: web!.id, specId: spec.id, dependsOn: [] });
    await startProject(repActor, project.id);
    const tokens = { refreshToken: feAgent.refreshToken, accessToken: (await refreshAgentToken(feAgent.refreshToken)).accessToken };

    // --- 작업공간: FE 레포 흉내 + settings.json + 브리핑 파일(권한 도구가 태스크 id를 읽는다) ---
    const root = mkdtempSync(path.join(tmpdir(), 'nomos-e2e-'));
    const ws = path.join(root, 'ws');
    mkdirSync(path.join(ws, 'src', 'api'), { recursive: true });
    mkdirSync(path.join(ws, 'src', 'pages'), { recursive: true });
    mkdirSync(path.join(ws, '.claude'), { recursive: true });
    writeFileSync(path.join(ws, 'package.json'), '{ "name": "study-web", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n');
    writeFileSync(path.join(ws, 'src', 'api', 'client.ts'), "export async function apiGet<T>(p: string): Promise<T> {\n  const res = await fetch(`/api${p}`);\n  if (!res.ok) throw new Error(`GET ${p} failed: ${res.status}`);\n  return (await res.json()) as T;\n}\n");
    writeFileSync(path.join(ws, 'src', 'pages', 'StudyPage.tsx'), 'export function StudyPage({ studyId }: { studyId: string }) {\n  return <main><h1>스터디 {studyId}</h1></main>;\n}\n');
    const git = (...a: string[]) => execFileSync('git', a, { cwd: ws }).toString().trim();
    git('init', '-q');
    git('-c', 'user.email=e2e@test', '-c', 'user.name=e2e', 'add', '-A');
    git('-c', 'user.email=e2e@test', '-c', 'user.name=e2e', 'commit', '-qm', 'init');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', `nomos/${task.id}`);
    writeFileSync(path.join(ws, '.claude', 'settings.json'), JSON.stringify(buildClaudePermissions(SEED_PATH_RULES.map((r) => ({ pathPattern: r.pathPattern, access: r.access, priority: r.priority }))), null, 2));
    writeFileSync(path.join(ws, '.git', 'info', 'exclude'), '.claude/\n.nomos-*\n');
    writeBriefingNotes(ws, task.id, []);

    // --- 브릿지 MCP 서버(실물)를 tsx로 띄운다. 홈을 임시 폴더로 — 개발자 PC의 ~/.nomos/credentials를 집어 가지 않게. ---
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
          env: { NOMOS_WORKSPACE_DIR: ws, NOMOS_BASE_URL: baseUrl, NOMOS_ACCESS_TOKEN: tokens.accessToken, NOMOS_REFRESH_TOKEN: tokens.refreshToken, USERPROFILE: home, HOME: home },
        },
      },
    }));

    const prompt = buildTaskPrompt({
      task: { id: task.id, title: 'F-10 스터디 멤버 목록 화면', teamRole: 'FRONTEND' },
      repo: { fullName: 'acme/study-web' },
      spec: { featureKey: 'F-10', title: '스터디 멤버 목록 화면', content: spec.content },
      notesBlock: '',
      writablePaths: [{ pathPattern: '**' }],
    }, `nomos/${task.id}`);
    const { command, commandArgs } = resolveClaudeCommand(buildClaudeArgs({ prompt, mcpConfigPath, cwd: ws }));

    // --- BE 담당 흉내: 질문이 올라오면 20초 뒤(사람이 읽는 시간) 답한다 ---
    const beToken = (await login({ loginId: 'be', password: PASSWORD })).accessToken;
    const answered: { questions: string[]; at: number }[] = [];
    let stop = false;
    const beLoop = (async () => {
      while (!stop) {
        const res = await fetch(`${baseUrl}/api/projects/${project.id}/questions`, { headers: { Authorization: `Bearer ${beToken}` } });
        const { data } = (await res.json()) as { data: { questions: { id: string; questions: { question: string }[] }[] } };
        for (const q of data.questions) {
          await new Promise((r) => setTimeout(r, 20_000));
          const answers = Object.fromEntries(q.questions.map((x) => [x.question, BE_ANSWER]));
          await fetch(`${baseUrl}/api/questions/${q.id}/answer`, { method: 'POST', headers: { Authorization: `Bearer ${beToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) });
          answered.push({ questions: q.questions.map((x) => x.question), at: Date.now() });
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
    })();

    // --- FE 에이전트 실행 ---
    const started = Date.now();
    const child = spawn(command, commandArgs, { cwd: ws, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    await new Promise((r) => child.on('close', r));
    stop = true;
    await beLoop;
    writeFileSync(path.join(root, 'run.jsonl'), out);

    // --- 결과 ---
    const lines = out.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } });
    const final = lines.find((e) => e.type === 'result') as { result?: string } | undefined;
    const events = (await pool.query(`SELECT type, payload FROM events WHERE project_id = $1 AND type LIKE 'QUESTION_%' OR type IN ('TASK_CLAIMED','ARTIFACT_SUBMITTED','NOTE_PUBLISHED') ORDER BY id`, [project.id])).rows;
    const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
    const code = changed.filter((f) => f.startsWith('src/')).map((f) => readFileSync(path.join(ws, f), 'utf8')).join('\n');
    const report = {
      minutes: +((Date.now() - started) / 60_000).toFixed(1),
      workspace: ws,
      questionsAsked: answered.flatMap((a) => a.questions),
      events: events.map((e) => `${e.type} ${JSON.stringify(e.payload).slice(0, 120)}`),
      commits: Number(git('rev-list', '--count', `${base}..HEAD`)),
      changed,
      usesAnswer: { members: code.includes('members'), joinedAt: code.includes('joinedAt'), userId: code.includes('userId'), snakeCase: code.includes('joined_at') },
      final: (final?.result ?? '').replace(/\s+/g, ' ').slice(0, 600),
      bridgeLog: err.split('\n').filter((l) => l.includes('[nomos-mcp]')).slice(-10),
    };
    console.log(JSON.stringify(report, null, 2));

    expect(report.questionsAsked.length).toBeGreaterThan(0);
    expect(report.commits).toBeGreaterThan(0);
    expect(report.usesAnswer.joinedAt && report.usesAnswer.members).toBe(true);
  });
});
