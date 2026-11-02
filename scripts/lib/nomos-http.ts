// 운영자 노트북의 스크립트가 서버 API를 부르는 HTTP 도우미 — 서버 코드(env.ts·DB)를 거치지 않는다.
// 질문 중계 점검(question-probe)·무인 실험 감독(experiment-run)이 같이 쓴다.
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

export class NomosHttp implements NomosApi {
  constructor(
    private readonly base: string,
    private token = '',
  ) {}

  setToken(token: string): void {
    this.token = token;
  }

  async call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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
      throw new Error(`${method} ${path} → ${res.status} ${err?.code ?? ''} ${err?.message ?? text.slice(0, 200)}${detail}`);
    }
    return (json as { data: T }).data;
  }
}

export async function signIn(api: NomosHttp, loginId: string | undefined): Promise<void> {
  const preset = process.env.NOMOS_TOKEN;
  if (preset) {
    api.setToken(preset);
    return;
  }
  if (!loginId) throw new Error('--login이 필요하다 (또는 NOMOS_TOKEN)');
  const password = process.env.NOMOS_PASSWORD ?? (await readHidden(`${loginId} 비밀번호: `));
  const auth = await api.call<{ accessToken: string }>('POST', '/auth/login', { loginId, password });
  api.setToken(auth.accessToken);
}
