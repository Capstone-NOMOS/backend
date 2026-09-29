import { withTransaction } from '../../config/db.js';
import { AppError } from '../../errors.js';
import { encryptSecret } from '../../utils/secret-box.js';
import { appendEvent } from '../events/append.js';
import { createGithubDeviceApi, DEFAULT_SCOPE, type DeviceCode, type GithubDeviceApi } from './github-device.js';
import { insertOauthSession, linkGithubAccount } from './repository.js';

let defaultApi: GithubDeviceApi = createGithubDeviceApi();

// 테스트가 GitHub에 실제로 닿지 않고 HTTP 경로(라우트 → 서비스)를 돌 수 있게 한다. 운영 코드에서는 부르지 않는다.
// 되돌릴 때 쓰도록 이전 값을 돌려준다.
export function setGithubDeviceApi(next: GithubDeviceApi): GithubDeviceApi {
  const previous = defaultApi;
  defaultApi = next;
  return previous;
}

// device_code는 서버가 보관하지 않고 CLI가 들고 있는다. 보관하면 지울 책임이 생기고,
// 우리 DB가 새면 진행 중인 인증까지 함께 털린다. GitHub device flow가 그렇게 설계돼 있다.
export async function startGithubDeviceFlow(api?: GithubDeviceApi): Promise<DeviceCode> {
  return (api ?? defaultApi).requestDeviceCode(DEFAULT_SCOPE);
}

export type DeviceFlowStatus =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'connected'; githubLogin: string };

// CLI가 interval마다 부른다. 성공하면 GitHub 신원을 계정에 붙이고 토큰을 암호화해 저장한다.
export async function completeGithubDeviceFlow(
  userId: string,
  deviceCode: string,
  apiOverride?: GithubDeviceApi,
): Promise<DeviceFlowStatus> {
  const api = apiOverride ?? defaultApi;
  const result = await api.exchangeDeviceCode(deviceCode);
  if (result.status !== 'ok') return result;

  const viewer = await api.fetchViewer(result.accessToken);
  const scope = result.scope || DEFAULT_SCOPE;
  // 평문 토큰은 여기서 끝난다. 아래로는 암호문만 내려간다.
  // KMS 호출은 네트워크를 탄다 — 트랜잭션을 열기 전에 끝낸다.
  const githubTokenEnc = await encryptSecret(result.accessToken);

  return withTransaction(async (tx) => {
    try {
      await linkGithubAccount(tx, userId, viewer.githubId, viewer.githubLogin);
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505') {
        throw new AppError('GITHUB_ACCOUNT_TAKEN', 'this github account is already linked in your organization');
      }
      throw err;
    }
    await insertOauthSession(tx, { userId, githubTokenEnc, scope, expiresAt: null });

    // payload에 토큰을 절대 넣지 않는다 — events는 지워지지 않는다.
    await appendEvent(tx, {
      orgId: null,
      type: 'GITHUB_LINKED',
      onBehalfOf: userId,
      payload: { userId, githubLogin: viewer.githubLogin, scope },
    });

    return { status: 'connected', githubLogin: viewer.githubLogin };
  });
}
