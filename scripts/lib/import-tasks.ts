import type { PoolClient } from 'pg';
import { z } from 'zod';
import { authorInTransaction, type AuthoringInput } from '../../src/domain/authoring/apply.js';
import { AUTHORING_LIMITS, specInputSchema, taskFieldsSchema } from '../../src/domain/authoring/schema.js';
import type { TaskDraft } from '../../src/domain/authoring/validate.js';
import { AppError } from '../../src/errors.js';

// 기존 프로젝트에 명세·시험지·태스크를 파일에서 들여온다(운영 DB용). 이 파일은 **JSON 해석과 --as 확인만** 한다.
// 검증과 쓰기는 API와 같은 한 벌(src/domain/authoring — validate.ts·apply.ts)을 탄다(source='import').
//
// 안전은 DB의 운영 표시(nomos.environment)에 기대지 않는다 — 이 도구는 원래 운영 DB에 쓰려고 있는 것이다.
// 대신 구조로 막는다:
//   1. INSERT만 한다. 이 파일과 domain/authoring 폴더 전체에 DELETE·UPDATE·TRUNCATE가 없다(tests/seed-remote-tasks.test.ts가 소스를 검사한다).
//   2. 전부 한 트랜잭션이고, 프로젝트 행을 잠근 채 검증한다. 하나라도 못 넘으면 아무것도 쓰지 않는다.
//   3. 틀린 곳을 **모두** 모아서 알려준다(하나 고치고 다시 돌리게 하지 않는다).
//   4. 같은 파일을 두 번 돌리면 중복(같은 feature_key·같은 태스크 제목)으로 거부한다 — 재실행이 데이터를 불리지 않는다.
//   5. 프로젝트가 있어야 하고, --as가 그 조직의 대표여야 한다. 엉뚱한 DB를 가리키면 여기서 멈춘다.
//   6. 기본은 dry-run이다 — 실제와 같은 경로로 끝까지 돌고 마지막에 ROLLBACK한다.
//   7. 서버 설정(env.ts)을 끌고 오지 않는다. 운영자 노트북에는 JWT_SECRET이 없다(자식 프로세스 테스트가 고정).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const docSchema = z
  .object({
    specs: z.array(specInputSchema).max(AUTHORING_LIMITS.specs).default([]),
    tasks: z
      .array(
        taskFieldsSchema
          .extend({
            // 파일 안에서 태스크를 가리키는 이름. dependsOn이 쓴다. DB에는 저장하지 않는다.
            ref: z.string().trim().min(1).max(64),
            repo: z.string().trim().min(1), // repos.full_name
            // 파일 형식은 예전처럼 생략 = 역할 제한 없음. API는 명시해야 한다.
            teamRole: taskFieldsSchema.shape.teamRole.default(null),
            spec: z.string().trim().min(1).optional(), // 이 파일의 featureKey 또는 프로젝트에 이미 있는 featureKey
            dependsOn: z.array(z.string().trim().min(1)).default([]), // 이 파일의 ref 또는 이미 있는 태스크 id
          })
          .strict(),
      )
      .max(AUTHORING_LIMITS.tasks)
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

export type ImportPlan = AuthoringInput;

type Reader = Pick<PoolClient, 'query'>;

// 파일을 해석하고 --as를 대표 id로 푼다. 검증(레포·명세·의존·중복)은 applyImport가 도메인에서 한다.
export async function planImport(
  db: Reader,
  input: { projectId: string; asLoginId: string; doc: unknown },
): Promise<ImportPlan> {
  const parsed = docSchema.safeParse(input.doc);
  if (!parsed.success) {
    throw new ImportRefused(parsed.error.issues.map((i) => `${i.path.join('.') || '(파일)'}: ${i.message}`));
  }
  const doc = parsed.data;

  if (!UUID.test(input.projectId)) throw new ImportRefused([`프로젝트 id 형식이 아니다: ${input.projectId}`]);
  const project = (await db.query(`SELECT org_id FROM projects WHERE id = $1`, [input.projectId])).rows[0] as
    | { org_id: string }
    | undefined;
  if (!project) {
    throw new ImportRefused([`프로젝트 ${input.projectId}가 없다 — DATABASE_URL이 맞는 DB를 가리키는지 확인하라`]);
  }

  // 모든 행동은 사람에게 귀속된다. 그 조직의 대표만 들여올 수 있다(도메인이 id로 한 번 더 확인한다).
  const actor = (await db.query(`SELECT id, org_id, org_role FROM users WHERE login_id = $1`, [input.asLoginId])).rows[0] as
    | { id: string; org_id: string | null; org_role: string }
    | undefined;
  if (!actor || actor.org_id !== project.org_id || actor.org_role !== 'REPRESENTATIVE') {
    throw new ImportRefused([`--as ${input.asLoginId}는 이 프로젝트 조직의 대표가 아니다`]);
  }

  const refs = new Set(doc.tasks.map((t) => t.ref));
  const tasks: TaskDraft[] = doc.tasks.map((t) => ({
    ref: t.ref,
    title: t.title,
    teamRole: t.teamRole,
    kind: t.kind,
    repo: { fullName: t.repo },
    spec: t.spec === undefined ? null : { featureKey: t.spec },
    // 파일의 ref면 묶음 안 태스크, 아니면 이미 있는 태스크 id로 본다.
    dependsOn: t.dependsOn.map((d) => (refs.has(d) ? { ref: d } : { id: d })),
  }));

  return { projectId: input.projectId, actorUserId: actor.id, source: 'import', specs: doc.specs, tasks };
}

export type ImportResult = { specIds: string[]; taskIds: string[]; specTestCount: number; dependencyCount: number };

export async function applyImport(client: PoolClient, plan: ImportPlan, options: { dryRun?: boolean } = {}): Promise<ImportResult> {
  try {
    const result = await authorInTransaction(client, plan, options);
    return {
      specIds: result.specs.map((s) => s.id),
      taskIds: result.taskIds.map((t) => t.id),
      specTestCount: result.specs.reduce((n, s) => n + s.tests.length, 0),
      dependencyCount: result.dependencyCount,
    };
  } catch (err) {
    if (err instanceof AppError) {
      const problems = err.code === 'PLAN_INVALID' ? (err.details as { where: string; message: string }[]) : null;
      throw new ImportRefused(problems ? problems.map((p) => `${p.where} ${p.message}`) : [`${err.code}: ${err.message}`]);
    }
    throw err;
  }
}
