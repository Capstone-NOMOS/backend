import type { NomosClient } from '../bridge/nomos-client.js';

// 지금은 폴링이지만 나중에 이벤트 스트림으로 갈아끼운다.
// 그래서 "다음에 할 태스크를 가져온다"만 인터페이스로 두고, 어떻게 가져오는지는 구현체에 맡긴다.
export type TaskSummary = {
  id: string;
  title: string;
  state: string;
  teamRole: string | null;
  repoId: string;
  specId: string | null;
  branchName: string | null;
};

export type TaskSource = {
  readonly kind: string;
  nextTasks(limit: number): Promise<TaskSummary[]>;
};

// 서버가 에이전트 토큰을 보고 자기 역할로 필터해 준다 — 여기서 역할을 다시 거르지 않는다.
export function pollingTaskSource(client: NomosClient, projectId: string): TaskSource {
  return {
    kind: 'polling',
    async nextTasks(limit: number): Promise<TaskSummary[]> {
      const rows = await client.listTasks(projectId, { state: 'READY', limit });
      return rows as unknown as TaskSummary[];
    },
  };
}
