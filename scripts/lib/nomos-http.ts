// 운영 서버를 HTTP로만 부르는 실험 스크립트 공용(question-probe·question-harvest). 서버 코드(env.ts·DB)를 거치지 않는다.

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

export class Api {
  constructor(
    private readonly base: string,
    private token = '',
  ) {}

  setToken(token: string): void {
    this.token = token;
  }

  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
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

// 대표 권한으로 로그인한다 — 이미 받은 토큰이 있으면 NOMOS_TOKEN, 비밀번호는 NOMOS_PASSWORD 또는 입력 창(화면에 안 보임).
export async function loginAsRepresentative(api: Api, login: string | undefined, missingLogin: () => never): Promise<void> {
  const presetToken = process.env.NOMOS_TOKEN;
  if (presetToken) {
    api.setToken(presetToken);
    return;
  }
  if (!login) missingLogin();
  const password = process.env.NOMOS_PASSWORD ?? (await readHidden(`${login} 비밀번호: `));
  const auth = await api.call<{ accessToken: string }>('POST', '/auth/login', { loginId: login, password });
  api.setToken(auth.accessToken);
}

export type ProjectDetail = {
  project: { id: string; name: string; status: string; questionRelay: boolean };
  repos: { id: string; fullName: string }[];
  members: { teamRole: string; agentId: string | null; agentName: string | null; userId: string }[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 레포를 id 또는 owner/name으로 찾는다. 이 프로젝트의 레포가 아니면 던진다.
export function findProjectRepo(detail: ProjectDetail, raw: string, flag: string): { id: string; fullName: string } {
  const repo = UUID.test(raw)
    ? detail.repos.find((r) => r.id === raw)
    : detail.repos.find((r) => r.fullName.toLowerCase() === raw.toLowerCase());
  if (!repo) {
    throw new Error(`${flag} ${raw}: 이 프로젝트의 레포가 아니다. 프로젝트 레포: ${detail.repos.map((r) => r.fullName).join(', ') || '(없음)'}`);
  }
  return repo;
}
