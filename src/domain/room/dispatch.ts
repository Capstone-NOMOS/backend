import { withTransaction } from '../../config/db.js';
import { onTasksChanged } from '../dispatch/tasks-changed.js';
import { appendEvent } from '../events/append.js';
import { insertNewDispatches } from './repository.js';

// "이 태스크를 실행해 주세요"(TASK_DISPATCHED)를 남긴다. 가져갈 수 있는 태스크가 바뀌었을 수 있는 모든 순간에
// 서비스가 이미 tasksChanged를 부르므로(시작·계획 적용·태스크 생성·수령·제출·검증 보고·승인 결정) 그 신호를 받아 계산한다.
// 서비스마다 호출을 넣지 않는다 — 빠뜨린 경로가 조용히 생긴다.
//
// 중복은 task_dispatches의 PK가 막는다(같은 신호가 여러 번·동시에 와도 한 번). 행이 새로 들어간 태스크에만 이벤트를 남기고,
// 둘은 한 트랜잭션이다 — 기록은 됐는데 이벤트가 없는 상태가 생기지 않는다.
export const DISPATCHER = 'system:dispatcher';

export async function recordDispatches(projectId: string): Promise<number> {
  return withTransaction(async (tx) => {
    const dispatched = await insertNewDispatches(tx, projectId);
    for (const d of dispatched) {
      await appendEvent(tx, {
        orgId: d.orgId,
        projectId,
        type: 'TASK_DISPATCHED',
        onBehalfOf: DISPATCHER,
        payload: { taskId: d.taskId, title: d.title, teamRole: d.teamRole, attempt: d.attempt, resumes: d.resumes },
      });
    }
    return dispatched.length;
  });
}

let started = false;

// 앱이 뜰 때 한 번 건다(createApp). 여러 번 불려도 한 번만 구독한다.
export function startDispatchRecorder(): void {
  if (started) return;
  started = true;
  onTasksChanged(async (projectId) => {
    await recordDispatches(projectId);
  });
}
