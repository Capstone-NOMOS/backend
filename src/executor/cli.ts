#!/usr/bin/env node
// Executor — 팀원 노트북에서 도는 프로그램. npm 패키지 @capstone-nomos/cli로 배포된다(bin: nomos).
// 서버 주소는 ~/.nomos/credentials의 baseUrl에서 온다.
//
//   nomos connect [--server 주소] [--name 이름]
//                              웹 안내의 한 줄. 로그인(필요하면) → 배정 대기(자동 재발급) → start. --server 기본은 운영 주소.
//   nomos doctor [--json]      git·claude·자격 증명·MCP 서버 파일 점검
//   nomos login [baseUrl] [--name 이름] [--connect-key]
//                              브라우저 승인으로 연결해 자격 증명을 새로 쓴다(기본). 브라우저가 없는 환경(SSH)은
//                              --connect-key 또는 NOMOS_CONNECT_KEY로 가입 때 받은 연결 키를 쓴다.
//   executor refresh           토큰 재발급 (프로젝트에 배정된 뒤 한 번)
//   executor once              READY 태스크 하나만 처리하고 종료 (개발·데모용)
//   executor start             10초 폴링
//   executor clean             worktree 정리
//   nomos pm-worker            (대표 전용, 서버가 PM_PROVIDER=relay일 때) PM의 모델 호출을 이 노트북의 Claude Code로 대신 실행
//
// 서버를 옮길 때 baseUrl만 바꾸면 안 된다. 토큰은 발급한 서버의 서명 키와 그 DB의 agents 행에 묶여 있어
// 다른 서버에서는 전부 401이다. 원격에 가입해 받은 연결 키로 login을 다시 해야 한다.
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { writeBriefingNotes } from '../bridge/briefing-notes.js';
import { ALLOWED_BASH_PREFIXES, buildMcpConfig } from '../bridge/claude-args.js';
import { prepareDependencies } from './setup.js';
import {
  credentialsPath,
  readCredentials,
  updateAccessToken,
  writeCredentials,
} from '../bridge/credentials.js';
import { NomosApiError, NomosClient } from '../bridge/nomos-client.js';
import { ActivityReporter, activityFromStreamLine, RunObserver } from './activity.js';
import { connect, DEFAULT_SERVER, serverCalls } from './connect.js';
import { deviceLogin } from './device-login.js';
import { cliVersion, mcpServerPath } from './paths.js';
import { checkTools } from './preflight.js';
import { handleNextPmJob } from './pm-worker.js';
import { buildTaskPrompt } from './prompt.js';
import { DEFAULT_IDLE_MS, runClaude } from './runner.js';
import { streamTaskSource } from './stream-source.js';
import { pollingTaskSource, type TaskSource, type TaskSummary } from './task-source.js';
import { runLint, runSpecTests, type SpecTest, type StageReport } from './verify.js';
import { ensureRepo } from './repo-checkout.js';
import { runConsult } from './consult.js';
import { cleanWorkspaces, headSha, prepareWorkspace } from './workspace.js';

// 푸시가 오지 않아도 이 간격으로 한 번씩 다시 본다(끊겼을 때는 이 간격으로 폴링한다).
const POLL_INTERVAL_MS = 10_000;

function log(line: string): void {
  process.stdout.write(`[nomos] ${line}\n`);
}

function createClient(): NomosClient {
  const credentials = readCredentials();
  if (!credentials) {
    throw new Error(`${credentialsPath()}가 없습니다. 먼저 connect(또는 login)를 실행하세요`);
  }
  return new NomosClient({
    baseUrl: credentials.baseUrl,
    tokens: { accessToken: credentials.accessToken, refreshToken: credentials.refreshToken },
    // 재발급 결과를 파일에 되돌려 쓴다. 없으면 다음 실행이 또 401로 시작한다.
    onTokensChanged: (tokens) => updateAccessToken(tokens.accessToken),
  });
}

type Briefing = {
  task: { id: string; title: string; teamRole: string | null; branchName: string | null };
  repo: { fullName: string; defaultBranch: string; cloneUrl?: string | null };
  spec: { featureKey: string; title: string; content: string } | null;
  notes: { id: string }[];
  lastRejection: { reason: string; commitSha: string | null } | null;
  answeredQuestions?: { question: string; answer: string; source: string }[];
  questionRelay?: boolean;
  notesBlock: string;
  writablePaths: { pathPattern: string }[];
  claudeSettings: unknown;
  specTests: SpecTest[];
  policyHash: string;
};

// 지금 돌고 있는 태스크의 작업공간 — 상담 실행이 진행 중인 작업(커밋 안 된 파일 포함)을 읽으려고 둔다.
const activeWorkspaces = new Map<string, { dir: string; repo: string }>();

// 상담 실행(C안) — 다른 역할 에이전트가 이 역할 소관을 물으면 레포를 읽기만 해서 초안을 올린다(본인 구독).
// 한 번에 하나씩. 실패한 질문은 다시 시도하지 않는다 — 사람이 답한다(자동 재시도를 넣지 않는 Executor 원칙과 같다).
const consulting = new Set<string>();
const consultGaveUp = new Set<string>();

async function consultPending(client: NomosClient, role: string): Promise<void> {
  if (consulting.size > 0) return;
  const { questions, repos } = await client.listConsultJobs();
  const job = questions.find((q) => !consultGaveUp.has(q.id));
  if (!job) return;
  consulting.add(job.id);
  void (async () => {
    try {
      const active = [...activeWorkspaces.values()].find((w) => repos.some((r) => r.fullName === w.repo));
      const repo = active ? { fullName: active.repo } : repos[0];
      if (!repo) throw new Error('이 역할이 소유한 레포가 프로젝트에 없다');
      const dir = active ? active.dir : ensureRepo({ fullName: repo.fullName, cloneUrl: repos[0]!.cloneUrl }, { log }).path;
      log(`상담 실행: ${job.askerRole}의 질문 ${job.questions.length}개 — ${repo.fullName}${active ? ' (진행 중인 작업공간)' : ''}`);
      const draft = await runConsult({ dir, role, repoName: repo.fullName, question: job });
      const result = await client.submitDraft(job.id, draft);
      log(result.status === 'agent_answered' ? '  초안 올림 — 전부 코드에 정해져 있어 바로 답이 됐다(사람 확인 대기)' : '  초안 올림 — 정해지지 않은 결정이 있어 담당자에게 넘어갔다');
    } catch (err) {
      consultGaveUp.add(job.id);
      log(`  상담 실패 — 담당자가 직접 답한다: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      consulting.delete(job.id);
    }
  })();
}

async function handleTask(client: NomosClient, projectId: string, task: TaskSummary): Promise<void> {
  log(`태스크 ${task.id} — ${task.title}`);
  const briefing = (await client.getBriefing(task.id)) as unknown as Briefing;

  // cloneUrl이 없는 옛 서버(브리핑에 필드 자체가 없음)도 github.com/{fullName}으로 받는다.
  const checkout = ensureRepo({ fullName: briefing.repo.fullName, cloneUrl: briefing.repo.cloneUrl ?? null }, { log });
  const workspace = prepareWorkspace({
    repoPath: checkout.path,
    projectId,
    taskId: task.id,
    branchName: briefing.task.branchName,
    // CLI가 관리하는 클론은 방금 fetch한 origin/<기본 브랜치>에서 분기한다.
    baseBranch: checkout.baseRef(briefing.repo.defaultBranch),
    settings: briefing.claudeSettings,
    policyHash: briefing.policyHash,
  });
  log(`작업공간 ${workspace.dir} (브랜치 ${workspace.branch})`);
  activeWorkspaces.set(task.id, { dir: workspace.dir, repo: briefing.repo.fullName });
  // 프롬프트에 넣는 노트 = 제출 때 "받은 노트"로 함께 보낼 노트. MCP 서버(submit_artifact)가 읽는다.
  writeBriefingNotes(workspace.dir, task.id, (briefing.notes ?? []).map((n) => n.id));

  if (workspace.createdBranch) {
    await client.reportBranch(task.id, workspace.branch);
  }

  // MCP 설정은 작업공간마다 둔다. 비밀값은 없다 — 자격 증명은 ~/.nomos/credentials가 정본이다.
  const mcpConfigPath = path.join(workspace.dir, '.nomos-mcp.json');
  writeFileSync(
    mcpConfigPath,
    // 작업공간 경로를 넘겨야 submit_artifact가 이 worktree의 태스크 브랜치를 push한다.
    buildMcpConfig({ serverPath: mcpServerPath(), workspaceDir: workspace.dir }),
  );

  // 룸: 실행 시작을 알리고, 도는 동안 도구 사용을 보낸다. 룸 보고가 실패해도 실행은 그대로 간다(옛 서버에는 이 API가 없다).
  const runOpen = await client
    .startRun(task.id)
    .then(() => true)
    .catch((err: unknown) => {
      log(`룸에 실행 시작을 알리지 못했다(실행은 계속한다): ${err instanceof Error ? err.message : String(err)}`);
      return false;
    });
  const reporter = runOpen ? new ActivityReporter(client, task.id, log) : null;
  const observer = new RunObserver(workspace.dir);

  // 의존성은 모델이 아니라 여기서 설치한다(설치 스크립트 끔). 실패해도 진행한다 — 프롬프트에 결과를 적는다.
  const setup = await prepareDependencies(workspace.dir, log);

  const before = headSha(workspace.dir);
  const result = await runClaude({
    workspaceDir: workspace.dir,
    prompt: buildTaskPrompt(briefing, workspace.branch, { allowedCommands: ALLOWED_BASH_PREFIXES, setup: setup.steps }),
    mcpConfigPath,
    pathPrepend: setup.venvBin,
    // 질문 중계가 꺼진 프로젝트(또는 옛 서버)면 권한 도구를 붙이지 않는다 — AskUserQuestion이 없어진다.
    questionRelay: briefing.questionRelay === true,
    onStdoutLine: (line: string) => {
      observer.observe(line);
      reporter?.push(activityFromStreamLine(line, workspace.dir));
    },
  });
  const committed = headSha(workspace.dir) !== before;

  if (reporter) {
    await reporter.close();
    // 제출했는지는 서버가 태스크 상태로 판단해 룸에 남긴다("끝났지만 제출하지 않았다"가 대표에게 보인다).
    // 응답 없음(stalled)은 서버에 timeout으로 보고하고 사유 문장으로 구분한다 — 옛 서버는 outcome에 stalled를 모른다.
    const summary = observer.summary();
    const stalledNote = `[응답 없음] ${Math.round(DEFAULT_IDLE_MS / 60_000)}분 동안 모델 출력이 없어 Executor가 실행을 끊었다`;
    await client
      .endRun(task.id, {
        outcome: result.outcome === 'stalled' ? 'timeout' : result.outcome,
        committed,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        ...summary,
        ...(result.outcome === 'stalled' ? { lastMessage: (summary.lastMessage ? `${stalledNote} — 마지막 말: ${summary.lastMessage}` : stalledNote).slice(0, 2000) } : {}),
      })
      .then((r) => {
        if (r.blocked) log('제출 없이 끝나 태스크가 멈춤(BLOCKED)으로 바뀌었다 — 대표가 원인을 해결하고 재개하면 다시 가져간다');
      })
      .catch((err: unknown) => log(`룸에 실행 종료를 알리지 못했다: ${err instanceof Error ? err.message : String(err)}`));
  }

  // 자동 재시도는 넣지 않는다. tasks.retry_count는 서버가 관리하는 값이고,
  // Executor가 멋대로 돌리면 M4(재작업률)가 오염된다.
  if (result.outcome === 'completed' && committed) {
    log(`완료 (${Math.round(result.durationMs / 1000)}초). 커밋 있음 — 제출은 모델이 이미 했을 것`);
    await reportBridgeStages(client, task.id, workspace.dir, briefing.specTests);
  } else if (result.outcome === 'completed') {
    log(`정상 종료했지만 커밋이 없다. 태스크는 그대로 둔다. 로그: ${result.logPath}`);
  } else if (result.outcome === 'stalled') {
    log(`${Math.round(DEFAULT_IDLE_MS / 60_000)}분 동안 모델 출력이 없어 끊었다(응답 없음). 재시도하지 않는다. 로그: ${result.logPath}`);
  } else if (result.outcome === 'timeout') {
    log(`30분 초과로 종료했다. 재시도하지 않는다. 로그: ${result.logPath}`);
  } else {
    log(`비정상 종료 (exit=${result.exitCode}). 재시도하지 않는다. 로그: ${result.logPath}`);
  }
}

// 모델이 submit_artifact를 불렀다면 산출물이 생겼을 것이다. 그 위에 V2·V4를 얹는다.
// 제출이 없으면(모델이 도구를 안 불렀거나 거부당했으면) 붙일 곳이 없으므로 건너뛴다.
async function reportBridgeStages(
  client: NomosClient,
  taskId: string,
  workspaceDir: string,
  specTests: SpecTest[],
): Promise<void> {
  const [latest] = await client.listArtifacts(taskId);
  if (!latest) {
    log('산출물이 없다 — V2·V4를 붙일 곳이 없어 건너뛴다');
    return;
  }
  const artifactId = String(latest.id);

  const reports: StageReport[] = [
    await runSpecTests(workspaceDir, specTests),
    await runLint(workspaceDir),
  ];
  for (const report of reports) {
    log(`${report.stage} ${report.result} (${Math.round(report.durationMs / 1000)}초)`);
    try {
      const summary = (await client.reportVerification(artifactId, report)) as {
        outcome?: string;
        taskState?: string;
      };
      log(`  보고됨 — 결론 ${summary.outcome ?? '?'} / 태스크 ${summary.taskState ?? '?'}`);
    } catch (err) {
      // 보고 실패로 작업 자체를 되돌리지 않는다. 서버에는 아직 결과가 없으므로
      // 태스크는 VERIFYING에 머물고, 사람이 보면 무엇이 빠졌는지 알 수 있다.
      log(`  보고 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function once(): Promise<void> {
  const client = createClient();
  const self = await client.describeSelf();
  const source = pollingTaskSource(client);

  const [task] = await source.nextTasks(1);
  if (!task) {
    log('지금 가져갈 수 있는 태스크가 없다(프로젝트 시작 전이거나, 선행 태스크가 끝나지 않았거나, READY가 없다)');
    return;
  }
  await handleTask(client, self.projectId, task);
}

async function start(): Promise<void> {
  const client = createClient();
  const self = await client.describeSelf();
  // 서버 푸시(웹소켓)로 받는다. 끊겨 있는 동안은 같은 목록을 HTTP로 읽는다.
  const source: TaskSource = streamTaskSource({
    baseUrl: readCredentials()!.baseUrl,
    accessToken: () => readCredentials()!.accessToken,
    refresh: async () => {
      if ((await serverCalls({ read: readCredentials, updateAccessToken }).refresh()) === 'rejected') {
        throw new Error('refresh token이 거부됐다 — connect를 다시 실행하라');
      }
    },
    fallback: () => pollingTaskSource(client).nextTasks(Number.MAX_SAFE_INTEGER),
    log,
  });
  log(`시작 — 프로젝트 ${self.projectId}, 역할 ${self.teamRole}, 동시 실행 ${self.maxConcurrent} (${source.kind})`);

  const inFlight = new Set<string>();
  // 태스크 하나가 끝나면 자리가 난다 — 다음 푸시나 간격을 기다리지 않고 바로 다시 본다.
  let finished: () => void = () => {};

  for (;;) {
    try {
      const capacity = self.maxConcurrent - inFlight.size;
      if (capacity > 0) {
        // 처리 중인 것도 목록에 남아 있을 수 있으니(수령 전) 그만큼 더 받아 거른다.
        for (const task of (await source.nextTasks(capacity + inFlight.size)).filter((t) => !inFlight.has(t.id)).slice(0, capacity)) {
          inFlight.add(task.id);
          void handleTask(client, self.projectId, task)
            .catch((err) => log(`태스크 ${task.id} 실패: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => {
              inFlight.delete(task.id);
              activeWorkspaces.delete(task.id);
              finished();
            });
        }
      }
    } catch (err) {
      log(`태스크 목록 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 다른 역할이 이 역할에 물은 질문 — 질문이 생기면 서버가 { type: 'questions' }로 깨운다. 신호가 없으면 1분마다만 확인한다.
    try {
      // 역할이 없는 에이전트(역할 제한 없는 배정)는 상담할 소관도 없다.
      if (self.teamRole && source.consultDue(self.teamRole)) await consultPending(client, self.teamRole);
    } catch (err) {
      log(`상담할 질문 목록 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    await Promise.race([source.waitForChange(POLL_INTERVAL_MS), new Promise<void>((resolve) => (finished = resolve))]);
  }
}

// 토큰이 헤더로 다니므로 원격은 https만 받는다. 로컬 개발 서버만 예외다.
function normalizeBaseUrl(raw: string | undefined): string {
  const url = new URL(raw ?? DEFAULT_SERVER);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    throw new Error(`원격 서버는 https여야 한다: ${raw}`);
  }
  return url.origin;
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>; error?: { code?: string; message?: string } };
  if (!res.ok || !json.data) {
    throw new Error(`${res.status} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`.trim());
  }
  return json.data;
}

type ParsedArgs = { positional: string | undefined; server: string | undefined; name: string | undefined; connectKey: boolean; json: boolean };

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { positional: undefined, server: undefined, name: undefined, connectKey: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--name') out.name = argv[(i += 1)];
    else if (arg === '--server') out.server = argv[(i += 1)];
    else if (arg === '--connect-key') out.connectKey = true;
    else if (arg === '--json') out.json = true;
    else out.positional ??= arg;
  }
  return out;
}

// 서버에 붙어 ~/.nomos/credentials를 새로 쓴다. 기본은 브라우저 승인,
// 연결 키를 명시했거나(--connect-key) 환경변수로 줬으면 기존 경로(SSH 등 브라우저가 없는 환경).
async function loginTo(baseUrl: string, agentName: string, viaConnectKey: boolean): Promise<void> {
  if (!viaConnectKey && process.env.NOMOS_CONNECT_KEY === undefined) {
    const { credentials, account } = await deviceLogin({ baseUrl, agentName });
    writeCredentials(credentials);
    // 연결된 계정을 반드시 보여 준다 — 내가 아닌 계정이면 누군가 내 코드를 승인한 것이다.
    const org = account.orgName ? ` · 조직 ${account.orgName}` : ' · 조직 없음';
    log(`연결됨: ${account.nickname ?? account.loginId ?? '?'} (${account.loginId ?? '?'})${org} — 에이전트 ${agentName}`);
    log(`${credentialsPath()}에 저장했다. 내 계정이 아니면 바로 웹에서 이 에이전트를 확인하라.`);
    return;
  }

  // 연결 키는 NOMOS_CONNECT_KEY로도 받는다 — 인자로 받으면 셸 기록에 남는다.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const connectKey = (process.env.NOMOS_CONNECT_KEY ?? (await rl.question('연결 키 (가입할 때 받은 값): '))).trim();
    rl.close();
    const data = await postJson(`${baseUrl}/api/agents/connect`, {
      connectKey,
      agentName,
      harness: 'claude-code',
      skills: [],
      maxConcurrent: 2,
    });
    writeCredentials({
      baseUrl,
      accessToken: String(data.accessToken),
      refreshToken: String(data.refreshToken),
      agentId: String(data.agentId),
    });
    log(`${credentialsPath()}에 저장했다 (에이전트 ${String(data.agentId)})`);
  } finally {
    rl.close();
  }
}

async function login(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const baseUrl = normalizeBaseUrl(args.positional ?? args.server);
  const previous = readCredentials();
  if (previous && previous.baseUrl !== baseUrl) {
    log(`기존 자격 증명(${previous.baseUrl})을 ${baseUrl}용으로 교체한다`);
  }
  await loginTo(baseUrl, args.name?.trim() || os.hostname(), args.connectKey);
  log('대표에게 이 에이전트를 프로젝트에 배정해 달라고 한 뒤 connect를 실행하라(배정되면 자동으로 시작한다)');
}

async function connectCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const server = normalizeBaseUrl(args.server ?? args.positional ?? process.env.NOMOS_SERVER);
  const agentName = args.name?.trim() || os.hostname();
  log(`NOMOS CLI ${cliVersion()} — 서버 ${server}`);

  const missing = checkTools().filter((t) => !t.ok);
  if (missing.length > 0) {
    for (const t of missing) log(`${t.name}을 실행할 수 없다: ${t.detail}\n        → ${t.hint}`);
    throw new Error('필요한 도구가 없어 시작하지 않는다');
  }

  await connect({
    server,
    agentName,
    readCredentials,
    login: () => loginTo(server, agentName, args.connectKey),
    ...serverCalls({ read: readCredentials, updateAccessToken }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
  });
  await start();
}

async function doctor(argv: string[]): Promise<void> {
  const { json } = parseArgs(argv);
  let mcp: { ok: boolean; detail: string };
  try {
    mcp = { ok: true, detail: mcpServerPath() };
  } catch (err) {
    mcp = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  let server: string | null = null;
  try {
    server = readCredentials()?.baseUrl ?? null;
  } catch {
    server = null;
  }
  const report = { version: cliVersion(), node: process.version, mcpServer: mcp, tools: checkTools(), server };
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    log(`버전 ${report.version} (node ${report.node})`);
    log(`MCP 서버: ${mcp.ok ? 'OK' : '없음'} — ${mcp.detail}`);
    for (const t of report.tools) log(`${t.name}: ${t.ok ? t.detail : `없음 — ${t.hint}`}`);
    log(`연결된 서버: ${server ?? '없음 (connect를 실행하라)'}`);
  }
  // 패키지 자체가 깨진 경우만 실패로 끝낸다. git·claude가 없는 건 안내로 충분하다.
  if (!mcp.ok) process.exitCode = 1;
}

// 배정 전에 받은 토큰에는 project_id가 없다. 배정 뒤 한 번 재발급해야 태스크 API를 쓸 수 있다.
async function refresh(): Promise<void> {
  const credentials = readCredentials();
  if (!credentials) throw new Error(`${credentialsPath()}가 없다. 먼저 connect(또는 login)를 실행하라`);
  const data = await postJson(`${credentials.baseUrl}/api/agents/token/refresh`, { refreshToken: credentials.refreshToken });
  updateAccessToken(String(data.accessToken));
  try {
    const self = await createClient().describeSelf();
    log(`재발급 완료 — 프로젝트 ${self.projectId}, 역할 ${self.teamRole ?? '없음'}`);
  } catch (err) {
    log(`재발급은 됐지만 아직 프로젝트에 배정되지 않은 것 같다: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const PM_POLL_INTERVAL_MS = 3_000;

async function pmWorker(): Promise<void> {
  const client = createClient();
  log('pm-worker 시작 — 대표가 PM에 계획을 요청하면 여기서 claude가 돈다 (Ctrl+C로 종료)');
  for (;;) {
    try {
      if (await handleNextPmJob(client, log)) continue;
    } catch (err) {
      // 설정이 틀린 경우는 기다려도 풀리지 않는다 — 바로 멈춘다.
      if (err instanceof NomosApiError && (err.code === 'PM_RELAY_DISABLED' || err.code === 'NOT_REPRESENTATIVE')) throw err;
      log(`폴링 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, PM_POLL_INTERVAL_MS));
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'connect') return connectCommand(process.argv.slice(3));
  if (command === 'doctor') return doctor(process.argv.slice(3));
  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${cliVersion()}\n`);
    return;
  }
  if (command === 'login') return login(process.argv.slice(3));
  if (command === 'refresh') return refresh();
  if (command === 'once') return once();
  if (command === 'start') return start();
  if (command === 'pm-worker') return pmWorker();
  if (command === 'clean') {
    const { pruned, removed } = cleanWorkspaces();
    log(`worktree prune: ${pruned.join(', ') || '없음'} / 삭제: ${removed ?? '없음'}`);
    return;
  }
  process.stderr.write(
    [
      '사용법: nomos <명령>',
      '  connect [--server 주소] [--name 이름]        로그인 → 배정 대기 → 작업 시작 (처음이라면 이것만)',
      '  doctor                                       설치 상태 점검',
      '  login [주소] [--name 이름] [--connect-key]   로그인만',
      '  refresh | once | start | clean | --version',
      '  pm-worker                                    (대표 전용, 서버가 PM_PROVIDER=relay일 때) PM 모델 호출을 이 노트북의 Claude Code로',
      '',
    ].join('\n'),
  );
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
