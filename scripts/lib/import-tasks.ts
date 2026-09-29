import type { PoolClient } from 'pg';
import { z } from 'zod';
import { appendEvent } from '../../src/domain/events/append.js';
import { TEAM_ROLES } from '../../src/domain/roles.js';

// 기존 프로젝트에 명세·시험지·태스크를 들여온다. 명세·태스크 생성 API가 생기기 전까지의 유일한 경로다.
//
// 안전은 DB의 운영 표시(nomos.environment)에 기대지 않는다 — 이 도구는 원래 운영 DB에 쓰려고 있는 것이다.
// 대신 구조로 막는다:
//   1. INSERT만 한다. 이 파일에 DELETE·UPDATE·TRUNCATE는 없다(tests/seed-remote-tasks.test.ts가 소스를 검사한다).
//   2. 전부 한 트랜잭션이다. 검증을 하나라도 못 넘으면 아무것도 쓰지 않는다.
//   3. 검증을 먼저 전부 돈다. 틀린 곳을 **모두** 모아서 알려준다(하나 고치고 다시 돌리게 하지 않는다).
//   4. 같은 파일을 두 번 돌리면 중복(같은 feature_key·같은 태스크 제목)으로 거부한다 — 재실행이 데이터를 불리지 않는다.
//   5. 프로젝트가 있어야 하고, --as가 그 조직의 대표여야 한다. 엉뚱한 DB를 가리키면 여기서 멈춘다.
//   6. 기본은 dry-run이다(호출부가 --apply 없이는 applyImport를 부르지 않는다).

const LIMITS = { specs: 50, tasks: 200, testsPerSpec: 30 } as const;
const TASK_KINDS = ['IMPLEMENT', 'INTEGRATION', 'REWORK'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const docSchema = z
  .object({
    specs: z
      .array(
        z
          .object({
            featureKey: z.string().trim().min(1).max(32),
            title: z.string().trim().min(1).max(200),
            content: z.string().trim().min(1).max(20_000),
            tests: z
              .array(
                z
                  .object({
                    criterion: z.string().trim().min(1).max(500),
                    testCode: z.string().min(1).max(50_000),
                    // 잠근 시험지만 V2 근거가 된다(산출물보다 먼저 잠겨 있어야 한다). 기본은 잠그지 않는다.
                    locked: z.boolean().default(false),
                  })
                  .strict(),
              )
              .max(LIMITS.testsPerSpec)
              .default([]),
          })
          .strict(),
      )
      .max(LIMITS.specs)
      .default([]),
    tasks: z
      .array(
        z
          .object({
            // 파일 안에서 태스크를 가리키는 이름. dependsOn이 쓴다. DB에는 저장하지 않는다.
            ref: z.string().trim().min(1).max(64),
            title: z.string().trim().min(1).max(200),
            repo: z.string().trim().min(1), // repos.full_name
            teamRole: z.enum(TEAM_ROLES).nullable().default(null), // NULL = 역할 제한 없음(통합 태스크)
            kind: z.enum(TASK_KINDS).default('IMPLEMENT'),
            spec: z.string().trim().min(1).optional(), // 이 파일의 featureKey 또는 프로젝트에 이미 있는 featureKey
            dependsOn: z.array(z.string().trim().min(1)).default([]), // 이 파일의 ref 또는 이미 있는 태스크 id
          })
          .strict(),
      )
      .max(LIMITS.tasks)
      .default([]),
  })
  .strict();

export type ImportDoc = z.input<typeof docSchema>;

export class ImportRefused extends Error {
  constructor(readonly problems: string[]) {
    super(`들여오기를 거부했다 (${problems.length}건):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ImportRefused';
  }
}

export type ImportPlan = {
  projectId: string;
  orgId: string;
  actorUserId: string;
  policyHash: string;
  specs: { featureKey: string; title: string; content: string; tests: { criterion: string; testCode: string; locked: boolean }[] }[];
  tasks: {
    ref: string;
    title: string;
    repoId: string;
    repo: string;
    teamRole: (typeof TEAM_ROLES)[number] | null;
    kind: (typeof TASK_KINDS)[number];
    // 이 파일의 명세면 featureKey, 이미 있는 명세면 그 id
    spec: { newKey: string } | { existingId: string } | null;
    dependsOn: ({ ref: string } | { existingId: string })[];
  }[];
};

type Reader = Pick<PoolClient, 'query'>;

export async function planImport(
  db: Reader,
  input: { projectId: string; asLoginId: string; doc: unknown },
): Promise<ImportPlan> {
  const parsed = docSchema.safeParse(input.doc);
  if (!parsed.success) {
    throw new ImportRefused(parsed.error.issues.map((i) => `${i.path.join('.') || '(파일)'}: ${i.message}`));
  }
  const doc = parsed.data;
  const problems: string[] = [];

  if (!UUID.test(input.projectId)) throw new ImportRefused([`프로젝트 id 형식이 아니다: ${input.projectId}`]);
  const project = (
    await db.query(`SELECT id, org_id, policy_hash FROM projects WHERE id = $1`, [input.projectId])
  ).rows[0] as { id: string; org_id: string; policy_hash: string } | undefined;
  if (!project) {
    throw new ImportRefused([`프로젝트 ${input.projectId}가 없다 — DATABASE_URL이 맞는 DB를 가리키는지 확인하라`]);
  }

  // 모든 행동은 사람에게 귀속된다. 그 조직의 대표만 들여올 수 있다.
  const actor = (
    await db.query(`SELECT id, org_id, org_role FROM users WHERE login_id = $1`, [input.asLoginId])
  ).rows[0] as { id: string; org_id: string | null; org_role: string } | undefined;
  if (!actor || actor.org_id !== project.org_id || actor.org_role !== 'REPRESENTATIVE') {
    throw new ImportRefused([`--as ${input.asLoginId}는 이 프로젝트 조직의 대표가 아니다`]);
  }

  const repos = new Map<string, string>(
    (
      await db.query(
        `SELECT r.full_name, r.id FROM project_repos pr JOIN repos r ON r.id = pr.repo_id WHERE pr.project_id = $1`,
        [project.id],
      )
    ).rows.map((r) => [r.full_name as string, r.id as string]),
  );
  const existingSpecs = new Map<string, string>(
    (
      await db.query(`SELECT feature_key, id FROM specs WHERE project_id = $1 AND superseded_by IS NULL`, [project.id])
    ).rows.map((r) => [r.feature_key as string, r.id as string]),
  );
  const existingTitles = new Set<string>(
    (await db.query(`SELECT title FROM tasks WHERE project_id = $1`, [project.id])).rows.map((r) => r.title as string),
  );
  const existingTaskIds = new Set<string>(
    (await db.query(`SELECT id FROM tasks WHERE project_id = $1`, [project.id])).rows.map((r) => r.id as string),
  );

  // ── 명세
  const fileSpecKeys = new Set<string>();
  for (const spec of doc.specs) {
    if (fileSpecKeys.has(spec.featureKey)) problems.push(`명세 ${spec.featureKey}가 파일에 두 번 있다`);
    if (existingSpecs.has(spec.featureKey)) {
      // 조용히 버전을 올리지 않는다. 명세 변경은 기록이 남아야 하는 결정이다.
      problems.push(`명세 ${spec.featureKey}가 프로젝트에 이미 있다 (다시 돌린 건 아닌가?)`);
    }
    fileSpecKeys.add(spec.featureKey);
  }

  // ── 태스크
  const refs = new Set<string>();
  const titles = new Set<string>();
  for (const task of doc.tasks) {
    if (refs.has(task.ref)) problems.push(`태스크 ref ${task.ref}가 파일에 두 번 있다`);
    refs.add(task.ref);
    if (titles.has(task.title)) problems.push(`태스크 제목 "${task.title}"이 파일에 두 번 있다`);
    titles.add(task.title);
    if (existingTitles.has(task.title)) problems.push(`태스크 "${task.title}"이 프로젝트에 이미 있다 (다시 돌린 건 아닌가?)`);
  }

  const tasks: ImportPlan['tasks'] = doc.tasks.map((task) => {
    const repoId = repos.get(task.repo);
    if (!repoId) problems.push(`[${task.ref}] 레포 ${task.repo}는 이 프로젝트에 연결돼 있지 않다 (${[...repos.keys()].join(', ') || '없음'})`);

    let spec: ImportPlan['tasks'][number]['spec'] = null;
    if (task.spec !== undefined) {
      if (fileSpecKeys.has(task.spec)) spec = { newKey: task.spec };
      else if (existingSpecs.has(task.spec)) spec = { existingId: existingSpecs.get(task.spec)! };
      else problems.push(`[${task.ref}] 명세 ${task.spec}가 파일에도 프로젝트에도 없다`);
    }

    const dependsOn: ImportPlan['tasks'][number]['dependsOn'] = [];
    for (const dep of task.dependsOn) {
      if (dep === task.ref) problems.push(`[${task.ref}] 자기 자신에 의존한다`);
      else if (refs.has(dep)) dependsOn.push({ ref: dep });
      else if (existingTaskIds.has(dep)) dependsOn.push({ existingId: dep });
      else problems.push(`[${task.ref}] 의존 대상 ${dep}가 파일의 ref도, 이 프로젝트의 태스크 id도 아니다`);
    }

    return { ref: task.ref, title: task.title, repoId: repoId ?? '', repo: task.repo, teamRole: task.teamRole, kind: task.kind, spec, dependsOn };
  });

  // 파일 안 의존 순환. 순환이 있으면 그 태스크들은 영원히 READY에서 못 잡힌다(선행이 DONE이 아니므로).
  const graph = new Map(tasks.map((t) => [t.ref, t.dependsOn.flatMap((d) => ('ref' in d ? [d.ref] : []))]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (ref: string, trail: string[]): void => {
    if (state.get(ref) === 'done') return;
    if (state.get(ref) === 'visiting') {
      problems.push(`의존 순환: ${[...trail.slice(trail.indexOf(ref)), ref].join(' → ')}`);
      return;
    }
    state.set(ref, 'visiting');
    for (const next of graph.get(ref) ?? []) visit(next, [...trail, ref]);
    state.set(ref, 'done');
  };
  for (const ref of graph.keys()) visit(ref, []);

  if (problems.length > 0) throw new ImportRefused(problems);

  return {
    projectId: project.id,
    orgId: project.org_id,
    actorUserId: actor.id,
    policyHash: project.policy_hash,
    specs: doc.specs,
    tasks,
  };
}

export type ImportResult = { specIds: string[]; taskIds: string[]; specTestCount: number; dependencyCount: number };

// 계획을 한 트랜잭션으로 쓴다. **INSERT만** 한다.
export async function applyImport(client: PoolClient, plan: ImportPlan): Promise<ImportResult> {
  await client.query('BEGIN');
  try {
    const specIds = new Map<string, string>();
    let specTestCount = 0;
    for (const spec of plan.specs) {
      const { rows } = await client.query(
        `INSERT INTO specs (project_id, feature_key, title, content) VALUES ($1, $2, $3, $4) RETURNING id`,
        [plan.projectId, spec.featureKey, spec.title, spec.content],
      );
      const specId = rows[0]!.id as string;
      specIds.set(spec.featureKey, specId);
      for (const test of spec.tests) {
        await client.query(
          `INSERT INTO spec_tests (spec_id, criterion, test_code, locked_at)
           VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN now() END)`,
          [specId, test.criterion, test.testCode, test.locked],
        );
        specTestCount += 1;
      }
    }

    const taskIds = new Map<string, string>();
    for (const task of plan.tasks) {
      const specId = task.spec === null ? null : 'newKey' in task.spec ? specIds.get(task.spec.newKey)! : task.spec.existingId;
      const { rows } = await client.query(
        `INSERT INTO tasks (project_id, repo_id, spec_id, title, kind, team_role, state)
         VALUES ($1, $2, $3, $4, $5, $6, 'READY') RETURNING id`,
        [plan.projectId, task.repoId, specId, task.title, task.kind, task.teamRole],
      );
      taskIds.set(task.ref, rows[0]!.id as string);
    }

    let dependencyCount = 0;
    for (const task of plan.tasks) {
      for (const dep of task.dependsOn) {
        const dependsOn = 'ref' in dep ? taskIds.get(dep.ref)! : dep.existingId;
        await client.query(`INSERT INTO task_deps (task_id, depends_on) VALUES ($1, $2)`, [taskIds.get(task.ref)!, dependsOn]);
        dependencyCount += 1;
      }
    }

    const result: ImportResult = {
      specIds: [...specIds.values()],
      taskIds: [...taskIds.values()],
      specTestCount,
      dependencyCount,
    };
    await appendEvent(client, {
      orgId: plan.orgId,
      projectId: plan.projectId,
      type: 'TASKS_IMPORTED',
      onBehalfOf: plan.actorUserId,
      policyHash: plan.policyHash,
      payload: { source: 'seed-remote-tasks', ...result },
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
