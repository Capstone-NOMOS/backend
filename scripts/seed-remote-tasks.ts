// 기존 프로젝트에 명세·시험지·태스크만 들여온다. TRUNCATE 없음. 운영 DB에 쓰는 것이 목적이다.
//
//   npm run seed:tasks -- <projectId> <파일.json> --as <대표 loginId>            # 계획만 보여준다 (dry-run)
//   npm run seed:tasks -- <projectId> <파일.json> --as <대표 loginId> --apply    # 실제로 쓴다
//
// 파일 형식은 scripts/examples/tasks.example.json. 안전장치는 scripts/lib/import-tasks.ts 머리 주석.
//
// 서버의 env.ts를 거치지 않는다 — 행을 넣는 데 JWT_SECRET·COMMIT_INSPECTOR 같은 서버 설정은 필요 없고,
// 그걸 요구하면 운영 DB에 붙을 때 가짜 값을 채워 넣게 된다. DATABASE_URL만 읽는다.
// 운영 DB는 SSM 포트 포워딩으로 붙는다(docs/deploy-aws.md 18.4). 그때 호스트는 localhost라 sslmode=require.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describeDatabaseTarget, readEnvironmentMarker } from './lib/remote-db-guard.js';
import { applyImport, ImportRefused, planImport, type ImportPlan } from './lib/import-tasks.js';

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function usage(): never {
  process.stderr.write(
    '사용법: npm run seed:tasks -- <projectId> <파일.json> --as <대표 loginId> [--apply]\n' +
      '  --apply 없이는 무엇을 넣을지만 보여주고 아무것도 쓰지 않는다.\n',
  );
  process.exit(2);
}

function parseArgs(argv: string[]): { projectId: string; file: string; asLoginId: string; apply: boolean } {
  const positional: string[] = [];
  let asLoginId: string | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--apply') apply = true;
    else if (arg === '--as') asLoginId = argv[(i += 1)];
    else positional.push(arg);
  }
  const [projectId, file] = positional;
  if (!projectId || !file || !asLoginId) usage();
  return { projectId, file, asLoginId, apply };
}

function printPlan(plan: ImportPlan): void {
  out(`명세 ${plan.specs.length}개 · 시험지 ${plan.specs.reduce((n, s) => n + s.tests.length, 0)}개 · 태스크 ${plan.tasks.length}개`);
  for (const spec of plan.specs) {
    const locked = spec.tests.filter((t) => t.locked).length;
    out(`  [명세] ${spec.featureKey} ${spec.title} (시험지 ${spec.tests.length}, 잠금 ${locked})`);
  }
  for (const task of plan.tasks) {
    const spec = task.spec === null ? '-' : 'newKey' in task.spec ? task.spec.newKey : `기존 ${task.spec.existingId}`;
    const deps = task.dependsOn.map((d) => ('ref' in d ? d.ref : `기존 ${d.existingId}`)).join(', ') || '-';
    out(`  [태스크] ${task.ref} ${task.title} | ${task.repo} | ${task.teamRole ?? '역할 무관'} | ${task.kind} | 명세 ${spec} | 선행 ${deps}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
    try {
      process.loadEnvFile();
    } catch {
      // .env가 없어도 된다.
    }
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL이 필요하다');

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    // 막지는 않는다 — 운영에 쓰는 게 목적이다. 대신 어디에 쓰는지 첫 줄에 분명히 보여준다.
    const target = describeDatabaseTarget(databaseUrl);
    const marker = await readEnvironmentMarker(client);
    out(`대상 DB: ${target.host}${marker === 'production' ? '  ⚠️ 운영 DB' : ''}`);

    const doc = JSON.parse(readFileSync(args.file, 'utf8')) as unknown;
    const plan = await planImport(client, { projectId: args.projectId, asLoginId: args.asLoginId, doc });
    printPlan(plan);

    if (!args.apply) {
      out();
      out('dry-run — 아무것도 쓰지 않았다. 넣으려면 --apply를 붙여 다시 실행하라.');
      return;
    }
    const result = await applyImport(client, plan);
    out();
    out(`✓ 넣었다 — 명세 ${result.specIds.length}, 시험지 ${result.specTestCount}, 태스크 ${result.taskIds.length}, 선행 관계 ${result.dependencyCount}`);
    out(`  이벤트 TASKS_IMPORTED (대표 ${args.asLoginId} 명의)`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(err instanceof ImportRefused ? `${err.message}\n아무것도 쓰지 않았다.\n` : `실패: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
