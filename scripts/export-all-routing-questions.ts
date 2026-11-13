// NOMOS 전체(모든 조직·프로젝트)의 질문을 라우터 판정·판정 시간·비용과 함께 한 파일로 내보낸다 — 통합 라벨링·일치율 화면의 데이터.
//
//   EXPORT_DATABASE_URL=postgres://...@localhost:15432/nomos npm run questions:export-all
//   [--out <파일>](기본 scripts/data/all-routing-questions-<시각>.json)
//
// 운영 DB를 SSM 포트 포워딩으로 **읽기만** 한다 — 조직을 가로지르는 조회라 API에 두지 않는다(대표 결정 2026-11-13: 운영자 API를 만들지 않는다).
// 안전장치(문서 경고가 아니라 구조로):
//   - 접속 문자열은 EXPORT_DATABASE_URL로만 받는다. .env의 DATABASE_URL(로컬 개발 DB)을 읽지 않아 어느 DB를 보는지 헷갈릴 여지가 없다.
//   - 세션을 default_transaction_read_only로 열고 READ ONLY 트랜잭션 안에서 SELECT만 한다 — 실수로 쓰는 문장이 들어가도 DB가 거부한다.
//   - 접속 대상(호스트:포트/DB)만 찍고 비밀번호는 찍지 않는다.
// 비교 값은 판정 시간(model_latency_ms)·비용만 싣는다 — 실제로 걸린 시간(latency_ms)은 중계 대기열·CLI 기동이 섞여 부풀린다(035).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const ROUTERS = ['llm', 'openai', 'jev'] as const;
type RouterKey = (typeof ROUTERS)[number];
type Metric = { modelLatencyMs: number | null; costUsd: number | null };

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function routerKeyOf(name: string): RouterKey | null {
  const head = name.split(':')[0] ?? '';
  return (ROUTERS as readonly string[]).includes(head) ? (head as RouterKey) : null;
}

// 갈림 = 판정을 낸 라우터끼리 다르다. 일치 = 세 라우터가 모두 판정을 냈고 같다. 그 밖은 비교 불가(extract-experiment-questions.ts와 같은 정의).
function agreementOf(routers: Partial<Record<RouterKey, string | null>>): 'disagree' | 'agree' | 'incomparable' {
  const decided = ROUTERS.map((k) => routers[k]).filter((t): t is string => typeof t === 'string');
  if (decided.length >= 2 && new Set(decided).size > 1) return 'disagree';
  return decided.length === ROUTERS.length ? 'agree' : 'incomparable';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let outFile = '';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out' && args[i + 1]) outFile = args[++i]!;
    else {
      process.stderr.write(`모르는 인자: ${args[i]}\n사용법: EXPORT_DATABASE_URL=... npm run questions:export-all [-- --out 파일]\n`);
      process.exit(2);
    }
  }
  const url = process.env.EXPORT_DATABASE_URL;
  if (!url) {
    process.stderr.write('EXPORT_DATABASE_URL이 없다 — 운영 DB 포트 포워딩 주소를 이 변수로 준다(.env의 DATABASE_URL은 읽지 않는다)\n');
    process.exit(2);
  }
  const target = new URL(url);
  out(`접속 대상: ${target.hostname}:${target.port || '5432'}${target.pathname} (읽기 전용)`);

  const client = new pg.Client({ connectionString: url, options: '-c default_transaction_read_only=on' });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(
      `SELECT q.id, q.stage, q.asker_role, q.target_role, q.routed_by, q.status, q.questions, q.routing_input,
              q.answer_source, q.gold_target, q.created_at,
              p.id AS project_id, p.name AS project_name, p.question_mode, p.deleted_at IS NOT NULL AS project_deleted,
              o.id AS org_id, o.name AS org_name,
              coalesce(json_agg(json_build_object(
                'router', r.router, 'mode', r.mode, 'target', r.target,
                'modelLatencyMs', r.model_latency_ms, 'costUsd', r.cost_usd, 'error', r.error) ORDER BY r.id)
                FILTER (WHERE r.id IS NOT NULL), '[]') AS runs
         FROM agent_questions q
         JOIN projects p ON p.id = q.project_id
         JOIN organizations o ON o.id = p.org_id
         LEFT JOIN question_routing_runs r ON r.question_id = q.id
        GROUP BY q.id, p.id, o.id
        ORDER BY q.created_at`,
    );
    await client.query('COMMIT');

    type Run = { router: string; mode: string; target: string | null; modelLatencyMs: number | null; costUsd: string | number | null; error: string | null };
    const items = rows.map((r) => {
      const routers: Partial<Record<RouterKey, string | null>> = {};
      const routerMetrics: Partial<Record<RouterKey, Metric>> = {};
      for (const run of r.runs as Run[]) {
        const key = routerKeyOf(run.router);
        if (!key) continue;
        // 같은 라우터가 둘이면(primary 실패 뒤 대체 등) 판정을 낸 쪽을 쓴다.
        if (routers[key] == null) {
          routers[key] = run.target;
          routerMetrics[key] = { modelLatencyMs: run.modelLatencyMs, costUsd: run.costUsd === null ? null : Number(run.costUsd) };
        }
      }
      return {
        id: r.id as string,
        stage: r.stage as string,
        askerRole: r.asker_role as string,
        askedAt: (r.created_at as Date).toISOString(),
        org: { id: r.org_id as string, name: r.org_name as string },
        project: { id: r.project_id as string, name: r.project_name as string, questionMode: r.question_mode as string, deleted: r.project_deleted as boolean },
        // 라우터가 본 입력(032 이전 질문은 null — 오프라인 평가에서는 빠진다).
        input: (r.routing_input as unknown) ?? null,
        questions: r.questions as unknown,
        primary: { router: r.routed_by as string, target: r.target_role as string },
        status: r.status as string,
        answerSource: (r.answer_source as string | null) ?? null,
        goldTarget: (r.gold_target as string | null) ?? null,
        routers,
        routerMetrics,
        agreement: agreementOf(routers),
      };
    });

    const count = (f: (q: (typeof items)[number]) => boolean) => items.filter(f).length;
    out(`질문 ${items.length}개 — 조직 ${new Set(items.map((q) => q.org.id)).size}곳 · 프로젝트 ${new Set(items.map((q) => q.project.id)).size}개`);
    out(`  단계: 구현 ${count((q) => q.stage === 'implementation')} · 기능 명세 ${count((q) => q.stage === 'feature_spec')} · 계약 ${count((q) => q.stage === 'contract')}`);
    out(`  세 라우터: 갈림 ${count((q) => q.agreement === 'disagree')} · 일치 ${count((q) => q.agreement === 'agree')} · 비교 불가 ${count((q) => q.agreement === 'incomparable')}`);
    for (const k of ROUTERS) {
      out(`  ${k.padEnd(6)} 판정 ${count((q) => typeof q.routers[k] === 'string')} · 판정 시간 ${count((q) => typeof q.routerMetrics[k]?.modelLatencyMs === 'number')} · 비용 ${count((q) => typeof q.routerMetrics[k]?.costUsd === 'number')}`);
    }

    const file = outFile || path.join(DATA_DIR, `all-routing-questions-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ exportedAt: new Date().toISOString(), items }, null, 2)}\n`);
    out(`저장: ${file}`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`실패: ${(err as Error).message}\n`);
  process.exit(1);
});
