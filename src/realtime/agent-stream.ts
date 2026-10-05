import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { logger } from '../config/logger.js';
import { markAgentSeen, streamClosed, streamOpened } from '../domain/agent/presence.js';
import { onTasksChanged } from '../domain/dispatch/tasks-changed.js';
import { listClaimableTasksForAgent, type AgentContext } from '../domain/task/service.js';
import { AppError } from '../errors.js';
import { agentContextFrom, resolveAgentToken } from '../middleware/agent-auth.js';

// 에이전트 태스크 스트림 — 프로젝트가 시작되면 서버가 역할별 담당 에이전트에게 "지금 가져갈 수 있는 태스크"를 보낸다.
//
// - 보내는 것은 변화분이 아니라 **스냅샷**(GET /api/agents/me/tasks와 같은 목록)이다. 메시지를 놓치거나 겹쳐도 다음 스냅샷이 맞다.
//   언제 보내나: 연결 직후, 그리고 그 프로젝트에서 상태가 바뀔 때마다(dispatch/tasks-changed — 시작·적용·수령·검증 결론).
// - 담당은 서버가 정한다: 스냅샷은 그 에이전트의 역할(project_members)로 거른다. 역할당 에이전트는 하나다.
// - 수령(claim)은 여전히 HTTP다. 푸시는 "가져가라"는 알림이고, 경합·선행·정책 검사는 claim이 그대로 한다.
// - 인증: 연결 뒤 첫 메시지로 토큰을 보낸다({ type: 'auth', token }). URL에 실으면 프록시 로그에 남는다.
//   검증은 HTTP와 같은 resolveAgentToken(서명 → 재조회 → 정지 → 정책 신선도).
//
// 서버→클라이언트: { type: 'ready', agentId, projectId } · { type: 'tasks', projectId, tasks } · { type: 'error', code, message }
// 닫는 코드: 4400 잘못된 메시지 · 4401 인증 실패(재발급 후 다시 연결) · 4403 프로젝트 멤버 아님 · 4408 인증 시간 초과

export const AGENT_STREAM_PATH = '/api/agents/stream';
const AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;

type Connection = { ws: WebSocket; ctx: AgentContext; alive: boolean; running: Promise<void> | null; dirty: boolean };

function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function closeWith(ws: WebSocket, code: number, errorCode: string, message: string): void {
  send(ws, { type: 'error', code: errorCode, message });
  ws.close(code, errorCode);
}

export type AgentStream = { close(): Promise<void>; connectionCount(): number };

export function attachAgentStream(server: Server): AgentStream {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const byProject = new Map<string, Set<Connection>>();

  const register = (conn: Connection) => {
    const set = byProject.get(conn.ctx.projectId) ?? new Set<Connection>();
    set.add(conn);
    byProject.set(conn.ctx.projectId, set);
  };
  const unregister = (conn: Connection) => {
    const set = byProject.get(conn.ctx.projectId);
    set?.delete(conn);
    if (set?.size === 0) byProject.delete(conn.ctx.projectId);
  };

  // 한 연결의 스냅샷은 **차례로** 계산·전송한다. 겹쳐 돌리면 먼저 계산한(옛) 스냅샷이 나중에 도착해 클라이언트가
  // 낡은 목록을 들고 있게 된다(연결 직후의 첫 스냅샷과 시작 직후의 푸시가 겹친 경우 실제로 그랬다).
  // 도는 중에 신호가 또 오면 한 번만 더 돈다 — 마지막 전송은 항상 마지막 신호 이후의 상태다.
  const pushSnapshot = (conn: Connection): Promise<void> => {
    if (conn.running) {
      conn.dirty = true;
      return conn.running;
    }
    conn.running = (async () => {
      do {
        conn.dirty = false;
        await sendSnapshot(conn);
      } while (conn.dirty && conn.ws.readyState === conn.ws.OPEN);
      conn.running = null;
    })();
    return conn.running;
  };

  const sendSnapshot = async (conn: Connection): Promise<void> => {
    try {
      const tasks = await listClaimableTasksForAgent(conn.ctx);
      send(conn.ws, { type: 'tasks', projectId: conn.ctx.projectId, tasks });
    } catch (err) {
      // 배정이 해제됐거나 에이전트가 지워졌다 — 더 보낼 게 없다.
      if (err instanceof AppError && err.code === 'NOT_PROJECT_MEMBER') {
        closeWith(conn.ws, 4403, err.code, err.message);
        return;
      }
      logger.warn('agent stream snapshot failed', { agentId: conn.ctx.agentId, error: String(err) });
    }
  };

  const unsubscribe = onTasksChanged(async (projectId) => {
    const set = byProject.get(projectId);
    if (!set) return;
    await Promise.all([...set].map(pushSnapshot));
  });

  const handle = (ws: WebSocket) => {
    let conn: Connection | null = null;
    const authTimer = setTimeout(() => closeWith(ws, 4408, 'AUTH_TIMEOUT', 'send { type: "auth", token } first'), AUTH_TIMEOUT_MS);

    ws.on('message', async (raw: RawData) => {
      if (conn) return; // 인증 뒤에는 클라이언트가 보낼 것이 없다(수령은 HTTP).
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
        const ctx = agentContextFrom(await resolveAgentToken(token));
        conn = { ws, ctx, alive: true, running: null, dirty: false };
        register(conn);
        streamOpened(ctx.agentId);
        send(ws, { type: 'ready', agentId: ctx.agentId, projectId: ctx.projectId });
        await pushSnapshot(conn);
      } catch (err) {
        if (err instanceof AppError) {
          const code = err.code === 'NOT_PROJECT_MEMBER' ? 4403 : 4401;
          closeWith(ws, code, err.code, err.message);
          return;
        }
        logger.error('agent stream auth failed', { error: String(err) });
        ws.close(1011, 'internal error');
      }
    });

    ws.on('pong', () => {
      if (conn) {
        conn.alive = true;
        markAgentSeen(conn.ctx.agentId);
      }
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (conn) {
        unregister(conn);
        streamClosed(conn.ctx.agentId);
      }
    });
    ws.on('error', () => ws.terminate());
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== AGENT_STREAM_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, handle);
  };
  server.on('upgrade', onUpgrade);

  // 응답 없는 연결을 정리한다(노트북 절전·네트워크 끊김). 프록시의 유휴 시간 제한도 막는다.
  const ping = setInterval(() => {
    for (const set of byProject.values()) {
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

  return {
    connectionCount: () => [...byProject.values()].reduce((n, s) => n + s.size, 0),
    close: async () => {
      clearInterval(ping);
      unsubscribe();
      server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
