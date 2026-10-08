import { env } from '../../config/env.js';
import { AppError } from '../../errors.js';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const VIEWER_URL = 'https://api.github.com/user';

// 대표 토큰은 collaborator 확인·V3 커밋 읽기에 더해 GitHub 조직에 레포 만들기·협업자 초대까지 쓴다(대표 결정, rep-api.ts).
// repo가 그 전부를 덮으므로 스코프는 그대로다. 더 넓히면(delete_repo·admin:org) 그만큼 탈취 피해가 커진다 — 넓히지 말 것.
export const DEFAULT_SCOPE = 'repo read:org';

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type DeviceToken =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'ok'; accessToken: string; scope: string };

export type GithubViewer = { githubId: number; githubLogin: string };

export type GithubDeviceApi = {
  requestDeviceCode(scope: string): Promise<DeviceCode>;
  exchangeDeviceCode(deviceCode: string): Promise<DeviceToken>;
  fetchViewer(accessToken: string): Promise<GithubViewer>;
};

function clientId(): string {
  if (!env.GITHUB_CLIENT_ID) {
    throw new AppError('GITHUB_UNAVAILABLE', 'github oauth is not configured');
  }
  return env.GITHUB_CLIENT_ID;
}

// fetch를 주입받는다 — 테스트가 실제 GitHub를 때리지 않게 하기 위해서다.
export function createGithubDeviceApi(fetchImpl: typeof fetch = fetch): GithubDeviceApi {
  async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) {
      throw new AppError('GITHUB_UNAVAILABLE', `github returned ${res.status}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  return {
    async requestDeviceCode(scope) {
      const json = await postForm(DEVICE_CODE_URL, { client_id: clientId(), scope });
      return {
        deviceCode: String(json.device_code),
        userCode: String(json.user_code),
        verificationUri: String(json.verification_uri),
        expiresIn: Number(json.expires_in ?? 900),
        interval: Number(json.interval ?? 5),
      };
    },

    async exchangeDeviceCode(deviceCode) {
      const body: Record<string, string> = {
        client_id: clientId(),
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      };
      // OAuth App의 device flow는 secret이 필수가 아니다. 설정된 경우에만 붙인다.
      if (env.GITHUB_CLIENT_SECRET) body.client_secret = env.GITHUB_CLIENT_SECRET;

      const json = await postForm(TOKEN_URL, body);
      if (typeof json.access_token === 'string') {
        return { status: 'ok', accessToken: json.access_token, scope: String(json.scope ?? '') };
      }
      switch (json.error) {
        case 'authorization_pending':
          return { status: 'pending' };
        case 'slow_down':
          return { status: 'slow_down', interval: Number(json.interval ?? 10) };
        case 'expired_token':
          return { status: 'expired' };
        case 'access_denied':
          return { status: 'denied' };
        default:
          throw new AppError('GITHUB_UNAVAILABLE', `unexpected device flow response: ${String(json.error)}`);
      }
    },

    async fetchViewer(accessToken) {
      const res = await fetchImpl(VIEWER_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!res.ok) {
        throw new AppError('GITHUB_UNAVAILABLE', `github returned ${res.status}`);
      }
      const json = (await res.json()) as { id: number; login: string };
      return { githubId: json.id, githubLogin: json.login };
    },
  };
}
