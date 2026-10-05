import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

// 커밋된 이벤트의 신호를 받는다(016의 events INSERT 트리거 → NOTIFY nomos_events).
//
// - 전용 연결 하나로 LISTEN한다. 풀의 연결은 돌려쓰므로 LISTEN을 걸어 둘 수 없다.
// - 끊기면 1초부터 두 배씩 최대 30초로 다시 붙는다. **끊겨 있던 동안의 신호는 잃는다** — 그래서 다시 붙으면 onResync를 부르고,
//   받는 쪽(화면)은 전부 다시 읽는다. 신호는 "다시 읽어라"일 뿐이라 이것으로 상태가 맞는다.

export const EVENT_CHANNEL = 'nomos_events';

export type CommittedEvent = { id: string; orgId: string | null; projectId: string | null; type: string };

// ready: 처음 LISTEN이 걸린 순간(테스트가 기다린다). 실패해도 재연결은 계속하므로 reject하지 않는다.
export type EventFeed = { ready: Promise<void>; close(): Promise<void> };

export function startEventFeed(handlers: {
  onEvent: (event: CommittedEvent) => void;
  onResync: () => void;
  connectionString?: string;
}): EventFeed {
  let client: pg.Client | null = null;
  let closed = false;
  let connectedOnce = false;
  let delay = 1_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => (markReady = resolve));

  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, delay);
    timer.unref();
    delay = Math.min(delay * 2, 30_000);
  };

  const connect = async (): Promise<void> => {
    const c = new pg.Client({ connectionString: handlers.connectionString ?? env.DATABASE_URL });
    client = c;
    c.on('notification', (msg) => {
      if (msg.channel !== EVENT_CHANNEL || !msg.payload) return;
      try {
        const raw = JSON.parse(msg.payload) as { id: number | string; orgId: string | null; projectId: string | null; type: string };
        handlers.onEvent({ id: String(raw.id), orgId: raw.orgId, projectId: raw.projectId, type: raw.type });
      } catch (err) {
        logger.warn('event feed: bad notification', { error: String(err) });
      }
    });
    const lost = (reason: string) => {
      if (client !== c) return;
      client = null;
      c.removeAllListeners('notification');
      c.end().catch(() => undefined);
      if (!closed) {
        logger.warn('event feed disconnected — reconnecting', { reason });
        schedule();
      }
    };
    c.on('error', (err) => lost(String(err)));
    c.on('end', () => lost('connection ended'));
    try {
      await c.connect();
      await c.query(`LISTEN ${EVENT_CHANNEL}`);
      if (closed) {
        await c.end();
        return;
      }
      delay = 1_000;
      // 처음 연결이 아니면 끊긴 사이의 신호를 잃었다.
      if (connectedOnce) handlers.onResync();
      connectedOnce = true;
      markReady();
    } catch (err) {
      lost(String(err));
    }
  };

  void connect();

  return {
    ready,
    close: async () => {
      closed = true;
      markReady();
      if (timer) clearTimeout(timer);
      const c = client;
      client = null;
      if (c) await c.end().catch(() => undefined);
    },
  };
}
