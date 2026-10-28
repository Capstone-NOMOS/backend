import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NomosApiError, NomosClient } from '../src/bridge/nomos-client.js';
import { clearDaemonIfSelf, daemonFile, isAlive } from '../src/executor/background.js';
import { runClaude } from '../src/executor/runner.js';
import { AgentStop, isAgentDisconnected } from '../src/executor/stop.js';
import { streamTaskSource } from '../src/executor/stream-source.js';

// 연결이 해제되면(AGENT_DISCONNECTED) Executor가 실행 중인 Claude를 멈춘다(executor/stop.ts). 서버가 열린 실행을 이미 닫으므로 종료 보고는 보내지 않는다.

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'nomos-stop-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('AgentStop', () => {
  it('AGENT_DISCONNECTED만 멈춤으로 본다 — 다른 에러는 그대로 둔다', async () => {
    const stop = new AgentStop();
    expect(stop.noteError(new NomosApiError(401, 'UNAUTHENTICATED', 'expired'))).toBe(false);
    expect(stop.noteError(new Error('network'))).toBe(false);
    const stopped = stop.whenStopped();
    expect(stop.noteError(new NomosApiError(401, 'AGENT_DISCONNECTED', 'disconnected'))).toBe(true);
    await expect(stopped).resolves.toBeUndefined();
    expect(stop.signal.aborted).toBe(true);
    expect(isAgentDisconnected({ code: 'AGENT_DISCONNECTED' })).toBe(true);
  });
});

describe('runClaude — 멈추면 자식 프로세스를 끝내고 aborted로 돌려준다', () => {
  it('실행 중에 멈추면 자식이 끝나고 outcome은 aborted다(종료 보고 대상이 아니다)', async () => {
    const dir = tmp();
    const script = path.join(dir, 'fake-claude.mjs');
    // 가짜 claude — pid를 알리고 오래 기다린다.
    writeFileSync(script, "process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n'); setTimeout(() => {}, 60_000);\n");
    const stop = new AgentStop();
    let childPid = 0;
    const running = runClaude({
      workspaceDir: dir,
      prompt: 'x',
      mcpConfigPath: path.join(dir, 'mcp.json'),
      command: { command: process.execPath, commandArgs: [script] },
      signal: stop.signal,
      onStdoutLine: (line) => {
        childPid = (JSON.parse(line) as { pid: number }).pid;
        stop.noteError(new NomosApiError(401, 'AGENT_DISCONNECTED', 'disconnected'));
      },
    });
    const result = await running;
    expect(result.outcome).toBe('aborted');
    expect(childPid).toBeGreaterThan(0);
    expect(isAlive(childPid)).toBe(false);
  });

  it('이미 멈춘 뒤에 띄우면 바로 끝낸다', async () => {
    const dir = tmp();
    const stop = new AgentStop();
    stop.stop();
    const result = await runClaude({
      workspaceDir: dir,
      prompt: 'x',
      mcpConfigPath: path.join(dir, 'mcp.json'),
      command: { command: process.execPath, commandArgs: ['-e', 'setTimeout(() => {}, 60_000)'] },
      signal: stop.signal,
    });
    expect(result.outcome).toBe('aborted');
  });
});

describe('NomosClient onApiError — 어느 요청에서든 AGENT_DISCONNECTED를 알린다', () => {
  it('에러 응답마다 던지기 전에 부른다', async () => {
    const seen: string[] = [];
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: 'AGENT_DISCONNECTED', message: 'this agent was disconnected' } }), { status: 401 })) as typeof fetch;
    const client = new NomosClient({ baseUrl: 'http://x', tokens: { accessToken: 'a', refreshToken: 'r' }, fetchImpl, onApiError: (e) => seen.push(e.code) });
    await expect(client.getBriefing('t1')).rejects.toMatchObject({ code: 'AGENT_DISCONNECTED' });
    expect(seen).toEqual(['AGENT_DISCONNECTED']);
  });
});

describe('태스크 스트림 — 서버가 연결 해제로 닫으면(4401 AGENT_DISCONNECTED) 재발급하지 않고 알린다', () => {
  it('onAgentDisconnected를 부르고 refresh는 부르지 않는다', async () => {
    let refreshed = 0;
    let disconnected = 0;
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      readyState = 1;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onclose: ((ev: { code: number; reason: string }) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      constructor() {
        sockets.push(this);
      }
      send(): void {}
      close(): void {}
    }
    const source = streamTaskSource({
      baseUrl: 'http://x',
      accessToken: () => 'a',
      refresh: async () => {
        refreshed += 1;
      },
      fallback: async () => [],
      log: () => {},
      onAgentDisconnected: () => {
        disconnected += 1;
      },
      WebSocketImpl: FakeSocket as unknown as new (url: string) => FakeSocket,
      backoff: { initialMs: 10, maxMs: 10 },
    });
    sockets[0]!.onclose!({ code: 4401, reason: 'AGENT_DISCONNECTED' });
    await new Promise((r) => setTimeout(r, 30));
    expect(disconnected).toBe(1);
    expect(refreshed).toBe(0);
    expect(sockets).toHaveLength(1); // 다시 연결하지 않는다
    source.close();
  });
});

describe('백그라운드 — 연결 해제로 스스로 끝날 때 daemon.json을 지운다', () => {
  it('자기 pid의 파일만 지운다(다른 프로세스의 것은 그대로)', () => {
    const previous = process.env.NOMOS_HOME;
    process.env.NOMOS_HOME = tmp();
    try {
      writeFileSync(daemonFile(), JSON.stringify({ pid: process.pid + 1, startedAt: '', server: 'x', logFile: 'x' }));
      clearDaemonIfSelf();
      expect(existsSync(daemonFile())).toBe(true);
      writeFileSync(daemonFile(), JSON.stringify({ pid: process.pid, startedAt: '', server: 'x', logFile: 'x' }));
      clearDaemonIfSelf();
      expect(existsSync(daemonFile())).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NOMOS_HOME;
      else process.env.NOMOS_HOME = previous;
    }
  });
});
