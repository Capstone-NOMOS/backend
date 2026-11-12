// 사람(대표) 계정으로 서버 API를 부르는 HTTP 도우미 — 서버 코드(env.ts·DB)를 거치지 않는다. 에이전트 쪽 nomos-client(bridge)와 달리 사람 토큰이다.
// CLI의 무인 실험 감독(nomos experiment)과 레포 스크립트(question-probe·routing-report·experiment-run, scripts/lib/nomos-http.ts가 다시 내보낸다)가 같이 쓴다.
// 인증: NOMOS_TOKEN(이미 받은 사람 토큰) 또는 --login + NOMOS_PASSWORD(없으면 화면에 안 보이는 입력 창). 토큰·비밀번호는 출력하지 않는다.

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

// 테스트가 가짜를 끼울 수 있게 스크립트 로직은 이 모양만 본다.
export type NomosApi = { call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> };

// 입력한 글자를 화면에 찍지 않는 비밀번호 입력.
export async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error('비밀번호를 입력받을 터미널이 없다 — NOMOS_PASSWORD 또는 NOMOS_TOKEN을 설정하라');
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          reject(new Error('취소했다'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

// 일시적인 실패(연결 끊김·응답 없음·배포 중 502/503/504)에는 GET만 다시 시도한다. POST 등은 서버가 이미 처리했을 수 있어(태스크·기능 명세가 두 번 생긴다) 다시 보내지 않는다 —
// 그런 실패는 감독의 --keep-going이 상태 파일에서 이어 가며 메운다(이미 만든 것은 다시 만들지 않는다).
const TRANSIENT_STATUS = new Set([502, 503, 504]);
const GET_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

export class NomosHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class NomosHttp implements NomosApi {
  private relogin: (() => Promise<void>) | null = null;

  constructor(
    private readonly base: string,
    private token = '',
    private readonly retryDelaysMs: number[] = GET_RETRY_DELAYS_MS,
  ) {}

  setToken(token: string): void {
    this.token = token;
  }

  // 사람 토큰은 24시간이면 만료된다 — 하루 넘게 도는 감독이 그 순간 죽지 않게, 401이면 같은 아이디·비밀번호로 다시 로그인하고 원 요청을 1회 재시도한다.
  // 비밀번호는 이 프로세스 메모리에만 있다(파일·로그에 남기지 않는다).
  setRelogin(relogin: (() => Promise<void>) | null): void {
    this.relogin = relogin;
  }

  async call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    try {
      return await this.callWithRetry<T>(method, path, body);
    } catch (err) {
      if (!(err instanceof NomosHttpError) || err.status !== 401 || !this.relogin || path === '/auth/login') throw err;
      await this.relogin();
      return this.callWithRetry<T>(method, path, body);
    }
  }

  private async callWithRetry<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.once<T>(method, path, body);
      } catch (err) {
        const transient = !(err instanceof NomosHttpError) || TRANSIENT_STATUS.has(err.status);
        const delay = this.retryDelaysMs[attempt];
        if (method !== 'GET' || !transient || delay === undefined) throw err;
        process.stderr.write(`  (일시 오류, ${Math.round(delay / 1000)}초 뒤 다시: ${(err as Error).message.slice(0, 160)})\n`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async once<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // 응답 없이 매달린 연결이 감독을 영원히 붙잡지 않게(감독은 long-poll API를 부르지 않는다).
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // HTML 오류 페이지 등
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      const detail = err?.details ? ` ${JSON.stringify(err.details)}` : '';
      throw new NomosHttpError(res.status, `${method} ${path} → ${res.status} ${err?.code ?? ''} ${err?.message ?? text.slice(0, 200)}${detail}`);
    }
    return (json as { data: T }).data;
  }
}

export async function signIn(api: NomosHttp, loginId: string | undefined): Promise<void> {
  const preset = process.env.NOMOS_TOKEN;
  if (preset) {
    api.setToken(preset); // 받은 토큰은 다시 발급할 수단이 없다 — 만료되면 401로 멈춘다.
    return;
  }
  if (!loginId) throw new Error('--login이 필요하다 (또는 NOMOS_TOKEN)');
  let password = process.env.NOMOS_PASSWORD ?? (await readHidden(`${loginId} 비밀번호: `));
  // 붙여 넣은 명령 끝의 줄바꿈이 입력 창에 그대로 들어가 빈 비밀번호가 나간 일이 있었다(400 VALIDATION_ERROR) — 비었으면 다시 묻는다.
  while (password === '' && process.env.NOMOS_PASSWORD === undefined) password = await readHidden(`비밀번호가 비었다. ${loginId} 비밀번호: `);
  const login = async (): Promise<void> => {
    const auth = await api.call<{ accessToken: string }>('POST', '/auth/login', { loginId, password });
    api.setToken(auth.accessToken);
  };
  await login();
  api.setRelogin(login);
}
