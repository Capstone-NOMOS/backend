// 질문 중계 점검 — 기존 프로젝트에 "에이전트가 반드시 AskUserQuestion을 띄우는" 명세·태스크를 API로 만든다.
// 기능 명세 → 계약 → 태스크 나누기 전체를 돌리지 않고 질문이 서버·라우터·화면(룸·질문 카드·알림)까지 가는지만 본다.
//
//   npm run probe:questions -- --project <id> --login <대표 loginId> --fe-repo <owner/name|id> --be-repo <owner/name|id>
//   npm run probe:questions -- ... --only be,pm            # 시나리오 고르기 (be·fe·pm, 기본 전부)
//   npm run probe:questions -- ... --dry-run               # 만들 내용만 출력
//   --server <주소>   기본 https://nomos-team.duckdns.org  (로컬: http://localhost:3000)
//
// 시나리오(scripts/lib/question-probe.ts):
//   be  FE 태스크가 BE 소관(목록 페이지 크기)을 묻는다   → 대상 BACKEND, BE 상담 초안, BE 담당이 답
//   fe  BE 태스크가 FE 소관(빈 결과 문구)을 묻는다       → 대상 FRONTEND
//   pm  FE 태스크가 제품 정책(탈퇴 회원 기록 보관)을 묻는다 → 대상 PM, PM 초안 → 대표 확정
//
// 대표 권한(API: 명세·태스크 생성)으로 만든다. 비밀번호는 NOMOS_PASSWORD 환경변수 또는 입력 창(화면에 안 보임).
// 이미 받은 토큰이 있으면 NOMOS_TOKEN. 서버 코드(env.ts·DB)를 거치지 않는다 — HTTP만 쓴다.
import { buildProbe, parseScenarios, probeStamp, type ProbeScenario } from './lib/question-probe.js';

const DEFAULT_SERVER = 'https://nomos-team.duckdns.org';

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

type Args = {
  server: string;
  project: string;
  login: string | undefined;
  feRepo: string | undefined;
  beRepo: string | undefined;
  only: ProbeScenario[];
  dryRun: boolean;
};

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    '사용법: npm run probe:questions -- --project <id> --login <대표 loginId> --fe-repo <owner/name|id> --be-repo <owner/name|id>\n' +
      '        [--only be,fe,pm] [--server <주소>] [--dry-run]\n',
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const value = (i: number): string => {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) usage(`${argv[i]}에 값이 없다`);
    return v;
  };
  let server = DEFAULT_SERVER;
  let project: string | undefined;
  let login: string | undefined;
  let feRepo: string | undefined;
  let beRepo: string | undefined;
  let only: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--server') server = value(i++);
    else if (arg === '--project') project = value(i++);
    else if (arg === '--login') login = value(i++);
    else if (arg === '--fe-repo') feRepo = value(i++);
    else if (arg === '--be-repo') beRepo = value(i++);
    else if (arg === '--only') only = value(i++);
    else if (arg === '--dry-run') dryRun = true;
    else usage(`모르는 인자: ${arg}`);
  }
  if (!project) usage('--project가 필요하다');
  let scenarios: ProbeScenario[];
  try {
    scenarios = parseScenarios(only);
  } catch (err) {
    usage((err as Error).message);
  }
  return { server: server.replace(/\/+$/, ''), project, login, feRepo, beRepo, only: scenarios, dryRun };
}

// 입력한 글자를 화면에 찍지 않는 비밀번호 입력.
async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error('비밀번호를 입력받을 터미널이 없다 — NOMOS_PASSWORD 또는 NOMOS_TOKEN을 설정하라');
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          reject(new Error('취소했다'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

class Api {
  constructor(
    private readonly base: string,
    private token = '',
  ) {}

  setToken(token: string): void {
    this.token = token;
  }

  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // HTML 오류 페이지 등
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      const detail = err?.details ? ` ${JSON.stringify(err.details)}` : '';
      throw new Error(`${method} ${path} → ${res.status} ${err?.code ?? ''} ${err?.message ?? text.slice(0, 200)}${detail}`);
    }
    return (json as { data: T }).data;
  }
}

type ProjectDetail = {
  project: { id: string; name: string; status: string; questionRelay: boolean };
  repos: { id: string; fullName: string }[];
  members: { teamRole: string; agentId: string | null; agentName: string | null; userId: string }[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveRepo(detail: ProjectDetail, raw: string | undefined, flag: string): { id: string; fullName: string } {
  if (!raw) usage(`${flag}가 필요하다 (이 시나리오의 태스크가 들어갈 레포)`);
  const repo = UUID.test(raw)
    ? detail.repos.find((r) => r.id === raw)
    : detail.repos.find((r) => r.fullName.toLowerCase() === raw.toLowerCase());
  if (!repo) {
    throw new Error(`${flag} ${raw}: 이 프로젝트의 레포가 아니다. 프로젝트 레포: ${detail.repos.map((r) => r.fullName).join(', ') || '(없음)'}`);
  }
  return repo;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const api = new Api(args.server);
  const stamp = probeStamp();
  const plans = args.only.map((s) => buildProbe(s, stamp));

  out(`서버: ${args.server}`);
  out(`시나리오: ${args.only.join(', ')}  (꼬리표 ${stamp})`);

  if (args.dryRun) {
    for (const p of plans) {
      out();
      out(`[${p.definition.scenario}] ${p.task.teamRole} 태스크 → 예상 대상 ${p.definition.expectedTarget}`);
      out(`  명세 ${p.spec.featureKey} "${p.spec.title}"`);
      out(p.spec.content.replace(/^/gm, '    '));
    }
    out();
    out('--dry-run: 아무것도 만들지 않았다');
    return;
  }

  const presetToken = process.env.NOMOS_TOKEN;
  if (presetToken) {
    api.setToken(presetToken);
  } else {
    if (!args.login) usage('--login이 필요하다 (또는 NOMOS_TOKEN)');
    const password = process.env.NOMOS_PASSWORD ?? (await readHidden(`${args.login} 비밀번호: `));
    const auth = await api.call<{ accessToken: string }>('POST', '/auth/login', { loginId: args.login, password });
    api.setToken(auth.accessToken);
  }

  const detail = await api.call<ProjectDetail>('GET', `/projects/${args.project}`);
  out(`프로젝트: ${detail.project.name} (${detail.project.status})`);
  if (!detail.project.questionRelay) {
    throw new Error('이 프로젝트는 질문 중계가 꺼져 있다(questionRelay=false) — 에이전트가 질문하지 않고 가정한다. 시작 전에 켜고 다시 실행하라');
  }
  if (!['planning', 'active'].includes(detail.project.status)) {
    throw new Error(`프로젝트 상태가 ${detail.project.status}라 명세·태스크를 만들 수 없다 (planning·active만)`);
  }

  const roles = new Set(plans.map((p) => p.task.teamRole));
  const repoByRole = new Map<string, { id: string; fullName: string }>();
  if (roles.has('FRONTEND')) repoByRole.set('FRONTEND', resolveRepo(detail, args.feRepo, '--fe-repo'));
  if (roles.has('BACKEND')) repoByRole.set('BACKEND', resolveRepo(detail, args.beRepo, '--be-repo'));

  // 질문하는 쪽 에이전트가 없으면 아무도 태스크를 가져가지 않는다. 답할 쪽이 없으면 상담 초안이 없을 뿐 질문은 간다.
  const needed = new Set<string>([...roles, ...plans.map((p) => p.definition.expectedTarget).filter((t) => t !== 'PM')]);
  for (const role of needed) {
    const m = detail.members.find((x) => x.teamRole === role);
    if (!m) out(`  ! ${role} 담당이 배정되지 않았다 — 배정한 뒤 진행하라`);
    else if (!m.agentId) out(`  ! ${role} 담당의 에이전트가 연결돼 있지 않다 — 그 노트북에서 connect`);
  }

  out();
  const created: { scenario: string; taskId: string; title: string; role: string; repo: string; target: string }[] = [];
  for (const p of plans) {
    const repo = repoByRole.get(p.task.teamRole)!;
    const spec = await api.call<{ id: string; featureKey: string }>('POST', `/projects/${args.project}/specs`, p.spec);
    const task = await api.call<{ id: string; title: string; state: string }>('POST', `/projects/${args.project}/tasks`, {
      ...p.task,
      repoId: repo.id,
      specId: spec.id,
    });
    created.push({ scenario: p.definition.scenario, taskId: task.id, title: task.title, role: p.task.teamRole, repo: repo.fullName, target: p.definition.expectedTarget });
    out(`[${p.definition.scenario}] 만듦 — 태스크 ${task.id} (${task.state})`);
    out(`      ${task.title} · ${p.task.teamRole} · ${repo.fullName} → 예상 대상 ${p.definition.expectedTarget}`);
    out(`      질문: ${p.definition.question}`);
  }

  out();
  out('다음 순서:');
  if (detail.project.status === 'planning') out('  1. 웹에서 프로젝트를 시작한다 (시작 전에는 아무도 태스크를 가져가지 않는다)');
  else out('  1. 프로젝트가 이미 시작돼 있어 태스크가 바로 담당 에이전트에게 간다 (선행 태스크 없음)');
  out('  2. 질문하는 쪽·답하는 쪽 노트북에서 npx @capstone-nomos/cli@latest connect (PM 질문이면 대표 노트북의 pm-worker도)');
  out('  3. 화면에서 확인: 질문한 쪽 룸의 질문 줄 → 대상 역할 룸에도 같은 줄 → 대상 담당의 알림 배지(/me/questions)');
  out('     → 질문 카드(선택지·초안) → 웹에서 답 → 3분 안이면 같은 실행에서 이어 감, 넘으면 BLOCKED(질문 대기) → 답 후 재개');
  out('  4. 끝나면 README.md 한 줄 커밋이 제출·검증된다. 필요 없으면 대표가 태스크를 취소한다(POST /tasks/:id/cancel)');
}

main().catch((err: unknown) => {
  process.stderr.write(`실패: ${(err as Error).message}\n`);
  process.exit(1);
});
