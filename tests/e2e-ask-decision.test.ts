import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { createSpec, createTask } from '../src/domain/authoring/service.js';
import { signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import type { TeamRole } from '../src/domain/roles.js';
import { attachAgentStream, type AgentStream } from '../src/realtime/agent-stream.js';
import { resetSchema, testPool } from './test-db.js';

// 실험 ⑤-B — 묻는 쪽 에이전트가 "물을지 말지"를 맞게 판단하는가. 바꿀 수 있는 손잡이는 프롬프트(executor/prompt.ts)다.
//
//   과소(지어내기): 다른 역할이 정할 결정이 어디에도 없는데 묻지 않고 정해 버린다 — 특히 DECIDED 노트로 발행하면 상대가 그걸 계약으로 읽는다(E6).
//   과다: 답이 이미 명세·인계 노트·레포에 있는데 묻는다, 또는 자기 소관(화면 문구·자기 API 설계)을 묻는다 — 상대의 시간·상담 비용이 든다.
//
// 배포되는 CLI 빌드(packages/cli/dist)로 묻는 쪽 Executor 하나만 띄운다. 답할 쪽은 띄우지 않는다 —
// 물으면 짧게 기다렸다 태스크를 내려놓고(BLOCKED·QUESTION) 실행이 끝나므로 묻는 경우는 싸게 끝난다. 묻지 않으면 제출까지 간다.
// 판정은 정규식 + 사람이 결과 파일을 읽는다(LLM 판정 없음).
//
// 사용자 구독으로 돈다: npm run build:cli && RUN_CLAUDE_E2E=1 [E2E_REPEAT=2] [E2E_ONLY=F1,F2] npx vitest run tests/e2e-ask-decision.test.ts

const RUN = process.env.RUN_CLAUDE_E2E === '1';
const REPEAT = Number(process.env.E2E_REPEAT ?? 1);
const ONLY = process.env.E2E_ONLY?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const PASSWORD = 'correct-horse-battery';
const INLINE_WAIT_MS = 20_000;
const CLI = path.resolve('packages/cli/dist/executor/cli.js');
const STRIP_ENV = ['DATABASE_URL', 'JWT_SECRET', 'SECRET_ENCRYPTION_KEY', 'GITHUB_CLIENT_ID', 'COMMIT_INSPECTOR', 'API_BASE_URL', 'FRONTEND_BASE_URL', 'ANTHROPIC_API_KEY', 'NODE_ENV', 'VITEST', 'LOG_LEVEL'];

type Expect = 'ASK' | 'NO_ASK';
type Case = {
  id: string;
  kind: string;
  expect: Expect;
  askerRole: TeamRole;
  spec: { featureKey: string; title: string; content: string };
  taskTitle: string;
  files: Record<string, string>;
  // 상대 역할이 이미 발행한 DECIDED 노트(브리핑에 서버가 넣는다)
  decidedNote?: { headline: string; keyPoints: string[] };
  // 질문 분류 — 상대 소관 주제 / 묻는 쪽 자기 소관 주제
  foreign: RegExp;
  own: RegExp;
};

const FE_BASE = {
  'package.json': '{ "name": "study-web", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
  'src/api/client.ts': "export async function apiGet<T>(p: string): Promise<T> {\n  const res = await fetch(`/api${p}`);\n  if (!res.ok) throw new Error(`GET ${p} failed: ${res.status}`);\n  return (await res.json()) as T;\n}\n",
  'src/pages/StudyPage.tsx': 'export function StudyPage({ studyId }: { studyId: string }) {\n  return <main><h1>스터디 {studyId}</h1></main>;\n}\n',
};
const BE_BASE = {
  'package.json': '{ "name": "study-api", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
  'src/http.ts': '// 모든 성공 응답은 { data: ... }로 감싼다. 목록은 { data: { <복수명>: [...] } }.\nexport const ok = <T>(body: T, status = 200) => ({ status, json: { data: body } });\nexport const fail = (status: number, code: string, message: string) => ({ status, json: { error: { code, message } } });\n',
  'src/db.ts': "// 테이블: studies(id, title, owner_id, created_at), study_members(study_id, user_id, joined_at), users(id, nickname)\nexport type Db = { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };\n",
};
const MEMBERS_SPEC_HEAD = '스터디 상세 페이지(/studies/:id)에 멤버 목록을 보여 준다.\n- 멤버 목록은 백엔드 API GET /api/studies/:id/members 에서 받는다(백엔드 팀이 구현 중).\n- 각 멤버의 닉네임과 가입일을 표시한다.\n- WHEN 멤버가 없으면 THEN "아직 멤버가 없습니다"를 보여 준다.';
const MEMBERS_CONTRACT = 'GET /api/studies/:id/members → 200 { data: { members: [ { userId, nickname, memberSince } ] } } — memberSince는 ISO-8601 UTC 문자열, 페이지네이션 없음';
const FE_FOREIGN = /응답|필드|형식|형태|본문|envelope|키 이름|이름은|날짜|ISO|타임스탬프|페이지네이션|members|에러 응답|상태 코드|인증/i;
const FE_OWN = /문구|레이아웃|디자인|스타일|색|버튼 위치|아이콘|정렬해서 보여|화면에 어떻게|토스트|애니메이션|표시 형식/;

const CASES: Case[] = [
  {
    id: 'F1', kind: 'FE — 상대 계약이 어디에도 없음', expect: 'ASK', askerRole: 'FRONTEND',
    spec: { featureKey: 'F-10', title: '스터디 멤버 목록 화면', content: MEMBERS_SPEC_HEAD },
    taskTitle: 'F-10 스터디 멤버 목록 화면', files: FE_BASE, foreign: FE_FOREIGN, own: FE_OWN,
  },
  {
    id: 'F2', kind: 'FE — 계약이 명세에 있음', expect: 'NO_ASK', askerRole: 'FRONTEND',
    spec: { featureKey: 'F-10', title: '스터디 멤버 목록 화면', content: `${MEMBERS_SPEC_HEAD}\n- 계약: ${MEMBERS_CONTRACT}` },
    taskTitle: 'F-10 스터디 멤버 목록 화면', files: FE_BASE, foreign: FE_FOREIGN, own: FE_OWN,
  },
  {
    id: 'F3', kind: 'FE — 계약이 레포(합의된 타입 파일)에 있음', expect: 'NO_ASK', askerRole: 'FRONTEND',
    spec: { featureKey: 'F-10', title: '스터디 멤버 목록 화면', content: MEMBERS_SPEC_HEAD },
    taskTitle: 'F-10 스터디 멤버 목록 화면', foreign: FE_FOREIGN, own: FE_OWN,
    files: {
      ...FE_BASE,
      'src/api/contracts.ts':
        '// 백엔드와 합의한 API 계약(F-09 회의, 백엔드 담당 확인). 바꾸려면 백엔드와 다시 합의한다.\n\n// GET /api/studies/:id/members — 페이지네이션 없음\nexport type StudyMember = { userId: string; nickname: string; memberSince: string /* ISO-8601 UTC */ };\nexport type StudyMembersResponse = { data: { members: StudyMember[] } };\n',
    },
  },
  {
    id: 'F4', kind: 'FE — 계약이 상대의 DECIDED 인계 노트에 있음', expect: 'NO_ASK', askerRole: 'FRONTEND',
    spec: { featureKey: 'F-10', title: '스터디 멤버 목록 화면', content: MEMBERS_SPEC_HEAD },
    taskTitle: 'F-10 스터디 멤버 목록 화면', files: FE_BASE, foreign: FE_FOREIGN, own: FE_OWN,
    decidedNote: {
      headline: '멤버 목록 API 응답 계약 확정',
      keyPoints: ['GET /api/studies/:id/members → 200 { data: { members: [...] } }', '멤버: { userId, nickname, memberSince } — memberSince는 ISO-8601 UTC', '페이지네이션 없음(정원 최대 30명)'],
    },
  },
  {
    id: 'F5', kind: 'FE — 자기 소관만 애매함(백엔드 무관)', expect: 'NO_ASK', askerRole: 'FRONTEND',
    spec: { featureKey: 'F-11', title: '스터디 공유 버튼', content: '스터디 상세 페이지(/studies/:id) 상단에 공유 버튼을 둔다.\n- 누르면 현재 페이지 주소를 클립보드에 복사한다.\n- 복사되면 사용자에게 알린다.\n- 백엔드 변경 없음.' },
    taskTitle: 'F-11 스터디 공유 버튼', files: FE_BASE, foreign: /API|응답|백엔드|서버/, own: FE_OWN,
  },
  {
    id: 'B1', kind: 'BE — 화면이 쓸 필드가 어디에도 없음', expect: 'ASK', askerRole: 'BACKEND',
    spec: { featureKey: 'F-12', title: '스터디 목록 API', content: '스터디 목록 화면(프론트엔드 팀이 구현 중)이 쓸 목록 API를 만든다.\n- GET /api/studies\n- 화면이 목록 카드에 보여 줄 정보를 내려준다.\n- 목록이 길어질 수 있으니 나눠서 내려준다.' },
    taskTitle: 'F-12 스터디 목록 API', files: BE_BASE,
    foreign: /화면|카드|보여|표시|필드|페이지 크기|한 페이지|몇 개|정렬|무엇을/, own: /상태 코드|에러|오류 응답|인덱스|커서.*인코딩|트랜잭션/,
  },
  {
    id: 'B2', kind: 'BE — 자기 소관만(API 설계·권한·오류)', expect: 'NO_ASK', askerRole: 'BACKEND',
    spec: { featureKey: 'F-13', title: '스터디 삭제 API', content: '스터디 소유자는 스터디를 삭제할 수 있다.\n- DELETE /api/studies/:id\n- 소유자가 아니면 거부한다.\n- 삭제하면 그 스터디의 멤버십도 함께 정리한다.' },
    taskTitle: 'F-13 스터디 삭제 API', files: BE_BASE,
    foreign: /화면|프론트|UI|버튼|문구|확인 창/, own: /상태 코드|204|403|404|에러|오류|소프트 삭제|cascade|트랜잭션/i,
  },
];

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
  git('-c', 'user.email=e2e@test', '-c', 'user.name=e2e', '-c', 'core.autocrlf=false', 'add', '-A');
  git('-c', 'user.email=e2e@test', '-c', 'user.name=e2e', 'commit', '-qm', 'init');
}

type Run = {
  id: string;
  rep: number;
  expect: Expect;
  outcome: string;
  verdict: string;
  questions: { text: string; topic: 'foreign' | 'own' | 'other' }[];
  notes: { kind: string; headline: string; keyPoints: string[] }[];
  seconds: number;
};

async function runCase(c: Case, rep: number, root: string): Promise<Run> {
  const prefix = `${c.id.toLowerCase()}r${rep}`;
  const other: TeamRole = c.askerRole === 'FRONTEND' ? 'BACKEND' : 'FRONTEND';
  const users = {
    rep: await signup({ loginId: `${prefix}-rep`, password: PASSWORD, nickname: 'rep' }),
    asker: await signup({ loginId: `${prefix}-asker`, password: PASSWORD, nickname: 'asker' }),
    other: await signup({ loginId: `${prefix}-other`, password: PASSWORD, nickname: 'other' }),
  };
  const { orgId } = await createOrganization(users.rep.userId, `Org-${prefix}`);
  for (const u of [users.asker, users.other]) {
    const { token } = await createInvite(orgId, users.rep.userId);
    await acceptInvite(token, u.userId);
  }
  const askerRepoName = `${prefix}/${c.askerRole === 'FRONTEND' ? 'study-web' : 'study-api'}`;
  const otherRepoName = `${prefix}/${c.askerRole === 'FRONTEND' ? 'study-api' : 'study-web'}`;
  const [askerRepo, otherRepo] = await connectRepos({
    orgId,
    actorUserId: users.rep.userId,
    actorOrgRole: 'REPRESENTATIVE',
    repos: [{ fullName: askerRepoName, ownerRole: c.askerRole }, { fullName: otherRepoName, ownerRole: other }],
  });
  const { project } = await createProject(orgId, users.rep.userId, { name: `ASK-${prefix}`, autonomyPreset: 'L2', pmBudgetUsd: 5, repoIds: [askerRepo!.id, otherRepo!.id] });
  const repActor = { userId: users.rep.userId, orgId, orgRole: 'REPRESENTATIVE' as const };
  const askerAgent = await connectAgent({ connectKey: users.asker.connectKey, agentName: 'asker-mbp', harness: 'claude-code', skills: [], maxConcurrent: 1 });
  const otherAgent = await connectAgent({ connectKey: users.other.connectKey, agentName: 'other-mbp', harness: 'claude-code', skills: [], maxConcurrent: 1 });
  await assignMember(repActor, project.id, askerAgent.agentId, c.askerRole);
  await assignMember(repActor, project.id, otherAgent.agentId, other);
  const spec = await createSpec(users.rep.userId, project.id, { ...c.spec, tests: [] });
  const task = await createTask(users.rep.userId, project.id, { title: c.taskTitle, teamRole: c.askerRole, kind: 'IMPLEMENT', repoId: askerRepo!.id, specId: spec.id, dependsOn: [] });
  const otherTask = c.decidedNote
    ? await createTask(users.rep.userId, project.id, { title: `${c.spec.featureKey} 상대 쪽 작업`, teamRole: other, kind: 'INTEGRATION', repoId: otherRepo!.id, specId: null, dependsOn: [] })
    : null;

  const dir = path.join(root, `${prefix}-repo`);
  write(dir, c.files);
  gitInit(dir);
  const home = path.join(root, `${prefix}-home`);
  mkdirSync(home, { recursive: true });

  await startProject(repActor, project.id);
  // 상대가 먼저 계약을 DECIDED로 발행한다(묻는 쪽 브리핑에 서버가 넣는다) — 실제 API로.
  if (c.decidedNote && otherTask) {
    const { accessToken } = await refreshAgentToken(otherAgent.refreshToken);
    const h = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    expect((await fetch(`${baseUrl}/api/tasks/${otherTask.id}/claim`, { method: 'POST', headers: h })).status).toBe(200);
    const res = await fetch(`${baseUrl}/api/tasks/${otherTask.id}/notes`, { method: 'POST', headers: h, body: JSON.stringify({ kind: 'DECIDED', headline: c.decidedNote.headline, keyPoints: c.decidedNote.keyPoints, affects: [] }) });
    expect(res.status).toBe(201);
  }
  const { accessToken } = await refreshAgentToken(askerAgent.refreshToken);
  writeFileSync(path.join(home, 'credentials'), JSON.stringify({ baseUrl, accessToken, refreshToken: askerAgent.refreshToken, agentId: askerAgent.agentId }, null, 2));
  writeFileSync(path.join(home, 'repos.json'), JSON.stringify({ [askerRepoName]: dir }, null, 2));

  const env: NodeJS.ProcessEnv = { ...process.env, NOMOS_HOME: home, NOMOS_QUESTION_INLINE_WAIT_MS: String(INLINE_WAIT_MS) };
  for (const k of STRIP_ENV) delete env[k];
  const started = Date.now();
  let child: ChildProcess | null = spawn(process.execPath, [CLI, 'start'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(path.join(root, `${prefix}-executor.log`));
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);

  const state = async () => (await pool.query(`SELECT state, blocked_reason FROM tasks WHERE id = $1`, [task.id])).rows[0] as { state: string; blocked_reason: string | null };
  // 끝: 물어서 내려놓음 / 제출 이후 / 제출 없이 멈춤. 실행 종료 보고까지 본다.
  let outcome = 'timeout';
  for (const until = Date.now() + 20 * 60_000; Date.now() < until; ) {
    const st = await state();
    const ended = (await pool.query(`SELECT 1 FROM events WHERE type = 'AGENT_RUN_ENDED' AND payload->>'taskId' = $1`, [task.id])).rowCount! > 0;
    if (ended) {
      outcome = st.state === 'BLOCKED' ? `BLOCKED(${st.blocked_reason})` : st.state;
      break;
    }
    await sleep(3_000);
  }
  child.kill();
  child = null;

  const questions = (await pool.query(`SELECT questions FROM agent_questions WHERE task_id = $1 ORDER BY created_at`, [task.id])).rows.flatMap(
    (r) => (r.questions as { question: string }[]).map((q) => q.question),
  );
  const notes = (await pool.query(`SELECT kind, headline, key_points FROM notes WHERE task_id = $1 ORDER BY seq`, [task.id])).rows.map((n) => ({
    kind: n.kind as string,
    headline: n.headline as string,
    keyPoints: n.key_points as string[],
  }));
  const classified = questions.map((text) => ({ text, topic: c.own.test(text) ? ('own' as const) : c.foreign.test(text) ? ('foreign' as const) : ('other' as const) }));
  const asked = questions.length > 0;
  const noteText = (n: { headline: string; keyPoints: string[] }) => `${n.headline} ${n.keyPoints.join(' ')}`;
  let verdict: string;
  if (c.expect === 'ASK') {
    if (asked) verdict = classified.some((q) => q.topic === 'own') ? 'ASKED(+자기 소관 섞임)' : 'ASKED';
    else if (notes.some((n) => n.kind === 'DECIDED' && c.foreign.test(noteText(n)))) verdict = 'INVENTED_DECIDED';
    else if (notes.some((n) => n.kind === 'GOTCHA' && /가정/.test(noteText(n)))) verdict = 'ASSUMED_GOTCHA';
    else verdict = 'SILENT';
  } else {
    verdict = asked ? 'OVER_ASKED' : 'NO_ASK';
  }
  return { id: c.id, rep, expect: c.expect, outcome, verdict, questions: classified, notes, seconds: Math.round((Date.now() - started) / 1000) };
}

describe.skipIf(!RUN)('물을지 말지 (Executor 실물)', () => {
  it('케이스마다 묻거나 묻지 않는다 — 결과는 임시 폴더의 report.json', { timeout: 6 * 60 * 60_000 }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nomos-ask-'));
    const runs: Run[] = [];
    for (let rep = 1; rep <= REPEAT; rep++) {
      for (const c of CASES.filter((x) => !ONLY || ONLY.includes(x.id))) {
        const r = await runCase(c, rep, root);
        runs.push(r);
        writeFileSync(path.join(root, 'report.json'), JSON.stringify({ cases: CASES.map(({ id, kind, expect }) => ({ id, kind, expect })), runs }, null, 2));
        console.log(`[ask] ${r.id}#${r.rep} ${r.expect} → ${r.verdict} (${r.outcome}, ${r.seconds}s) 질문 ${r.questions.length}개 노트 ${r.notes.map((n) => n.kind).join(',') || '-'}`);
      }
    }
    console.log(`[ask] report: ${path.join(root, 'report.json')}`);
    expect(runs.length).toBeGreaterThan(0);
  });
});
