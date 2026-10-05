import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { pool } from '../config/db.js';
import { logger } from '../config/logger.js';
import { onPresenceChanged, sweepPresence } from '../domain/agent/presence.js';
import { agentOrgId } from '../domain/agent/service.js';
import { assertProjectVisibleToUser, type UserContext } from '../domain/project/visibility.js';
import { AppError } from '../errors.js';
import { resolveUserToken } from '../middleware/auth.js';
import { isAllowedOrigin, type OriginRule } from '../middleware/cors.js';
import type { CommittedEvent } from './event-feed.js';
import { topicsFor } from './topics.js';
import { routeUpgrade } from './upgrade-router.js';

// 사람용 실시간 스트림 — 화면이 폴링 대신 "다시 읽어라" 신호를 받는다.
//
// - 신호에는 **무엇을 다시 읽을지(토픽)만** 싣는다. 데이터는 기존 API로 다시 읽는다 — 권한·응답 모양이 API 한 곳에서 정해지고,
//   신호를 놓치거나 겹쳐도 다시 읽은 결과가 맞다. 그래서 순서·재전송을 관리하지 않는다.
// - 신호원은 커밋된 이벤트(016 트리거 → NOTIFY)와 에이전트 접속 상태 변화다. 서비스가 따로 알림을 부를 필요가 없다.
// - 범위: org 토픽은 같은 조직의 모든 연결(approvals는 대표만), project 토픽은 그 프로젝트를 **구독한** 연결만.
//   구독할 때 assertProjectVisibleToUser로 확인한다(HTTP와 같은 정의). 배정이 해제되면 다시 확인해 구독을 끊는다.
// - 인증은 연결 뒤 첫 메시지 { type: 'auth', token }(사람 JWT) — URL에 실으면 프록시 로그에 남는다. 역할은 연결할 때 읽는다.
//
// 클라이언트→서버: auth · { type: 'subscribe', projectId } · { type: 'unsubscribe', projectId }
// 서버→클라이언트: { type: 'ready', userId, orgId, orgRole } · { type: 'subscribed' | 'unsubscribed', projectId }
//                 { type: 'changed', projectId | null, topics, lastEventId | null } · { type: 'resync' } · { type: 'error', code, message, projectId? }
// 닫는 코드: 4400 잘못된 첫 메시지 · 4401 인증 실패 · 4403 조직 없음 · 4408 인증 시간 초과
//
// Origin: 브라우저가 붙는 경로라 HTTP의 CORS 허용 목록과 같은 규칙으로 업그레이드를 거른다(Origin 없음 = 브라우저 아님 → 통과,
// 서버 자신의 주소 → 통과). 다른 사이트의 스크립트는 토큰이 없어 인증에서도 막히지만, 한 겹 더 둔다.

export const USER_STREAM_PATH = '/api/stream';
const AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;
const PRESENCE_SWEEP_MS = 10_000;
// 한 트랜잭션이 이벤트 여러 개를 남기면(계획 적용 등) 신호가 몰려온다 — 연결마다 잠깐 모아서 한 번에 보낸다.
const COALESCE_MS = 100;
const MAX_SUBSCRIPTIONS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Pending = { topics: Set<string>; lastEventId: string | null };

type Connection = {
  ws: WebSocket;
  ctx: UserContext;
  alive: boolean;
  projects: Set<string>;
  pending: Map<string, Pending>; // projectId(org 신호는 '') → 모은 토픽
  flushTimer: ReturnType<typeof setTimeout> | null;
};

function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function closeWith(ws: WebSocket, code: number, errorCode: string, message: string): void {
  send(ws, { type: 'error', code: errorCode, message });
  ws.close(code, errorCode);
}

function maxId(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return BigInt(a) >= BigInt(b) ? a : b;
}

export type UserStream = {
  onEvent(event: CommittedEvent): void;
  resync(): void;
  close(): Promise<void>;
  connectionCount(): number;
};

export type UserStreamOptions = { allowedOrigins: readonly OriginRule[]; selfOrigin: string | null };

export function attachUserStream(server: Server, options: UserStreamOptions): UserStream {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const byOrg = new Map<string, Set<Connection>>();

  const queue = (conn: Connection, projectId: string | null, topics: readonly string[], eventId: string | null) => {
    if (topics.length === 0) return;
    const key = projectId ?? '';
    const entry = conn.pending.get(key) ?? { topics: new Set<string>(), lastEventId: null };
    for (const t of topics) entry.topics.add(t);
    entry.lastEventId = maxId(entry.lastEventId, eventId);
    conn.pending.set(key, entry);
    if (conn.flushTimer) return;
    conn.flushTimer = setTimeout(() => {
      conn.flushTimer = null;
      for (const [k, p] of conn.pending) {
        send(conn.ws, { type: 'changed', projectId: k === '' ? null : k, topics: [...p.topics].sort(), lastEventId: p.lastEventId });
      }
      conn.pending.clear();
    }, COALESCE_MS);
  };

  // 배정이 해제된 팀원은 그 프로젝트를 더 볼 수 없다 — 구독을 다시 확인한다.
  const recheck = async (projectId: string, conns: Connection[]) => {
    for (const conn of conns) {
      if (conn.ctx.orgRole === 'REPRESENTATIVE' || !conn.projects.has(projectId)) continue;
      try {
        await assertProjectVisibleToUser(pool, conn.ctx, projectId);
      } catch {
        conn.projects.delete(projectId);
        send(conn.ws, { type: 'unsubscribed', projectId, reason: 'NOT_PROJECT_MEMBER' });
      }
    }
  };

  const onEvent = (event: CommittedEvent) => {
    if (!event.orgId) return;
    const conns = byOrg.get(event.orgId);
    if (!conns) return;
    const { project, org } = topicsFor(event.type, event.projectId !== null);
    const list = [...conns];
    for (const conn of list) {
      const orgTopics = conn.ctx.orgRole === 'REPRESENTATIVE' ? org : org.filter((t) => t !== 'approvals');
      // org 토픽은 그 이벤트의 프로젝트를 함께 알려 준다(대시보드가 어느 프로젝트의 카드인지 안다). 화면은 조직 단위로 다시 읽는다.
      if (orgTopics.length > 0) queue(conn, null, orgTopics, event.id);
      if (event.projectId && conn.projects.has(event.projectId)) queue(conn, event.projectId, project, event.id);
    }
    if (event.type === 'MEMBER_UNASSIGNED' && event.projectId) {
      void recheck(event.projectId, list).catch((err: unknown) => logger.warn('user stream recheck failed', { error: String(err) }));
    }
  };

  const unsubscribePresence = onPresenceChanged((agentId) => {
    void agentOrgId(agentId)
      .then((orgId) => {
        const conns = orgId ? byOrg.get(orgId) : undefined;
        for (const conn of conns ?? []) queue(conn, null, ['agents'], null);
      })
      .catch((err: unknown) => logger.warn('user stream presence failed', { agentId, error: String(err) }));
  });

  const handleMessage = async (conn: Connection, raw: RawData) => {
    let msg: { type?: unknown; projectId?: unknown };
    try {
      msg = JSON.parse(raw.toString()) as typeof msg;
    } catch {
      send(conn.ws, { type: 'error', code: 'BAD_MESSAGE', message: 'messages must be JSON' });
      return;
    }
    if ((msg.type !== 'subscribe' && msg.type !== 'unsubscribe') || typeof msg.projectId !== 'string' || !UUID.test(msg.projectId)) {
      send(conn.ws, { type: 'error', code: 'BAD_MESSAGE', message: 'expected { "type": "subscribe" | "unsubscribe", "projectId": "<uuid>" }' });
      return;
    }
    const projectId = msg.projectId;
    if (msg.type === 'unsubscribe') {
      conn.projects.delete(projectId);
      send(conn.ws, { type: 'unsubscribed', projectId });
      return;
    }
    if (!conn.projects.has(projectId) && conn.projects.size >= MAX_SUBSCRIPTIONS) {
      send(conn.ws, { type: 'error', code: 'TOO_MANY_SUBSCRIPTIONS', message: `at most ${MAX_SUBSCRIPTIONS} projects per connection`, projectId });
      return;
    }
    try {
      await assertProjectVisibleToUser(pool, conn.ctx, projectId);
      conn.projects.add(projectId);
      send(conn.ws, { type: 'subscribed', projectId });
    } catch (err) {
      if (err instanceof AppError) send(conn.ws, { type: 'error', code: err.code, message: err.message, projectId });
      else {
        logger.error('user stream subscribe failed', { error: String(err) });
        send(conn.ws, { type: 'error', code: 'INTERNAL_ERROR', message: 'internal error', projectId });
      }
    }
  };

  const handle = (ws: WebSocket) => {
    let conn: Connection | null = null;
    let authenticating = false;
    const authTimer = setTimeout(() => closeWith(ws, 4408, 'AUTH_TIMEOUT', 'send { type: "auth", token } first'), AUTH_TIMEOUT_MS);

    ws.on('message', async (raw: RawData) => {
      if (conn) {
        await handleMessage(conn, raw);
        return;
      }
      if (authenticating) return;
      authenticating = true;
      clearTimeout(authTimer);
      let token: unknown;
      try {
        const parsed = JSON.parse(raw.toString()) as { type?: unknown; token?: unknown };
        if (parsed.type !== 'auth') throw new Error('first message must be auth');
        token = parsed.token;
      } catch {
        closeWith(ws, 4400, 'BAD_MESSAGE', 'first message must be { "type": "auth", "token": "..." }');
        return;
      }
      if (typeof token !== 'string' || token.length === 0) {
        closeWith(ws, 4400, 'BAD_MESSAGE', 'token is required');
        return;
      }
      try {
        const user = await resolveUserToken(token);
        if (user.orgId === null) {
          closeWith(ws, 4403, 'NOT_IN_ORG', 'join or create an organization first');
          return;
        }
        if (ws.readyState !== ws.OPEN) return;
        conn = {
          ws,
          ctx: { userId: user.id, orgId: user.orgId, orgRole: user.orgRole },
          alive: true,
          projects: new Set(),
          pending: new Map(),
          flushTimer: null,
        };
        const set = byOrg.get(user.orgId) ?? new Set<Connection>();
        set.add(conn);
        byOrg.set(user.orgId, set);
        send(ws, { type: 'ready', userId: user.id, orgId: user.orgId, orgRole: user.orgRole });
      } catch (err) {
        if (err instanceof AppError) {
          closeWith(ws, 4401, err.code, err.message);
          return;
        }
        logger.error('user stream auth failed', { error: String(err) });
        ws.close(1011, 'internal error');
      }
    });

    ws.on('pong', () => {
      if (conn) conn.alive = true;
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!conn) return;
      if (conn.flushTimer) clearTimeout(conn.flushTimer);
      const set = byOrg.get(conn.ctx.orgId);
      set?.delete(conn);
      if (set?.size === 0) byOrg.delete(conn.ctx.orgId);
    });
    ws.on('error', () => ws.terminate());
  };

  const originAllowed = (origin: string | undefined) =>
    origin === undefined || origin === options.selfOrigin || isAllowedOrigin(options.allowedOrigins, origin);

  const unroute = routeUpgrade(server, USER_STREAM_PATH, (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!originAllowed(req.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, handle);
  });

  const ping = setInterval(() => {
    for (const set of byOrg.values()) {
      for (const conn of set) {
        if (!conn.alive) {
          conn.ws.terminate();
          continue;
        }
        conn.alive = false;
        conn.ws.ping();
      }
    }
  }, PING_INTERVAL_MS);
  ping.unref();

  // 스트림이 닫힌 뒤 일정 시간이 지나 offline이 되는 것은 요청 없이 일어난다 — 주기적으로 훑는다.
  const sweep = setInterval(() => sweepPresence(), PRESENCE_SWEEP_MS);
  sweep.unref();

  return {
    onEvent,
    // 신호원(LISTEN)이 끊겼다 다시 붙었다 — 그 사이 신호를 잃었으니 전부 다시 읽게 한다.
    resync: () => {
      for (const set of byOrg.values()) for (const conn of set) send(conn.ws, { type: 'resync' });
    },
    connectionCount: () => [...byOrg.values()].reduce((n, s) => n + s.size, 0),
    close: async () => {
      clearInterval(ping);
      clearInterval(sweep);
      unsubscribePresence();
      unroute();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
