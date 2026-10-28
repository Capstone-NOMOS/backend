import { spawn, type ChildProcess } from 'node:child_process';

// 이 에이전트의 연결이 해제됐다(서버 021 — 웹에서 본인·대표가 해제, 조직 탈퇴·해산). 알게 되는 곳이 여러 군데라 한 곳에 모은다:
// 폴링·브리핑·활동 보고 같은 HTTP 응답(NomosClient의 onApiError), 태스크 스트림의 4401 AGENT_DISCONNECTED 종료.
// 알게 되면 실행 중인 Claude(태스크 실행·상담·계약 초안)를 모두 멈춘다 — 해제 뒤에는 무엇을 해도 서버가 받지 않고(401),
// 실행이 끝까지 가면 룸에 "생각 중"만 남았다. 서버는 해제하면서 열린 실행을 이미 닫는다(outcome disconnected) — 그래서 종료 보고도 보내지 않는다.

export const AGENT_DISCONNECTED = 'AGENT_DISCONNECTED';
export const DISCONNECTED_MESSAGE = '이 에이전트의 연결이 해제돼 실행 중인 작업을 멈췄다 — 다시 쓰려면 connect를 실행하라';
// connect·start가 연결 해제로 끝날 때의 종료 코드(0이 아니다 — 스크립트·백그라운드 감시가 정상 종료와 가를 수 있게).
export const DISCONNECTED_EXIT_CODE = 3;

export function isAgentDisconnected(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === AGENT_DISCONNECTED;
}

// 프로세스 전체에서 하나 — 연결 해제는 에이전트 단위라 실행마다 따로 둘 이유가 없다.
export class AgentStop {
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get stopped(): boolean {
    return this.controller.signal.aborted;
  }

  // 에러가 연결 해제면 멈춘다. 멈췄으면 true(이미 멈춘 경우도).
  noteError(err: unknown): boolean {
    if (isAgentDisconnected(err)) this.stop();
    return this.stopped;
  }

  stop(): void {
    if (!this.controller.signal.aborted) this.controller.abort(new Error(DISCONNECTED_MESSAGE));
  }

  // 멈출 때 풀리는 약속 — 대기(waitForChange)와 경주시킨다.
  whenStopped(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => this.controller.signal.addEventListener('abort', () => resolve(), { once: true }));
  }
}

export const agentStop = new AgentStop();

// 자식 프로세스를 트리째 끝낸다. claude는 MCP 서버·Bash 도구(시험 실행 등)를 자식으로 띄운다.
// - Windows: claude를 node로 cli-wrapper를 거쳐 띄우므로(runner.ts의 resolveClaudeCommand) 그 node만 죽이면 실제 claude가 남는다 —
//   taskkill /T(트리) /F로 끝낸다. taskkill을 못 띄우면 직접 kill로 내려간다.
// - 그 밖: SIGTERM을 claude에 보낸다. MCP 서버는 stdin(파이프)이 닫히면 함께 끝난다. 프로세스 그룹째(detached + kill(-pid)) 죽이지 않는 이유:
//   detached로 띄우면 터미널의 Ctrl+C가 claude에 닿지 않아, connect를 끄면 claude가 고아로 남는다.
export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.once('error', () => child.kill());
    return;
  }
  child.kill('SIGTERM');
}

// signal이 멈추면 자식을 트리째 끝낸다. 돌려주는 함수로 구독을 푼다(자식이 먼저 끝나면 부른다).
export function killOnAbort(child: ChildProcess, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {};
  const onAbort = () => killProcessTree(child);
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}
