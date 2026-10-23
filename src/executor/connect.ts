import type { Credentials } from '../bridge/credentials.js';

// nomos connect — 웹 안내 한 줄(npx @capstone-nomos/cli connect)로 끝까지 가게 한다.
//   웹이 준 1회용 코드(--code) → 저장된 자격 증명을 보지 않고 그 코드의 계정으로 연결(서버 024)
//   자격 증명 없음·다른 서버 것·더 이상 안 통함 → 브라우저 승인 로그인
//   저장된 자격 증명 재사용 → 어느 계정으로 붙었는지 반드시 출력(예전 계정으로 조용히 붙던 문제)
//   프로젝트 배정 전 → 안내하고 주기적으로 토큰을 재발급해 배정을 확인(사람이 하던 executor refresh를 자동으로)
//   배정됨 → 호출부가 start(폴링)로 넘어간다
// 테스트할 수 있게 입출력은 전부 바깥에서 받는다.

export const DEFAULT_SERVER = 'https://nomos-team.duckdns.org';

export type AgentSelf = { projectId: string; teamRole: string | null; maxConcurrent: number };
export type AgentAccount = { agentName: string; loginId: string | null; nickname: string | null; orgName: string | null };

export function accountLine(a: { loginId: string | null; nickname: string | null; orgName: string | null }, agentName: string): string {
  return `${a.nickname ?? a.loginId ?? '?'} (${a.loginId ?? '?'})${a.orgName ? ` · 조직 ${a.orgName}` : ' · 조직 없음'} — 에이전트 ${agentName}`;
}

export type ConnectDeps = {
  server: string;
  agentName: string;
  readCredentials: () => Credentials | null;
  login: () => Promise<void>;
  // 웹의 연결 명령에 실린 1회용 코드로 연결한다. 있으면 저장된 자격 증명을 보지 않는다.
  codeLogin?: () => Promise<void>;
  // 저장된 자격 증명의 주인 계정. 옛 서버(024 전)면 null.
  account?: () => Promise<AgentAccount | null>;
  // 재발급. 서버가 refresh token을 거부하면(지워진 에이전트·다른 DB) 'rejected', 네트워크 오류 등은 throw.
  refresh: () => Promise<'ok' | 'rejected'>;
  // 배정 전이면 null.
  describeSelf: () => Promise<AgentSelf | null>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  intervalMs?: number;
};

export async function connect(deps: ConnectDeps): Promise<AgentSelf> {
  const current = deps.readCredentials();
  if (deps.codeLogin) {
    await deps.codeLogin();
  } else if (!current || current.baseUrl !== deps.server) {
    if (current) deps.log(`기존 자격 증명(${current.baseUrl})을 ${deps.server}용으로 교체한다`);
    await deps.login();
  } else if ((await deps.refresh()) === 'rejected') {
    deps.log('저장된 자격 증명이 더 이상 통하지 않는다 — 다시 로그인한다');
    await deps.login();
  } else {
    // 재사용하는 자격 증명이 누구 것인지 보여 준다 — 같은 노트북에서 계정을 바꾸면 예전 계정으로 붙었다(통합 테스트).
    const account = await deps.account?.().catch(() => null);
    if (account) {
      deps.log(`연결됨: ${accountLine(account, account.agentName)} (저장된 자격 증명)`);
      deps.log('다른 계정으로 연결하려면 웹의 "에이전트 연결"에서 받은 명령(--code)을 실행하라');
    }
  }

  let announced = false;
  for (;;) {
    const self = await deps.describeSelf();
    if (self) {
      deps.log(`배정 확인 — 프로젝트 ${self.projectId}, 역할 ${self.teamRole ?? '없음'}`);
      return self;
    }
    if (!announced) {
      deps.log(`아직 프로젝트에 배정되지 않았다. 대표에게 에이전트 "${deps.agentName}"의 배정을 요청하라.`);
      deps.log('배정되면 자동으로 시작한다 — 이 창을 켜 두면 된다 (Ctrl+C로 종료)');
      announced = true;
    }
    await deps.sleep(deps.intervalMs ?? 15_000);
    // 배정 전에 받은 토큰에는 project_id가 없다. 재발급해야 배정이 토큰에 실린다.
    if ((await deps.refresh()) === 'rejected') {
      deps.log('자격 증명이 거부됐다 — 다시 로그인한다');
      await deps.login();
    }
  }
}

// 실제 서버 호출. 자격 증명 저장소를 받아 테스트가 파일 대신 메모리를 쓴다.
export type CredentialStore = { read: () => Credentials | null; updateAccessToken: (token: string) => void };

export function serverCalls(store: CredentialStore, fetchImpl: typeof fetch = fetch) {
  return {
    // 4xx는 "이 자격 증명은 더 이상 안 통한다"(지워진 에이전트·다른 서버 DB) — 다시 로그인할 일이다. 5xx·네트워크 오류는 throw.
    async refresh(): Promise<'ok' | 'rejected'> {
      const credentials = store.read();
      if (!credentials) return 'rejected';
      const res = await fetchImpl(`${credentials.baseUrl}/api/agents/token/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: credentials.refreshToken }),
      });
      if (res.status >= 400 && res.status < 500) return 'rejected';
      const json = (await res.json().catch(() => ({}))) as { data?: { accessToken?: string } };
      if (!res.ok || !json.data?.accessToken) throw new Error(`토큰 재발급 실패: ${res.status}`);
      store.updateAccessToken(json.data.accessToken);
      return 'ok';
    },
    // 이 자격 증명의 주인 계정(서버 024). 옛 서버면 404 — null.
    async account(): Promise<AgentAccount | null> {
      const credentials = store.read();
      if (!credentials) return null;
      const res = await fetchImpl(`${credentials.baseUrl}/api/agents/me/account`, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      });
      if (!res.ok) return null;
      const json = (await res.json().catch(() => ({}))) as { data?: AgentAccount };
      return json.data ?? null;
    },
    // 방금 재발급한 토큰으로 묻는다. 배정 전이면 서버가 403 NOT_PROJECT_MEMBER — null.
    async describeSelf(): Promise<AgentSelf | null> {
      const credentials = store.read();
      if (!credentials) throw new Error('자격 증명이 없다');
      const res = await fetchImpl(`${credentials.baseUrl}/api/agents/me`, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      });
      const json = (await res.json().catch(() => ({}))) as { data?: AgentSelf; error?: { code?: string; message?: string } };
      if (res.status === 403 && json.error?.code === 'NOT_PROJECT_MEMBER') return null;
      if (!res.ok || !json.data) throw new Error(`${res.status} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`.trim());
      return json.data;
    },
  };
}
