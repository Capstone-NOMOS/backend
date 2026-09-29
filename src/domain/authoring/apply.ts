import type { PoolClient } from 'pg';
import { AppError } from '../../errors.js';
import { appendEvent } from '../events/append.js';
import type { AuthoringSource } from '../events/types.js';
import { violatedConstraint } from '../pg-errors.js';
import {
  findActor,
  insertSpec,
  insertSpecTest,
  insertTask,
  insertTaskDependency,
  loadProjectSnapshot,
  lockProjectForAuthoring,
  type SpecView,
} from './repository.js';
import type { SpecInput } from './schema.js';
import { validateAuthoring, type TaskDraft } from './validate.js';

// 명세·태스크 작성의 트랜잭션 흐름 — **한 벌만 둔다.** 서버(service.ts)는 pool에서 꺼낸 연결을, seed:tasks는 자기 연결을
// 넘기기만 한다. BEGIN → 프로젝트 잠금 → 권한·상태 → 검증 → INSERT → 이벤트 → COMMIT의 순서가 두 곳에서 갈라지지 않게.
// dryRun이면 끝까지 똑같이 돌고 마지막에 ROLLBACK한다 — 미리보기가 실제와 다른 경로를 타지 않는다.

const OPEN_STATUSES = new Set(['planning', 'active']);

export type AuthoringInput = {
  projectId: string;
  // 이 작성의 주인. 대표여야 한다(PM이 붙으면 on_behalf_of 규칙과 함께 여기를 넓힌다).
  actorUserId: string;
  source: AuthoringSource;
  specs: SpecInput[];
  tasks: TaskDraft[];
};

export type AuthoringResult = {
  specs: SpecView[];
  // 묶음 안 ref → 만들어진 태스크 id
  taskIds: { ref: string; id: string }[];
  dependencyCount: number;
};

export async function authorInTransaction(
  client: PoolClient,
  input: AuthoringInput,
  options: { dryRun?: boolean } = {},
): Promise<AuthoringResult> {
  await client.query('BEGIN');
  try {
    const project = await lockProjectForAuthoring(client, input.projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', `project ${input.projectId} not found`);

    const actor = await findActor(client, input.actorUserId);
    if (!actor || actor.orgId !== project.orgId) {
      throw new AppError('CROSS_ORG_ACCESS', 'cannot access another organization');
    }
    if (actor.orgRole !== 'REPRESENTATIVE') {
      throw new AppError('NOT_REPRESENTATIVE', 'only the organization representative can create specs and tasks');
    }
    if (!OPEN_STATUSES.has(project.status)) {
      throw new AppError('PROJECT_NOT_OPEN', `project is ${project.status}; specs and tasks can be added only while planning or active`);
    }

    const snapshot = await loadProjectSnapshot(client, project.id);
    const { problems, tasks } = validateAuthoring(snapshot, input);
    if (problems.length > 0) {
      throw new AppError('PLAN_INVALID', `명세·태스크 검증 실패 ${problems.length}건`, problems);
    }

    const event = { orgId: project.orgId, projectId: project.id, onBehalfOf: input.actorUserId, policyHash: project.policyHash };

    const specs: SpecView[] = [];
    const specIdByKey = new Map<string, string>();
    for (const spec of input.specs) {
      const created = await insertSpec(client, project.id, spec);
      const tests = [];
      for (const test of spec.tests) tests.push(await insertSpecTest(client, created.id, test));
      specs.push({ ...created, tests });
      specIdByKey.set(spec.featureKey, created.id);
      await appendEvent(client, {
        ...event,
        type: 'SPEC_CREATED',
        payload: {
          source: input.source,
          specId: created.id,
          featureKey: spec.featureKey,
          testCount: tests.length,
          lockedTestCount: tests.filter((t) => t.lockedAt !== null).length,
        },
      });
    }

    const taskIdByRef = new Map<string, string>();
    for (const task of tasks) {
      const specId = task.spec === null ? null : 'newKey' in task.spec ? specIdByKey.get(task.spec.newKey)! : task.spec.existingId;
      taskIdByRef.set(
        task.ref,
        await insertTask(client, project.id, { repoId: task.repoId, specId, title: task.title, kind: task.kind, teamRole: task.teamRole }),
      );
    }

    // 선행 관계는 태스크를 전부 넣은 뒤에 — 묶음 안에서 뒤쪽 태스크를 가리킬 수 있다.
    let dependencyCount = 0;
    for (const task of tasks) {
      const taskId = taskIdByRef.get(task.ref)!;
      const dependsOn = task.dependsOn.map((d) => ('ref' in d ? taskIdByRef.get(d.ref)! : d.existingId));
      for (const dep of dependsOn) await insertTaskDependency(client, taskId, dep);
      dependencyCount += dependsOn.length;
      const specId = task.spec === null ? null : 'newKey' in task.spec ? specIdByKey.get(task.spec.newKey)! : task.spec.existingId;
      await appendEvent(client, {
        ...event,
        type: 'TASK_CREATED',
        payload: {
          source: input.source,
          taskId,
          title: task.title,
          repoId: task.repoId,
          teamRole: task.teamRole,
          kind: task.kind,
          specId,
          dependsOn,
        },
      });
    }

    await client.query(options.dryRun ? 'ROLLBACK' : 'COMMIT');
    return { specs, taskIds: [...taskIdByRef].map(([ref, id]) => ({ ref, id })), dependencyCount };
  } catch (err) {
    await client.query('ROLLBACK');
    // 프로젝트를 잠그므로 이 경로끼리는 겹치지 않는다. 그래도 다른 경로가 같은 키를 먼저 썼다면 409로 돌려준다.
    if (violatedConstraint(err) !== undefined) {
      throw new AppError('PLAN_CONFLICT', 'another request created the same spec or task first; reload and retry');
    }
    throw err;
  }
}
