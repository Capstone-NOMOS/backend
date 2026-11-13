// 실험 모드 프로젝트에서 나온 질문을 모아 평가용 묶음을 뽑는다 — 운영(또는 로컬) 서버의 대표 API만 읽는다(서버 DB에 붙지 않는다).
//
//   npm run questions:extract -- --login orepresent1103 --login orepresent1112            # 두 대표의 실험 모드 프로젝트 전부
//   npm run questions:extract -- --login orepresent1112 --project <id> --total 100
//   npm run questions:extract -- --login orepresent1103 --login orepresent1112 --full 777fa7da --project e0106f9d   # 한 프로젝트는 전부, 다른 쪽은 구현(중복 제거)+갈림만
//   --server <주소>(기본 운영) --total <N>(기본 100) --out <파일>(기본 scripts/data/experiment-questions-<시각>.json)
//   --project·--full은 id 앞부분만 써도 된다. --only <파일>이면 그 파일의 질문만 같은 순서로 다시 뽑는다(판정·판정 시간·비용만 새로).
//
// --full이 있으면(대표 결정 2026-11-13 두 번째): --full 프로젝트는 질문 전부, 나머지 프로젝트는 구현 중 질문(같은 태스크에서 나온 것은 한 번만) + 판정이 갈린 기획 단계 질문만.
//   --total은 쓰지 않는다(채우지 않는다).
//
// 고르는 규칙(대표 결정 2026-11-13):
//   1) 구현 중(implementation) 질문은 전부 넣는다.
//   2) 기획 단계(feature_spec·contract) 질문은 세 라우터(llm·openai·jev)의 판정이 **갈린 것**을 먼저 넣는다.
//   3) 그래도 --total에 모자라면 세 라우터가 **일치한** 기획 단계 질문으로 채운다(오래된 것부터).
// 판정이 갈렸다 = 판정을 낸(실패 아닌) 라우터들 사이에 서로 다른 대상이 있다. 일치 = 세 라우터가 모두 판정을 내고 같다. 그 밖(하나라도 실패하고 나머지가 같음)은 비교 불가로 채우기 맨 뒤.
//
// 질문·판정은 GET /projects/:id/routing-dataset(라우터가 본 입력 그대로 — 오프라인 평가가 그대로 읽는 v2 형식)과
// GET /projects/:id/routing-report(라우터별 판정)를 질문 id로 묶은 것이다. 비밀번호는 계정마다 화면에 안 보이는 입력 창으로 묻는다(파일·로그에 남기지 않는다).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NomosHttp, readHidden } from './lib/nomos-http.js';

const DEFAULT_SERVER = 'https://nomos-team.duckdns.org';
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const ROUTERS = ['llm', 'openai', 'jev'] as const;
type RouterKey = (typeof ROUTERS)[number];

type Project = { id: string; name: string; status: string; questionMode?: string; createdAt: string };
type DatasetItem = {
  id: string;
  stage: 'implementation' | 'feature_spec' | 'contract';
  input: { askerRole: string; task: { title: string } | null; spec: { featureKey: string; title: string } | null; questions: { question: string; options: { label: string }[] }[] };
  askedAt: string;
  primary: { router: string; target: string };
  accept: string[];
  answerSource: string | null;
};
type Metric = { modelLatencyMs: number | null; costUsd: number | null };
// metrics는 질문별 판정 시간·비용을 싣는 서버(feat/routing-report-row-metrics) 배포 뒤의 보고서에만 있다 — 옛 서버면 비어 있다.
type ReportRow = { questionId: string; decisions: Record<string, string | null>; metrics?: Record<string, Metric> };

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function usage(message: string): never {
  process.stderr.write(`${message}\n사용법: npm run questions:extract -- --login <대표> [--login <대표2>] [--project <id> ...] [--full <id>] [--only <파일>] [--total N] [--server 주소] [--out 파일]\n`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const a = { server: DEFAULT_SERVER, logins: [] as string[], projects: [] as string[], full: [] as string[], total: 100, out: '', only: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) usage(`${arg}에 값이 없다`);
      return v;
    };
    if (arg === '--server') a.server = value().replace(/\/+$/, '');
    else if (arg === '--login') a.logins.push(value());
    else if (arg === '--project') a.projects.push(value());
    else if (arg === '--full') a.full.push(value());
    else if (arg === '--total') {
      a.total = Number(value());
      if (!Number.isInteger(a.total) || a.total < 1) usage('--total은 1 이상의 정수다');
    } else if (arg === '--out') a.out = value();
    else if (arg === '--only') a.only = value();
    else usage(`모르는 인자: ${arg}`);
  }
  if (a.logins.length === 0) usage('--login이 필요하다');
  return a;
}

// 보고서의 라우터 이름(llm:claude-…:v3 · openai:gpt-…:v3 · jev:jev-…:v3)을 세 라우터로 묶는다. 기준선(baseline:asker)·대체(fallback:…)는 뺀다.
function routerKeyOf(name: string): RouterKey | null {
  const head = name.split(':')[0];
  return (ROUTERS as readonly string[]).includes(head ?? '') ? (head as RouterKey) : null;
}

type Picked = DatasetItem & {
  project: { id: string; name: string; login: string };
  routers: Partial<Record<RouterKey, string | null>>;
  // 라우터별 판정 시간(model_latency_ms)·비용 — 실제로 걸린 시간은 중계 대기열·CLI 기동이 섞여 부풀므로 싣지 않는다.
  routerMetrics: Partial<Record<RouterKey, Metric>>;
  agreement: 'disagree' | 'agree' | 'incomparable';
  selectedAs: 'implementation' | 'planning_disagree' | 'planning_agree' | 'planning_fill' | 'full';
};

// 갈림 = 판정을 낸 라우터끼리 서로 다르다(하나가 실패해도 나머지 둘이 다르면 갈림). 일치 = **세 라우터 모두** 판정을 냈고 같다 —
// 하나가 실패(null)한 채 나머지 둘만 같은 것은 세 라우터 일치가 아니라서 비교 불가로 둔다(채우기 맨 뒤).
function agreementOf(routers: Partial<Record<RouterKey, string | null>>): Picked['agreement'] {
  const decided = ROUTERS.map((k) => routers[k]).filter((t): t is string => typeof t === 'string');
  if (decided.length >= 2 && new Set(decided).size > 1) return 'disagree';
  return decided.length === ROUTERS.length ? 'agree' : 'incomparable';
}

async function login(server: string, loginId: string): Promise<NomosHttp> {
  const api = new NomosHttp(server);
  let password = '';
  while (password === '') password = await readHidden(`${loginId} 비밀번호: `);
  const auth = await api.call<{ accessToken: string }>('POST', '/auth/login', { loginId, password });
  api.setToken(auth.accessToken);
  return api;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  out(`서버: ${args.server}`);
  const all: Picked[] = [];

  for (const loginId of args.logins) {
    const api = await login(args.server, loginId);
    const me = await api.call<{ orgId: string | null }>('GET', '/me');
    if (!me.orgId) {
      out(`[${loginId}] 조직이 없다 — 건너뜀`);
      continue;
    }
    const wanted = [...args.projects, ...args.full];
    const projects = (await api.call<{ projects: Project[] }>('GET', `/orgs/${me.orgId}/projects`)).projects.filter((p) =>
      wanted.length > 0 ? wanted.some((w) => p.id.startsWith(w)) : p.questionMode === 'experiment',
    );
    if (projects.length === 0) out(`[${loginId}] 실험 모드 프로젝트가 없다`);
    for (const p of projects) {
      const items = (await api.call<{ items: DatasetItem[] }>('GET', `/projects/${p.id}/routing-dataset`)).items;
      const report = await api.call<{ rows: ReportRow[] }>('GET', `/projects/${p.id}/routing-report`);
      const byId = new Map(report.rows.map((r) => [r.questionId, r]));
      for (const item of items) {
        const row = byId.get(item.id);
        const routers: Partial<Record<RouterKey, string | null>> = {};
        for (const [name, target] of Object.entries(row?.decisions ?? {})) {
          const key = routerKeyOf(name);
          if (key) routers[key] = target;
        }
        const routerMetrics: Partial<Record<RouterKey, Metric>> = {};
        for (const [name, metric] of Object.entries(row?.metrics ?? {})) {
          const key = routerKeyOf(name);
          if (key) routerMetrics[key] = metric;
        }
        all.push({ ...item, project: { id: p.id, name: p.name, login: loginId }, routers, routerMetrics, agreement: agreementOf(routers), selectedAs: 'implementation' });
      }
      const counts = (stage: string) => items.filter((i) => i.stage === stage).length;
      out(
        `[${loginId}] ${p.name} (${p.status}, ${p.createdAt.slice(0, 10)}) — 질문 ${items.length}개: ` +
          `구현 ${counts('implementation')} · 기능 명세 ${counts('feature_spec')} · 계약 ${counts('contract')}`,
      );
    }
  }

  const byTime = (a: Picked, b: Picked) => a.askedAt.localeCompare(b.askedAt);
  if (args.only) {
    await writeOnlyMode(args, args.only, all);
    return;
  }
  if (args.full.length > 0) {
    await writeFullMode(args, all.sort(byTime));
    return;
  }
  const implementation = all.filter((q) => q.stage === 'implementation').sort(byTime);
  const planning = all.filter((q) => q.stage !== 'implementation').sort(byTime);
  const disagree = planning.filter((q) => q.agreement === 'disagree');
  const agree = planning.filter((q) => q.agreement === 'agree');
  const incomparable = planning.filter((q) => q.agreement === 'incomparable');

  const picked: Picked[] = implementation.map((q) => ({ ...q, selectedAs: 'implementation' as const }));
  for (const q of disagree) picked.push({ ...q, selectedAs: 'planning_disagree' });
  for (const q of agree) if (picked.length < args.total) picked.push({ ...q, selectedAs: 'planning_agree' });
  for (const q of incomparable) if (picked.length < args.total) picked.push({ ...q, selectedAs: 'planning_fill' });

  out();
  out(`전체 질문 ${all.length}개 — 구현 ${implementation.length} · 기획 단계 ${planning.length}(판정 갈림 ${disagree.length} · 일치 ${agree.length} · 비교 불가 ${incomparable.length})`);
  out(
    `뽑은 질문 ${picked.length}개(목표 ${args.total}) — 구현 ${implementation.length} · 기획 갈림 ${disagree.length} · 기획 일치 ${picked.filter((q) => q.selectedAs === 'planning_agree').length}` +
      ` · 채움 ${picked.filter((q) => q.selectedAs === 'planning_fill').length}`,
  );
  if (implementation.length + disagree.length > args.total) out(`  (구현 전부와 갈린 질문만으로 목표를 넘었다 — 규칙대로 둘 다 전부 넣었다)`);

  out();
  for (const [i, q] of picked.entries()) {
    const r = ROUTERS.map((k) => `${k}=${q.routers[k] === undefined ? '-' : (q.routers[k] ?? '실패')}`).join(' ');
    out(`${String(i + 1).padStart(3)}. [${q.selectedAs}] ${q.stage} · ${q.input.askerRole} · ${r}`);
    out(`     ${q.input.questions.map((x) => x.question).join(' / ').slice(0, 200)}`);
  }

  const file = args.out || path.join(DATA_DIR, `experiment-questions-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  // 오프라인 평가(scripts/eval-question-router.ts)가 그대로 읽는 v2 형식(items) — 정답 라벨(accept)은 사람이 붙인다.
  printMetricCoverage(picked);
  await writeFile(file, `${JSON.stringify({ version: 2, items: picked }, null, 2)}\n`);
  out();
  out(`저장: ${file}`);
}

// 라우터마다 판정 시간·비용이 실린 질문 수와 평균 — 빈 값은 지어내지 않으므로 몇 개가 비었는지 먼저 보인다.
function printMetricCoverage(picked: Picked[]): void {
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  out();
  out(`판정 시간·비용이 있는 질문(전체 ${picked.length}개):`);
  for (const k of ROUTERS) {
    const ms = picked.map((q) => q.routerMetrics[k]?.modelLatencyMs).filter((v): v is number => typeof v === 'number');
    const cost = picked.map((q) => q.routerMetrics[k]?.costUsd).filter((v): v is number => typeof v === 'number');
    out(
      `  ${k.padEnd(6)} 판정 시간 ${ms.length}개(평균 ${ms.length === 0 ? '-' : `${Math.round(mean(ms))}ms`})` +
        ` · 비용 ${cost.length}개(평균 ${cost.length === 0 ? '-' : `$${mean(cost).toFixed(5)}`})`,
    );
  }
}

// --only <파일>: 이미 고른 묶음(손으로 다듬은 것 포함)의 질문만 같은 순서로 다시 뽑는다 — 고르는 규칙을 다시 돌리지 않고
// 서버의 최신 값(판정·판정 시간·비용)만 새로 붙인다. 고른 이유(selectedAs)는 그 파일 것을 유지한다.
async function writeOnlyMode(args: ReturnType<typeof parseArgs>, onlyFile: string, all: Picked[]): Promise<void> {
  const prev = JSON.parse(await readFile(onlyFile, 'utf8')) as { items: { id: string; selectedAs: Picked['selectedAs'] }[] };
  const byId = new Map(all.map((q) => [q.id, q]));
  const missing = prev.items.filter((x) => !byId.has(x.id)).map((x) => x.id);
  if (missing.length > 0) out(`  (서버에서 찾지 못한 질문 ${missing.length}개 — 빠진다: ${missing.join(', ')})`);
  const picked = prev.items.flatMap((x) => {
    const q = byId.get(x.id);
    return q ? [{ ...q, selectedAs: x.selectedAs }] : [];
  });
  out();
  out(`${onlyFile}의 질문 ${prev.items.length}개 중 ${picked.length}개를 다시 뽑았다`);
  const file = args.out || path.join(DATA_DIR, `experiment-questions-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  printMetricCoverage(picked);
  await writeFile(file, `${JSON.stringify({ version: 2, items: picked }, null, 2)}\n`);
  out();
  out(`저장: ${file}`);
}

function questionKey(q: Picked): string {
  return q.input.questions.map((x) => x.question.replace(/\s+/g, ' ').trim().toLowerCase()).join(' / ');
}

// 같은 질문 = 같은 태스크(감독이 붙인 회차 꼬리표 `[exp <run> r<n>]`를 뗀 제목)에서 나온 구현 질문. 회차를 되풀이하면 같은 태스크가
// 같은 것을 문장만 바꿔 다시 묻는다(실험1104의 F-02 '완료 필드' 질문이 r1·r3·r14·r21·r24에 나왔다) — 문장 일치로는 걸러지지 않아 태스크로 묶는다.
// 가장 먼저 나온 것을 남긴다. 태스크가 없으면 문장으로 본다.
function dedupKey(q: Picked): string {
  const title = q.input.task?.title.replace(/\s*\[exp [^\]]*\]\s*$/, '').trim();
  return title ? `task:${q.project.id}:${title}` : `q:${questionKey(q)}`;
}

async function writeFullMode(args: ReturnType<typeof parseArgs>, all: Picked[]): Promise<void> {
  const isFull = (q: Picked) => args.full.some((w) => q.project.id.startsWith(w));
  const picked: Picked[] = all.filter(isFull).map((q) => ({ ...q, selectedAs: 'full' as const }));
  const rest = all.filter((q) => !isFull(q));
  const seen = new Set<string>();
  let duplicates = 0;
  for (const q of rest.filter((x) => x.stage === 'implementation')) {
    const key = dedupKey(q);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    picked.push({ ...q, selectedAs: 'implementation' });
  }
  for (const q of rest.filter((x) => x.stage !== 'implementation' && x.agreement === 'disagree')) picked.push({ ...q, selectedAs: 'planning_disagree' });

  out();
  const count = (f: (q: Picked) => boolean) => picked.filter(f).length;
  out(`뽑은 질문 ${picked.length}개 — 전부 넣은 프로젝트 ${count((q) => q.selectedAs === 'full')} · 나머지: 구현 ${count((q) => q.selectedAs === 'implementation')}(같은 태스크 ${duplicates}개 뺌) · 기획 갈림 ${count((q) => q.selectedAs === 'planning_disagree')}`);
  out();
  for (const [i, q] of picked.entries()) {
    const r = ROUTERS.map((k) => `${k}=${q.routers[k] === undefined ? '-' : (q.routers[k] ?? '실패')}`).join(' ');
    out(`${String(i + 1).padStart(3)}. [${q.selectedAs}] ${q.project.name} · ${q.stage} · ${q.input.askerRole} · ${r}`);
    out(`     ${q.input.task ? `(${q.input.task.title}) ` : ''}${questionKey(q).slice(0, 200)}`);
  }
  const file = args.out || path.join(DATA_DIR, `experiment-questions-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  printMetricCoverage(picked);
  await writeFile(file, `${JSON.stringify({ version: 2, items: picked }, null, 2)}\n`);
  out();
  out(`저장: ${file}`);
}

main().catch((err: unknown) => {
  process.stderr.write(`실패: ${(err as Error).message}\n`);
  process.exit(1);
});
