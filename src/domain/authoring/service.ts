import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../../config/db.js';
import { AppError } from '../../errors.js';
import { assertProjectVisibleToUser, type UserContext } from '../project/visibility.js';
import type { TeamRole } from '../roles.js';
import { findTaskById, type Task } from '../task/repository.js';
import { authorInTransaction } from './apply.js';
import { listSpecs, type SpecView } from './repository.js';
import type { SpecInput, TaskKind } from './schema.js';

// 대표가 화면에서 명세·태스크를 하나씩 만든다. 서버 전용 — pool을 쓰므로 seed:tasks는 이 파일을 import하지 않는다.
// 흐름·검증은 apply.ts·validate.ts 한 벌을 그대로 탄다(source='human').

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function createSpec(actorUserId: string, projectId: string, spec: SpecInput): Promise<SpecView> {
  const result = await withClient((client) =>
    authorInTransaction(client, { projectId, actorUserId, source: 'human', specs: [spec], tasks: [] }),
  );
  return result.specs[0]!;
}

export type CreateTaskInput = {
  title: string;
  teamRole: TeamRole | null;
  kind: TaskKind;
  repoId: string;
  specId: string | null;
  dependsOn: string[];
};

export async function createTask(actorUserId: string, projectId: string, task: CreateTaskInput): Promise<Task> {
  const result = await withClient((client) =>
    authorInTransaction(client, {
      projectId,
      actorUserId,
      source: 'human',
      specs: [],
      tasks: [
        {
          ref: 'task',
          title: task.title,
          teamRole: task.teamRole,
          kind: task.kind,
          repo: { id: task.repoId },
          spec: task.specId === null ? null : { id: task.specId },
          dependsOn: task.dependsOn.map((id) => ({ id })),
        },
      ],
    }),
  );
  return (await findTaskById(pool, result.taskIds[0]!.id))!;
}

// 명세 목록. 볼 수 있는 범위는 태스크 목록과 같다 — 사람은 볼 수 있는 프로젝트, 에이전트는 자기 프로젝트.
// 에이전트에게는 잠긴 시험지만 보인다(브리핑과 같은 규칙 — 초안을 보면 "통과하도록 코드를 맞추는" 대상이 된다).
export type SpecViewer = { kind: 'agent'; projectId: string } | { kind: 'user'; actor: UserContext };

export async function listProjectSpecs(viewer: SpecViewer, projectId: string): Promise<SpecView[]> {
  return withTransaction(async (tx) => {
    if (viewer.kind === 'agent') {
      if (viewer.projectId !== projectId) throw new AppError('NOT_PROJECT_MEMBER', 'agent is not a member of this project');
    } else {
      await assertProjectVisibleToUser(tx, viewer.actor, projectId);
    }
    return listSpecs(tx, projectId, { lockedTestsOnly: viewer.kind === 'agent' });
  });
}
