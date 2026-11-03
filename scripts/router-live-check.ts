// 질문 라우터 실기 점검 — 실제 API(OpenAI·Jev·Claude)로 라우팅하고, 실험에 필요한 값이 DB에 남는지 확인한다.
//
//   npm run router:live            # .env의 QUESTION_ROUTER(실제로 보냄) + QUESTION_SHADOW_ROUTERS(함께 돌려 기록)로
//   npm run router:live -- --only 2  # 질문 2개만(비용을 줄여 연결만 볼 때)
//
// 서버를 띄우지 않고 서버와 **같은 함수**를 부른다: 에이전트가 태스크를 잡고(claimTask) AskUserQuestion을 올리는 것(askQuestion)과 같다 —
// 라우팅·질문 저장·QUESTION_ASKED 이벤트·평가 기록(question_routing_runs)이 운영과 같은 코드로 남는다.
// 실행할 때마다 **새 조직**을 서비스 함수로 만든다(기존 로컬 데이터를 건드리지 않는다). 명세·태스크도 대표 API와 같은 작성 경로를 탄다.
// 실제 API를 부르므로 비용이 든다(질문 7개 × 라우터 수). 키는 .env에서 서버와 같은 방식으로 읽고 출력하지 않는다.
// 운영으로 표시된 DB에서는 돌지 않는다.
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { signup } from '../src/domain/auth/service.js';
import { createSpec, createTask } from '../src/domain/authoring/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { askQuestion } from '../src/domain/question/service.js';
import { drainRoutingRecords } from '../src/domain/question/routing-eval.js';
import { routerByName } from '../src/domain/question/router-registry.js';
import { connectRepos, updatePathOwnership } from '../src/domain/repo/service.js';
import type { TeamRole } from '../src/domain/roles.js';
import { claimTask, type AgentContext } from '../src/domain/task/service.js';
import { agentContextFrom, resolveAgentToken } from '../src/middleware/agent-auth.js';
import { readEnvironmentMarker } from './lib/remote-db-guard.js';

const PASSWORD = 'router-live-1234';

// 기대 담당은 이 스크립트를 쓴 사람의 판단이다(정답 라벨이 아니다 — 정답은 대표가 gold로 붙인다). 실기 점검에서 "대체로 맞게 가는가"만 본다.
type Probe = { asker: TeamRole; expect: 'FRONTEND' | 'BACKEND' | 'PM' | 'SELF'; question: string; options: string[] };
const PROBES: Probe[] = [
  { asker: 'FRONTEND', expect: 'BACKEND', question: '스터디 목록 API 응답 본문은 어떤 형태인가요?', options: ['{ studies, nextCursor }', '스터디 배열'] },
  { asker: 'FRONTEND', expect: 'BACKEND', question: '스터디 목록 API는 한 번에 몇 개를 돌려주나요?', options: ['10개', '20개', '50개'] },
  { asker: 'FRONTEND', expect: 'PM', question: '로그인하지 않은 사용자도 스터디 목록을 볼 수 있어야 하나요?', options: ['볼 수 있다', '로그인해야 한다'] },
  { asker: 'FRONTEND', expect: 'SELF', question: '목록을 불러오는 동안 스켈레톤을 보여 줄까요, 스피너를 보여 줄까요?', options: ['스켈레톤', '스피너'] },
  { asker: 'BACKEND', expect: 'SELF', question: '정원이 찬 스터디에 신청하면 409 응답의 에러 코드 이름을 무엇으로 할까요?', options: ['STUDY_FULL', 'CAPACITY_EXCEEDED'] },
  { asker: 'BACKEND', expect: 'FRONTEND', question: '신청 직후 화면은 상세에 머무르나요, 목록으로 돌아가나요? 응답에 상세 데이터를 함께 줄지 정하려고 합니다.', options: ['상세에 머무른다', '목록으로 돌아간다'] },
  { asker: 'BACKEND', expect: 'PM', question: '한 사용자가 동시에 신청할 수 있는 스터디 수에 제한이 있나요?', options: ['제한 없음', '3개까지', '5개까지'] },
];

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

async function pathId(repoId: string, pattern: string): Promise<string> {
  const { rows } = await pool.query(`SELECT id FROM repo_paths WHERE repo_id = $1 AND path_pattern = $2`, [repoId, pattern]);
  return rows[0]!.id as string;
}

// 새 조직 · FE/BE 팀원과 에이전트 · 레포 2개(소유권 지정) · 명세 2개 · 태스크 2개 · 시작한 프로젝트. 전부 서비스 함수로.
async function setUp(): Promise<{ projectId: string; ctx: Record<TeamRole, AgentContext>; taskOf: Record<TeamRole, string> }> {
  const tag = `rt${Date.now().toString(36)}`;
  const rep = await signup({ loginId: `${tag}-rep`, password: PASSWORD, nickname: '라우터점검 대표' });
  const fe = await signup({ loginId: `${tag}-fe`, password: PASSWORD, nickname: '라우터점검 FE' });
  const be = await signup({ loginId: `${tag}-be`, password: PASSWORD, nickname: '라우터점검 BE' });
  const { orgId } = await createOrganization(rep.userId, `라우터 점검 ${tag}`);
  await acceptInvite((await createInvite(orgId, rep.userId, { teamRole: 'FRONTEND' })).token, fe.userId);
  await acceptInvite((await createInvite(orgId, rep.userId, { teamRole: 'BACKEND' })).token, be.userId);

  const repos = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: `${tag}/study-api` }, { fullName: `${tag}/study-web` }] });
  const api = repos.find((r) => r.fullName.endsWith('/study-api'))!;
  const web = repos.find((r) => r.fullName.endsWith('/study-web'))!;
  await updatePathOwnership(orgId, rep.userId, api.id, await pathId(api.id, '**'), { ownerRole: 'BACKEND' });
  await updatePathOwnership(orgId, rep.userId, web.id, await pathId(web.id, '**'), { ownerRole: 'FRONTEND' });

  const harness = { harness: 'router-live-check', skills: [], maxConcurrent: 1 };
  const feAgent = await connectAgent({ connectKey: fe.connectKey, agentName: `${tag}-fe`, ...harness });
  const beAgent = await connectAgent({ connectKey: be.connectKey, agentName: `${tag}-be`, ...harness });

  const { project } = await createProject(orgId, rep.userId, { name: '라우터 점검 — 스터디 관리', autonomyPreset: 'L2', pmBudgetUsd: 1, repoIds: [api.id, web.id] });
  const actor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' };
  await assignMember(actor, project.id, beAgent.agentId, 'BACKEND');
  await assignMember(actor, project.id, feAgent.agentId, 'FRONTEND');

  const listSpec = await createSpec(rep.userId, project.id, {
    featureKey: 'F-01', title: '스터디 목록 화면', content: 'WHEN 사용자가 목록을 열면 THEN 모집 중인 스터디를 최신순으로 보여 준다.', tests: [], needsApi: false, apiNeeds: null,
  });
  const applySpec = await createSpec(rep.userId, project.id, {
    featureKey: 'F-03', title: '스터디 참여 신청', content: 'WHEN 사용자가 신청하면 THEN 참여자로 등록한다. WHEN 정원이 찼으면 THEN 409를 돌려준다.', tests: [], needsApi: false, apiNeeds: null,
  });
  const feTask = await createTask(rep.userId, project.id, { title: 'T-01 스터디 목록 화면', teamRole: 'FRONTEND', kind: 'IMPLEMENT', repoId: web.id, specId: listSpec.id, dependsOn: [] });
  const beTask = await createTask(rep.userId, project.id, { title: 'T-02 참여 신청 API', teamRole: 'BACKEND', kind: 'IMPLEMENT', repoId: api.id, specId: applySpec.id, dependsOn: [] });
  await startProject(actor, project.id);

  // 배정 뒤 재발급한 토큰에 프로젝트가 실린다 — CLI가 하는 것과 같다. 컨텍스트는 HTTP 인증과 같은 함수로 만든다.
  const contextOf = async (refreshToken: string) => agentContextFrom(await resolveAgentToken((await refreshAgentToken(refreshToken)).accessToken));
  const ctx = { FRONTEND: await contextOf(feAgent.refreshToken), BACKEND: await contextOf(beAgent.refreshToken) };
  await claimTask(ctx.FRONTEND, feTask.id);
  await claimTask(ctx.BACKEND, beTask.id);
  out(`조직 ${tag} · 프로젝트 ${project.id}`);
  return { projectId: project.id, ctx, taskOf: { FRONTEND: feTask.id, BACKEND: beTask.id } };
}

type RunRow = { router: string; mode: string; target: string | null; confidence: number | null; latency_ms: number; model_latency_ms: number | null; cost_usd: string | null; error: string | null };

async function main(): Promise<void> {
  if ((await readEnvironmentMarker(pool)) === 'production') throw new Error('운영으로 표시된 DB다 — 로컬 DB에서만 돈다');
  const argv = process.argv.slice(2);
  const onlyAt = argv.indexOf('--only');
  const probes = onlyAt >= 0 ? PROBES.slice(0, Number(argv[onlyAt + 1]) || PROBES.length) : PROBES;

  const shadows = env.QUESTION_SHADOW_ROUTERS.split(',').map((n) => n.trim()).filter(Boolean);
  out(`DB ${new URL(env.DATABASE_URL).host}${new URL(env.DATABASE_URL).pathname}`);
  out(`실제 라우터 ${env.QUESTION_ROUTER} · 그림자 ${shadows.join(', ') || '(없음)'} · OpenAI 모델 ${env.OPENAI_ROUTER_MODEL} · Jev 모델 ${env.JEV_MODEL}`);
  const unavailable = shadows.filter((n) => routerByName(n) === null);
  if (unavailable.length > 0) out(`⚠ 키·주소가 없어 빠지는 그림자 라우터: ${unavailable.join(', ')}`);
  out();

  const { projectId, ctx, taskOf } = await setUp();
  const problems: string[] = [];
  let hits = 0;
  const perRouter = new Map<string, { n: number; ok: number; err: number; latency: number[]; model: number[]; cost: number; costKnown: number }>();

  for (const [i, probe] of probes.entries()) {
    const asked = await askQuestion(ctx[probe.asker], taskOf[probe.asker], [{ question: probe.question, options: probe.options.map((label) => ({ label })) }]);
    await drainRoutingRecords();

    const q = (await pool.query(`SELECT routed_by, target_role, status, routing, routing_input FROM agent_questions WHERE id = $1`, [asked.id])).rows[0] as {
      routed_by: string; target_role: string; status: string; routing: Record<string, unknown> | null; routing_input: unknown;
    };
    const ev = (await pool.query(`SELECT payload FROM events WHERE type = 'QUESTION_ASKED' AND payload->>'questionId' = $1`, [asked.id])).rows[0] as { payload: Record<string, unknown> } | undefined;
    const runs = (await pool.query(`SELECT router, mode, target, confidence, latency_ms, model_latency_ms, cost_usd, error FROM question_routing_runs WHERE question_id = $1 ORDER BY mode, id`, [asked.id])).rows as RunRow[];

    const primaryTarget = q.status === 'self_owned' ? 'SELF' : q.target_role;
    if (primaryTarget === probe.expect) hits += 1;
    out(`${i + 1}. [${probe.asker} → 예상 ${probe.expect}] ${probe.question}`);
    for (const r of runs) {
      const shown = r.error ? `실패: ${r.error}` : `${r.target}${r.target === probe.expect ? ' ✓' : ' ✗'} 확신 ${r.confidence?.toFixed(2) ?? '-'}`;
      out(`   ${r.mode.padEnd(7)} ${r.router.padEnd(32)} ${shown.padEnd(24)} 판정 ${String(r.model_latency_ms ?? '-').padStart(6)}ms 전체 ${String(r.latency_ms).padStart(6)}ms  $${r.cost_usd ?? '-'}`);
      const s = perRouter.get(r.router) ?? { n: 0, ok: 0, err: 0, latency: [], model: [], cost: 0, costKnown: 0 };
      s.n += 1;
      if (r.error) s.err += 1;
      else {
        if (r.target === probe.expect) s.ok += 1;
        s.latency.push(r.latency_ms);
        if (r.model_latency_ms !== null) s.model.push(r.model_latency_ms);
      }
      if (r.cost_usd !== null) {
        s.cost += Number(r.cost_usd);
        s.costKnown += 1;
      }
      perRouter.set(r.router, s);
    }
    if (typeof q.routing?.reason === 'string') out(`   이유(실제 라우터): ${q.routing.reason}`);

    // 실험에 필요한 값이 남았는가 — 질문 행·이벤트·평가 기록.
    const need = (cond: boolean, what: string) => { if (!cond) problems.push(`${i + 1}번: ${what}`); };
    need(q.routing_input !== null, 'agent_questions.routing_input이 비었다(오프라인 재평가 입력)');
    need(typeof q.routing?.latencyMs === 'number', 'agent_questions.routing.latencyMs가 없다');
    need(q.routing !== null && 'costUsd' in q.routing, 'agent_questions.routing.costUsd 칸이 없다');
    need(q.routing !== null && 'modelLatencyMs' in q.routing, 'agent_questions.routing.modelLatencyMs 칸이 없다');
    // API 라우터(openai·jev)는 서버가 판정 시간을 잰다 — 비어 있으면 기록 경로가 끊긴 것이다. 중계 llm은 CLI 0.1.19부터라 보지 않는다.
    for (const r of runs.filter((x) => !x.error && /^(openai|jev):/.test(x.router))) need(r.model_latency_ms !== null, `${r.router}의 판정 시간(model_latency_ms)이 비었다`);
    need(ev !== undefined && typeof ev.payload.latencyMs === 'number' && 'costUsd' in ev.payload && 'modelLatencyMs' in ev.payload, 'QUESTION_ASKED 이벤트에 latencyMs·costUsd·modelLatencyMs가 없다');
    need(runs.some((r) => r.mode === 'primary'), 'question_routing_runs에 primary 기록이 없다');
    for (const name of shadows.filter((n) => routerByName(n) !== null && routerByName(n)!.name !== q.routed_by)) {
      need(runs.some((r) => r.mode === 'shadow' && r.router === routerByName(name)!.name), `그림자 ${name}의 기록이 없다`);
    }
    // 대표에게 넘긴 기록(fallback:representative)은 판정한 라우터가 없어 지연을 0으로 남긴다(recordRouting) — 지연은 실패한 라우터 행에 있다.
    for (const r of runs.filter((x) => !x.error && !x.router.startsWith('fallback:'))) need(r.latency_ms > 0, `${r.router}의 지연이 0ms다`);
  }

  out();
  out('라우터별 요약 (예상 담당과 일치 · 실패 · 판정 시간 중앙값 · 전체 지연 중앙값 · 비용 합)');
  for (const [router, s] of perRouter) {
    const sorted = [...s.latency].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    const models = [...s.model].sort((a, b) => a - b);
    const modelMedian = models.length ? models[Math.floor(models.length / 2)] : null;
    out(`  ${router.padEnd(34)} 일치 ${s.ok}/${s.n - s.err}  실패 ${s.err}  판정 ${modelMedian ?? '-'}ms  전체 ${median ?? '-'}ms  비용 $${s.cost.toFixed(6)}${s.costKnown < s.n ? ` (비용 모름 ${s.n - s.costKnown}건)` : ''}`);
  }
  out(`실제 라우터가 예상대로 보낸 질문: ${hits}/${probes.length}`);
  out(`보고서: GET /api/projects/${projectId}/routing-report · 데이터셋: GET /api/projects/${projectId}/routing-dataset (대표 로그인 후)`);
  out();
  if (problems.length > 0) {
    out(`✗ 저장 확인 실패 ${problems.length}건:`);
    for (const p of problems) out(`  - ${p}`);
    process.exitCode = 1;
  } else {
    out('✓ 저장 확인: 질문마다 routing_input·routing(지연·판정 시간·비용)·QUESTION_ASKED 이벤트·primary/그림자 평가 기록(판정 시간 포함)이 남았다');
  }
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  // PM 답 초안 대기(중계) 같은 타이머가 프로세스를 붙잡지 않게 끝낸다.
  .finally(() => pool.end().finally(() => process.exit()));
