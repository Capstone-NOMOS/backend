import type { TaskSource, TaskSummary } from './task-source.js';

// 서버 푸시(웹소켓 /api/agents/stream)로 태스크를 받는다. 서버는 "지금 가져갈 수 있는 태스크" 스냅샷을 보낸다 —
// 연결 직후와 프로젝트 상태가 바뀔 때마다. 받은 스냅샷을 그대로 들고 있다가 nextTasks로 내준다.
//
// - 끊겨 있는 동안에는 HTTP 폴링(fallback)으로 같은 목록을 읽는다. 푸시를 놓쳐도 다음 스냅샷이 맞으므로 복구가 단순하다.
// - 다시 연결은 1초부터 두 배씩 최대 30초. 4401(토큰 만료·정책 변경)이면 재발급한 뒤 연결한다 — 재발급은 연속 1회만.
// - 4403(프로젝트 멤버가 아님)이면 더 연결하지 않는다. 배정이 해제된 것이다.
// - Node 22의 전역 WebSocket을 쓴다(CLI 패키지에 의존성을 늘리지 않는다). 테스트는 생성자를 바꿔 끼운다.

type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type StreamDeps = {
  baseUrl: string;
  accessToken: () => string;
  // 4401이면 부른다. 재발급할 수 없으면(refresh token 거부) throw — 연결을 멈춘다.
  refresh: () => Promise<void>;
  fallback: () => Promise<TaskSummary[]>;
  log: (line: string) => void;
  WebSocketImpl?: new (url: string) => WebSocketLike;
  // 테스트용
  backoff?: { initialMs: number; maxMs: number };
};

export const AGENT_STREAM_PATH = '/api/agents/stream';

export function streamUrl(baseUrl: string): string {
  const url = new URL(AGENT_STREAM_PATH, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function streamTaskSource(deps: StreamDeps): TaskSource & { readonly connected: boolean } {
  const WS = deps.WebSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => WebSocketLike);
  const backoff = deps.backoff ?? { initialMs: 1000, maxMs: 30_000 };
  let latest: TaskSummary[] = [];
  let connected = false;
  let closed = false;
  let delay = backoff.initialMs;
  let refreshedInARow = false;
  let ws: WebSocketLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const waiters = new Set<() => void>();

  const wake = () => {
    for (const w of waiters) w();
    waiters.clear();
  };

  const schedule = () => {
    if (closed) return;
    reconnectTimer = setTimeout(connect, delay);
    delay = Math.min(delay * 2, backoff.maxMs);
  };

  function connect(): void {
    reconnectTimer = null;
    if (closed) return;
    const socket = new WS(streamUrl(deps.baseUrl));
    ws = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: deps.accessToken() }));
    socket.onmessage = (ev) => {
      let msg: { type?: string; tasks?: TaskSummary[]; projectId?: string; code?: string; message?: string };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        connected = true;
        delay = backoff.initialMs;
        refreshedInARow = false;
        deps.log(`서버 푸시 연결됨 — 프로젝트 ${msg.projectId ?? '?'}`);
      } else if (msg.type === 'tasks') {
        latest = msg.tasks ?? [];
        wake();
      } else if (msg.type === 'error') {
        deps.log(`서버 푸시 거부: ${msg.code ?? '?'} ${msg.message ?? ''}`.trim());
      }
    };
    socket.onerror = () => {};
    socket.onclose = (ev) => {
      const wasConnected = connected;
      connected = false;
      ws = null;
      if (closed) return;
      if (ev.code === 4403) {
        deps.log('이 에이전트는 프로젝트 멤버가 아니다 — 푸시를 멈춘다(폴링으로 계속 확인한다)');
        wake();
        return;
      }
      if (ev.code === 4401 && !refreshedInARow) {
        refreshedInARow = true;
        deps
          .refresh()
          .then(() => connect())
          .catch((err: unknown) => deps.log(`토큰 재발급 실패 — 푸시를 멈춘다: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      if (wasConnected) deps.log(`서버 푸시 끊김(${ev.code}) — 다시 연결한다. 그동안은 폴링한다`);
      wake();
      schedule();
    };
  }

  connect();

  return {
    kind: 'push',
    get connected() {
      return connected;
    },
    async nextTasks(limit: number): Promise<TaskSummary[]> {
      // 연결돼 있으면 받은 스냅샷, 아니면 같은 목록을 HTTP로.
      const tasks = connected ? latest : await deps.fallback();
      return tasks.slice(0, limit);
    },
    waitForChange(maxMs: number): Promise<void> {
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, maxMs);
        waiters.add(done);
      });
    },
    close(): void {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close(1000, 'bye');
      wake();
    },
  };
}
