import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
import { attachRealtime, type Realtime } from '../src/realtime/index.js';
import { resetSchema, testPool } from './test-db.js';

// 실물 Executor 두 개(빌드된 CLI `start`)로 C안 전체를 돌린다 — 노트북 둘을 NOMOS_HOME으로 흉내 낸다.
//   FE Executor: 태스크를 받아 구현하다 BE 소관을 묻는다 → 90초 뒤 내려놓는다(BLOCKED)
//   BE Executor: 웹소켓 신호로 질문을 받아 스스로 상담 실행을 띄우고 초안을 올린다
//   BE 담당(스크립트): 태스크가 멈추면 미정인 것을 정해 답한다 → READY → FE Executor가 스스로 다시 집어 가 마무리한다
// 먼저 npm run build. 사용자 구독으로 돈다: RUN_CLAUDE_E2E=1 npx vitest run tests/e2e-executors.test.ts

const RUN = process.env.RUN_CLAUDE_E2E === '1';
const PASSWORD = 'correct-horse-battery';
const HUMAN_DECISION = 'BE 결정: 200 { data: { members: [ { userId, nickname, memberSince } ] } } — memberSince는 ISO-8601 UTC 문자열, 페이지네이션 없음';

let server: Server;
let realtime: Realtime;
let baseUrl: string;

beforeAll(async () => {
  await resetSchema();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  realtime = attachRealtime(server);
  await realtime.ready;
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await realtime.close();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

function makeRepo(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=e2e@test', '-c', 'user.name=e2e', 'add', '-A');
  git('-c', 'user.email=e2e@test', '-c', 'user.name=e2e', 'commit', '-qm', 'init');
}

// Windows에서 claude 자식 프로세스까지 정리한다.
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // 이미 끝났다
    }
  } else child.kill('SIGTERM');
}

describe.skipIf(!RUN)('실물 Executor 두 개 — C안 (진짜 Claude)', () => {
  it('BE Executor가 스스로 상담하고, FE Executor가 멈췄던 태스크를 답이 온 뒤 스스로 다시 집어 간다', { timeout: 40 * 60_000 }, async () => {
    const cli = path.resolve('dist/executor/cli.js');
    expect(existsSync(cli), 'npm run build를 먼저 하라').toBe(true);

    // --- 레포 원본(로컬 git) ---
    const root = mkdtempSync(path.join(tmpdir(), 'nomos-e2e-exec-'));
    const webSrc = path.join(root, 'src-study-web');
    const apiSrc = path.join(root, 'src-study-api');
    makeRepo(webSrc, {
      'package.json': '{ "name": "study-web", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
      'src/api/client.ts': "export async function apiGet<T>(p: string): Promise<T> {\n  const res = await fetch(`/api${p}`);\n  if (!res.ok) throw new Error(`GET ${p} failed: ${res.status}`);\n  return (await res.json()) as T;\n}\n",
      'src/pages/StudyPage.tsx': 'export function StudyPage({ studyId }: { studyId: string }) {\n  return <main><h1>스터디 {studyId}</h1></main>;\n}\n',
    });
    // BE: 응답 감싸기 규약만 있고 멤버 API는 아직 없다 — 상담은 일부를 "미정"으로 답할 것이다.
    makeRepo(apiSrc, {
      'package.json': '{ "name": "study-api", "private": true, "type": "module" }\n',
      'src/http.ts': '// 모든 성공 응답은 { data: ... }로 감싼다. 목록은 { data: { <복수명>: [...] } }.\nexport const ok = <T>(body: T) => ({ status: 200, json: { data: body } });\n',
    });

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
    // 레포 주소 API(PATCH /repos/:id)를 우회해 바로 넣는다 — 테스트 서버는 mirror 모드라 로컬 경로가 허용된다.
    await pool.query(`UPDATE repos SET clone_url = $2, default_branch = 'main' WHERE id = $1`, [web!.id, webSrc]);
    await pool.query(`UPDATE repos SET clone_url = $2, default_branch = 'main' WHERE id = $1`, [api!.id, apiSrc]);
    const { project } = await createProject(orgId, rep.userId, { name: 'E2E-EXEC', autonomyPreset: 'L2', pmBudgetUsd: 5, repoIds: [web!.id, api!.id] });
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

    // --- 노트북 둘: NOMOS_HOME을 나누고 자격 증명을 둔다(배정 뒤 재발급한 토큰) ---
    const homes = { fe: path.join(root, 'fe-nomos'), be: path.join(root, 'be-nomos') };
    for (const [key, agent] of [['fe', feAgent], ['be', beAgent]] as const) {
      mkdirSync(homes[key], { recursive: true });
      const { accessToken } = await refreshAgentToken(agent.refreshToken);
      writeFileSync(path.join(homes[key], 'credentials'), JSON.stringify({ baseUrl, accessToken, refreshToken: agent.refreshToken, agentId: agent.agentId }));
    }

    const logs: Record<'fe' | 'be', string[]> = { fe: [], be: [] };
    const stamp = () => new Date().toISOString().slice(11, 19);
    const startExecutor = (key: 'fe' | 'be') => {
      const child = spawn(process.execPath, [cli, 'start'], {
        cwd: root,
        env: { ...process.env, NOMOS_HOME: homes[key], NOMOS_QUESTION_INLINE_WAIT_MS: '90000' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const onLine = (d: Buffer) => {
        for (const line of d.toString().split('\n').filter((l) => l.includes('[nomos]'))) logs[key].push(`${stamp()} ${line.trim()}`);
      };
      child.stdout.on('data', onLine);
      child.stderr.on('data', onLine);
      return child;
    };
    const feExec = startExecutor('fe');
    const beExec = startExecutor('be');

    // 시작(G1) — 이때부터 FE Executor가 웹소켓으로 태스크를 받는다.
    await new Promise((r) => setTimeout(r, 5_000));
    await startProject(repActor, project.id);

    // --- BE 담당(스크립트): 태스크가 멈추면 답한다 ---
    const beToken = (await login({ loginId: 'be', password: PASSWORD })).accessToken;
    const timeline: string[] = [];
    let lastState = '';
    const deadline = Date.now() + 30 * 60_000;
    try {
      while (Date.now() < deadline) {
        const state = (await pool.query(`SELECT state FROM tasks WHERE id = $1`, [task.id])).rows[0]!.state as string;
        if (state !== lastState) timeline.push(`${stamp()} 태스크 ${lastState || '-'} → ${state}`);
        lastState = state;
        if (state === 'VERIFYING' || state === 'DONE' || state === 'ESCALATED') break;
        if (state === 'BLOCKED') {
          const list = await fetch(`${baseUrl}/api/projects/${project.id}/questions`, { headers: { Authorization: `Bearer ${beToken}` } });
          const { data } = (await list.json()) as { data: { questions: { id: string; questions: { question: string }[]; draft: { answers: Record<string, string>; decided: Record<string, boolean> } | null }[] } };
          for (const q of data.questions) {
            const answers = Object.fromEntries(q.questions.map((x) => [x.question, q.draft?.decided[x.question] ? q.draft.answers[x.question]! : HUMAN_DECISION]));
            const res = await fetch(`${baseUrl}/api/questions/${q.id}/answer`, { method: 'POST', headers: { Authorization: `Bearer ${beToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) });
            timeline.push(`${stamp()} 담당자 답 ${res.status} (초안 ${q.draft ? '있음' : '없음'})`);
          }
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
      // 제출 뒤 Executor가 V2·V4를 보고할 시간
      await new Promise((r) => setTimeout(r, 15_000));
    } finally {
      killTree(feExec);
      killTree(beExec);
    }

    // --- 결과 ---
    const events = (await pool.query(`SELECT ts, type, payload FROM events WHERE project_id = $1 AND type NOT IN ('PROJECT_CREATED','MEMBER_ASSIGNED','SPEC_CREATED','TASK_CREATED') ORDER BY id`, [project.id])).rows;
    const wsRoot = path.join(homes.fe, 'workspaces', project.id, task.id);
    const changed = existsSync(wsRoot) ? execFileSync('git', ['diff', '--name-only', 'origin/main', 'HEAD'], { cwd: wsRoot }).toString().split('\n').filter(Boolean) : [];
    const code = changed.filter((f) => f.startsWith('src/')).map((f) => readFileSync(path.join(wsRoot, f), 'utf8')).join('\n');
    const report = {
      root,
      timeline,
      events: events.map((e) => `${(e.ts as Date).toISOString().slice(11, 19)} ${e.type} ${JSON.stringify(e.payload).slice(0, 110)}`),
      feLog: logs.fe,
      beLog: logs.be,
      beRepoCloned: existsSync(path.join(homes.be, 'repos')) ? readdirSync(path.join(homes.be, 'repos'), { recursive: true }).slice(0, 5) : [],
      changed,
      usesBeAnswer: { memberSince: code.includes('memberSince'), joinedAtGuess: code.includes('joinedAt') },
    };
    console.log(JSON.stringify(report, null, 2));

    expect(lastState === 'VERIFYING' || lastState === 'DONE').toBe(true);
    expect(report.usesBeAnswer.memberSince).toBe(true);
  });
});
