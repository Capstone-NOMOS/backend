import type { NomosClient } from '../bridge/nomos-client.js';

// 다음에 할 태스크를 어디서 받는가. 기본은 서버 푸시(웹소켓, stream-source.ts)이고, 끊겼을 때는 폴링으로 메운다.
// "다음에 할 태스크"만 인터페이스로 두고, 어떻게 받는지는 구현체에 맡긴다.
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
  // 지금 가져갈 수 있는 태스크(서버가 역할·선행·시작 여부로 거른 것). 처리 중인 것을 빼는 건 호출부 몫이다.
  nextTasks(limit: number): Promise<TaskSummary[]>;
  // 목록이 바뀔 때까지(또는 최대 maxMs) 기다린다. 폴링은 그냥 maxMs를 잔다.
  waitForChange(maxMs: number): Promise<void>;
  close(): void;
};

// 서버가 이 에이전트의 역할·선행·프로젝트 시작 여부로 거른 목록(GET /api/agents/me/tasks)을 읽는다 — 여기서 다시 거르지 않는다.
export function pollingTaskSource(client: NomosClient): TaskSource {
  return {
    kind: 'polling',
    async nextTasks(limit: number): Promise<TaskSummary[]> {
      const rows = await client.listClaimableTasks();
      return (rows as unknown as TaskSummary[]).slice(0, limit);
    },
    waitForChange: (maxMs) => new Promise((resolve) => setTimeout(resolve, maxMs)),
    close: () => {},
  };
}
