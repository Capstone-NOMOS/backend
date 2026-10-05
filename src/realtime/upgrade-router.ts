import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

// 한 HTTP 서버의 웹소켓 업그레이드를 경로별로 나눠 받는다(에이전트 스트림·사람 스트림).
// 스트림마다 server.on('upgrade')를 따로 걸면 서로 모르는 경로의 소켓을 끊어 버린다 — 리스너는 서버당 하나이고,
// 등록되지 않은 경로만 여기서 끊는다.

type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

const routes = new WeakMap<Server, Map<string, UpgradeHandler>>();

export function routeUpgrade(server: Server, path: string, handler: UpgradeHandler): () => void {
  let table = routes.get(server);
  if (!table) {
    const created = new Map<string, UpgradeHandler>();
    routes.set(server, created);
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const route = created.get(pathname);
      if (route) route(req, socket, head);
      else socket.destroy();
    });
    table = created;
  }
  table.set(path, handler);
  const owned = table;
  return () => {
    if (owned.get(path) === handler) owned.delete(path);
  };
}
