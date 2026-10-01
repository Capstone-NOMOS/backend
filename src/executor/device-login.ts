import { spawn } from 'node:child_process';
import type { Credentials } from '../bridge/credentials.js';

// executor login의 기본 경로 — 브라우저 승인(device flow, RFC 8628). gh auth login·vercel login과 같은 모양이다.
// CLI가 코드를 띄우고 브라우저를 열면, 사용자는 이미 로그인된 NOMOS 웹에서 승인만 누른다. 연결 키를 복사·붙여넣지 않는다.
// 테스트할 수 있게 fetch·브라우저 열기·기다리기를 바깥에서 받는다.

export type DeviceLoginDeps = {
  baseUrl: string;
  agentName: string;
  fetchImpl?: typeof fetch;
  openUrl?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  out?: (line: string) => void;
};

export type DeviceLoginResult = {
  credentials: Credentials;
  account: { loginId: string | null; nickname: string | null; orgName: string | null };
};

export class DeviceLoginError extends Error {}

type Envelope = { data?: Record<string, unknown>; error?: { code?: string; message?: string } };

async function post(fetchImpl: typeof fetch, url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Envelope;
  if (!res.ok || !json.data) {
    throw new DeviceLoginError(`${res.status} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`.trim());
  }
  return json.data;
}

// 브라우저 열기. shell을 쓰지 않는다(Windows에서 shell: true면 URL의 & 등이 명령으로 해석된다 — runner.ts와 같은 이유).
// 실패해도 괜찮다 — 출력한 주소를 사용자가 직접 연다.
export function openInBrowser(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

export async function deviceLogin(deps: DeviceLoginDeps): Promise<DeviceLoginResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const openUrl = deps.openUrl ?? openInBrowser;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));

  const started = await post(fetchImpl, `${deps.baseUrl}/api/agents/device/start`, {
    agentName: deps.agentName,
    harness: 'claude-code',
    skills: [],
    maxConcurrent: 2,
  });
  const deviceCode = String(started.deviceCode);
  const complete = String(started.verificationUriComplete);
  let intervalSec = Number(started.interval) || 5;
  const deadline = Date.now() + (Number(started.expiresIn) || 600) * 1000;

  out(`브라우저에서 승인하세요: ${complete}`);
  out(`코드: ${String(started.userCode)}   (웹 화면의 코드와 같은지 확인하세요)`);
  if (!(await openUrl(complete))) out('브라우저를 열지 못했습니다 — 위 주소를 직접 여세요.');

  while (Date.now() < deadline) {
    await sleep(intervalSec * 1000);
    const polled = await post(fetchImpl, `${deps.baseUrl}/api/agents/device/poll`, { deviceCode });
    switch (polled.status) {
      case 'pending':
        continue;
      case 'slow_down':
        intervalSec = Number(polled.interval) || intervalSec + 5;
        continue;
      case 'denied':
        throw new DeviceLoginError('승인이 거부됐습니다. 직접 실행한 게 맞다면 login을 다시 실행하세요.');
      case 'expired':
        throw new DeviceLoginError('코드가 만료됐습니다(10분). login을 다시 실행하세요.');
      case 'approved':
        return {
          credentials: {
            baseUrl: deps.baseUrl,
            accessToken: String(polled.accessToken),
            refreshToken: String(polled.refreshToken),
            agentId: String(polled.agentId),
          },
          account: polled.account as DeviceLoginResult['account'],
        };
      default:
        throw new DeviceLoginError(`알 수 없는 응답: ${JSON.stringify(polled)}`);
    }
  }
  throw new DeviceLoginError('코드가 만료됐습니다(10분). login을 다시 실행하세요.');
}
