// Executor — 팀원 노트북에서 도는 프로그램.
// 서버 주소는 ~/.nomos/credentials의 baseUrl에서 온다.
//
//   executor login <baseUrl> [--name 이름] [--connect-key]
//                              브라우저 승인으로 연결해 자격 증명을 새로 쓴다(기본). 브라우저가 없는 환경(SSH)은
//                              --connect-key 또는 NOMOS_CONNECT_KEY로 가입 때 받은 연결 키를 쓴다.
//   executor refresh           토큰 재발급 (프로젝트에 배정된 뒤 한 번)
//   executor once              READY 태스크 하나만 처리하고 종료 (개발·데모용)
//   executor start             10초 폴링
//   executor clean             worktree 정리
//
// 서버를 옮길 때 baseUrl만 바꾸면 안 된다. 토큰은 발급한 서버의 서명 키와 그 DB의 agents 행에 묶여 있어
// 다른 서버에서는 전부 401이다. 원격에 가입해 받은 연결 키로 login을 다시 해야 한다.
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { buildMcpConfig } from '../bridge/claude-args.js';
import {
  credentialsPath,
  readCredentials,
  updateAccessToken,
  writeCredentials,
} from '../bridge/credentials.js';
import { NomosClient } from '../bridge/nomos-client.js';
import { deviceLogin } from './device-login.js';
import { buildTaskPrompt } from './prompt.js';
import { runClaude } from './runner.js';
import { pollingTaskSource, type TaskSource, type TaskSummary } from './task-source.js';
import { runLint, runSpecTests, type SpecTest, type StageReport } from './verify.js';
import { cleanWorkspaces, headSha, prepareWorkspace, resolveRepoPath } from './workspace.js';

const POLL_INTERVAL_MS = 10_000;

function log(line: string): void {
  process.stdout.write(`[executor] ${line}\n`);
}

function createClient(): NomosClient {
  const credentials = readCredentials();
  if (!credentials) {
    throw new Error(`${credentialsPath()}가 없습니다. npm run seed로 만들거나 직접 작성하세요`);
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
  repo: { fullName: string; defaultBranch: string };
  spec: { featureKey: string; title: string; content: string } | null;
  notesBlock: string;
  writablePaths: { pathPattern: string }[];
  claudeSettings: unknown;
  specTests: SpecTest[];
  policyHash: string;
};

async function handleTask(client: NomosClient, projectId: string, task: TaskSummary): Promise<void> {
  log(`태스크 ${task.id} — ${task.title}`);
  const briefing = (await client.getBriefing(task.id)) as unknown as Briefing;

  const repoPath = resolveRepoPath(briefing.repo.fullName);
  const workspace = prepareWorkspace({
    repoPath,
    projectId,
    taskId: task.id,
    branchName: briefing.task.branchName,
    baseBranch: briefing.repo.defaultBranch,
    settings: briefing.claudeSettings,
    policyHash: briefing.policyHash,
  });
  log(`작업공간 ${workspace.dir} (브랜치 ${workspace.branch})`);

  if (workspace.createdBranch) {
    await client.reportBranch(task.id, workspace.branch);
  }

  // MCP 설정은 작업공간마다 둔다. 비밀값은 없다 — 자격 증명은 ~/.nomos/credentials가 정본이다.
  const mcpConfigPath = path.join(workspace.dir, '.nomos-mcp.json');
  writeFileSync(
    mcpConfigPath,
    // 작업공간 경로를 넘겨야 submit_artifact가 이 worktree의 태스크 브랜치를 push한다.
    buildMcpConfig({ serverPath: path.resolve('dist/bridge/mcp-server.js'), workspaceDir: workspace.dir }),
  );

  const before = headSha(workspace.dir);
  const result = await runClaude({
    workspaceDir: workspace.dir,
    prompt: buildTaskPrompt(briefing, workspace.branch),
    mcpConfigPath,
  });
  const committed = headSha(workspace.dir) !== before;

  // 자동 재시도는 넣지 않는다. tasks.retry_count는 서버가 관리하는 값이고,
  // Executor가 멋대로 돌리면 M4(재작업률)가 오염된다.
  if (result.outcome === 'completed' && committed) {
    log(`완료 (${Math.round(result.durationMs / 1000)}초). 커밋 있음 — 제출은 모델이 이미 했을 것`);
    await reportBridgeStages(client, task.id, workspace.dir, briefing.specTests);
  } else if (result.outcome === 'completed') {
    log(`정상 종료했지만 커밋이 없다. 태스크는 그대로 둔다. 로그: ${result.logPath}`);
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
  const source = pollingTaskSource(client, self.projectId);

  const [task] = await source.nextTasks(1);
  if (!task) {
    log('READY 태스크가 없다');
    return;
  }
  await handleTask(client, self.projectId, task);
}

async function start(): Promise<void> {
  const client = createClient();
  const self = await client.describeSelf();
  const source: TaskSource = pollingTaskSource(client, self.projectId);
  log(`시작 — 프로젝트 ${self.projectId}, 역할 ${self.teamRole}, 동시 실행 ${self.maxConcurrent} (${source.kind})`);

  const inFlight = new Set<string>();

  for (;;) {
    try {
      const capacity = self.maxConcurrent - inFlight.size;
      if (capacity > 0) {
        for (const task of await source.nextTasks(capacity)) {
          // 이미 처리 중인 태스크는 건너뛴다. 폴링은 같은 목록을 여러 번 준다.
          if (inFlight.has(task.id)) continue;
          inFlight.add(task.id);
          void handleTask(client, self.projectId, task)
            .catch((err) => log(`태스크 ${task.id} 실패: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => inFlight.delete(task.id));
        }
      }
    } catch (err) {
      log(`폴링 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// 토큰이 헤더로 다니므로 원격은 https만 받는다. 로컬 개발 서버만 예외다.
function normalizeBaseUrl(raw: string | undefined): string {
  if (!raw) throw new Error('사용법: executor login <baseUrl>   예) executor login https://your-team.duckdns.org');
  const url = new URL(raw);
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

function parseLoginArgs(argv: string[]): { baseUrl: string | undefined; name: string | undefined; connectKey: boolean } {
  let baseUrl: string | undefined;
  let name: string | undefined;
  let connectKey = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--name') name = argv[(i += 1)];
    else if (arg === '--connect-key') connectKey = true;
    else baseUrl ??= arg;
  }
  return { baseUrl, name, connectKey };
}

async function login(argv: string[]): Promise<void> {
  const args = parseLoginArgs(argv);
  const baseUrl = normalizeBaseUrl(args.baseUrl);
  const previous = readCredentials();
  if (previous && previous.baseUrl !== baseUrl) {
    log(`기존 자격 증명(${previous.baseUrl})을 ${baseUrl}용으로 교체한다`);
  }
  const agentName = args.name?.trim() || os.hostname();

  // 기본은 브라우저 승인. 연결 키를 명시했거나(--connect-key) 환경변수로 줬으면 기존 경로.
  if (!args.connectKey && process.env.NOMOS_CONNECT_KEY === undefined) {
    const { credentials, account } = await deviceLogin({ baseUrl, agentName });
    writeCredentials(credentials);
    // 연결된 계정을 반드시 보여 준다 — 내가 아닌 계정이면 누군가 내 코드를 승인한 것이다.
    const org = account.orgName ? ` · 조직 ${account.orgName}` : ' · 조직 없음';
    log(`연결됨: ${account.nickname ?? account.loginId ?? '?'} (${account.loginId ?? '?'})${org} — 에이전트 ${agentName}`);
    log(`${credentialsPath()}에 저장했다. 내 계정이 아니면 바로 웹에서 이 에이전트를 확인하라.`);
    log('대표에게 이 에이전트를 프로젝트에 배정해 달라고 한 뒤 `npm run executor refresh`를 한 번 실행하라');
    return;
  }

  // 연결 키는 NOMOS_CONNECT_KEY로도 받는다 — 인자로 받으면 셸 기록에 남는다.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const connectKey = (process.env.NOMOS_CONNECT_KEY ?? (await rl.question('연결 키 (원격 서버에 가입할 때 받은 값): '))).trim();
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
    log('대표에게 이 에이전트를 프로젝트에 배정해 달라고 한 뒤 `npm run executor refresh`를 한 번 실행하라');
  } finally {
    rl.close();
  }
}

// 배정 전에 받은 토큰에는 project_id가 없다. 배정 뒤 한 번 재발급해야 태스크 API를 쓸 수 있다.
async function refresh(): Promise<void> {
  const credentials = readCredentials();
  if (!credentials) throw new Error(`${credentialsPath()}가 없다. 먼저 executor login <baseUrl>`);
  const data = await postJson(`${credentials.baseUrl}/api/agents/token/refresh`, { refreshToken: credentials.refreshToken });
  updateAccessToken(String(data.accessToken));
  try {
    const self = await createClient().describeSelf();
    log(`재발급 완료 — 프로젝트 ${self.projectId}, 역할 ${self.teamRole ?? '없음'}`);
  } catch (err) {
    log(`재발급은 됐지만 아직 프로젝트에 배정되지 않은 것 같다: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'login') return login(process.argv.slice(3));
  if (command === 'refresh') return refresh();
  if (command === 'once') return once();
  if (command === 'start') return start();
  if (command === 'clean') {
    const { pruned, removed } = cleanWorkspaces();
    log(`worktree prune: ${pruned.join(', ') || '없음'} / 삭제: ${removed ?? '없음'}`);
    return;
  }
  process.stderr.write('사용법: executor <login <baseUrl> [--name 이름] [--connect-key]|refresh|once|start|clean>\n');
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
