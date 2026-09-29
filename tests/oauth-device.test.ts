import { EncryptCommand } from '@aws-sdk/client-kms';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import type { GithubDeviceApi } from '../src/domain/oauth/github-device.js';
import { completeGithubDeviceFlow, startGithubDeviceFlow } from '../src/domain/oauth/service.js';
import { decryptSecret, encryptSecret, setKmsClient, type KmsLike } from '../src/utils/secret-box.js';
import { createTestOrg, createTestUser } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

beforeAll(async () => {
  await resetSchema();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await pool.end();
  await testPool.end();
});

const ACCESS_TOKEN = 'gho_secret_token_value';

function stubApi(over: Partial<GithubDeviceApi> = {}): GithubDeviceApi {
  return {
    requestDeviceCode: async (scope) => ({
      deviceCode: 'dev-code',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
      scope,
    }),
    exchangeDeviceCode: async () => ({ status: 'ok', accessToken: ACCESS_TOKEN, scope: 'repo read:org' }),
    fetchViewer: async () => ({ githubId: 4242, githubLogin: 'minsu' }),
    ...over,
  };
}

describe('secret-box', () => {
  it('암호화한 값을 되돌릴 수 있고, 같은 평문도 매번 다른 암호문이 된다', async () => {
    const a = await encryptSecret(ACCESS_TOKEN);
    const b = await encryptSecret(ACCESS_TOKEN);

    expect(a).not.toBe(b); // iv가 매번 다르다 — 같으면 같은 토큰을 쓰는 사용자가 드러난다
    expect(await decryptSecret(a)).toBe(ACCESS_TOKEN);
    expect(a.startsWith('v1.')).toBe(true);
    expect(a).not.toContain(ACCESS_TOKEN);
  });

  it('암호문을 한 글자라도 고치면 복호화가 실패한다', async () => {
    const sealed = await encryptSecret(ACCESS_TOKEN);
    const [v, iv, tag, cipher] = sealed.split('.');
    const flipped = `${cipher!.slice(0, -2)}${cipher!.slice(-2) === 'AA' ? 'AB' : 'AA'}`;

    await expect(decryptSecret([v, iv, tag, flipped].join('.'))).rejects.toThrow();
    await expect(decryptSecret('not-sealed')).rejects.toThrow(/malformed/);
  });
});

// KMS 경로. 실제 AWS 없이 send만 흉내 낸다 — 확인할 것은 "무엇을 KMS에 넘기는가"와
// "실패하면 환경변수 키로 내려가지 않는가"다. 테스트 env에는 SECRET_ENCRYPTION_KEY가 있으므로
// 폴백이 일어나면 v1.로 시작하는 값이 나와 바로 드러난다.
describe('secret-box — KMS', () => {
  const KEY_ID = 'arn:aws:kms:ap-northeast-2:111122223333:key/test';
  type Sent = { name: string; input: Record<string, unknown> };
  let sent: Sent[];

  function fakeKms(options: { fail?: boolean } = {}): KmsLike {
    return {
      async send(command) {
        const input = command.input as Record<string, unknown>;
        sent.push({ name: command.constructor.name, input });
        if (options.fail) throw new Error('AccessDeniedException');
        if (command instanceof EncryptCommand) {
          // 되돌릴 수 있는 가짜 암호문. 평문이 그대로 보이지 않게만 한다.
          const plain = Buffer.from(input.Plaintext as Uint8Array);
          return { CiphertextBlob: Buffer.concat([Buffer.from('FAKE'), Buffer.from(plain.toString('base64'))]) };
        }
        const blob = Buffer.from(input.CiphertextBlob as Uint8Array).toString();
        return { Plaintext: Buffer.from(blob.slice(4), 'base64') };
      },
    };
  }

  beforeEach(() => {
    sent = [];
    env.KMS_KEY_ID = KEY_ID;
  });

  afterEach(() => {
    delete env.KMS_KEY_ID;
    setKmsClient(null);
  });

  it('KMS_KEY_ID가 있으면 KMS로 봉인하고 같은 키·맥락으로만 푼다', async () => {
    setKmsClient(fakeKms());

    const sealed = await encryptSecret(ACCESS_TOKEN);
    expect(sealed.startsWith('kms1.')).toBe(true);
    expect(sealed).not.toContain(ACCESS_TOKEN);
    expect(await decryptSecret(sealed)).toBe(ACCESS_TOKEN);

    expect(sent.map((s) => s.name)).toEqual(['EncryptCommand', 'DecryptCommand']);
    for (const s of sent) {
      expect(s.input).toMatchObject({ KeyId: KEY_ID, EncryptionContext: { purpose: 'nomos-secret' } });
    }
  });

  it('KMS 호출이 실패하면 환경변수 키로 내려가지 않고 실패한다', async () => {
    setKmsClient(fakeKms({ fail: true }));

    await expect(encryptSecret(ACCESS_TOKEN)).rejects.toThrow(/AccessDenied/);
    await expect(decryptSecret('kms1.AAAA')).rejects.toThrow(/AccessDenied/);
  });

  it('KMS로 봉인된 값을 KMS 설정 없이 풀려 하면 실패한다', async () => {
    setKmsClient(fakeKms());
    const sealed = await encryptSecret(ACCESS_TOKEN);
    delete env.KMS_KEY_ID;

    await expect(decryptSecret(sealed)).rejects.toThrow(/KMS_KEY_ID is not set/);
  });
});

describe('GitHub Device Flow', () => {
  it('사용자 코드와 인증 URL을 돌려준다', async () => {
    const code = await startGithubDeviceFlow(stubApi());
    expect(code).toMatchObject({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
  });

  it('승인 전에는 pending을 그대로 전달한다', async () => {
    const { userId } = await createTestOrg('rep');
    const result = await completeGithubDeviceFlow(userId, 'dev-code', stubApi({
      exchangeDeviceCode: async () => ({ status: 'pending' }),
    }));

    expect(result).toEqual({ status: 'pending' });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM oauth_sessions`);
    expect(rows[0]!.n).toBe(0);
  });

  it('만료·거부도 에러가 아니라 상태로 전달한다', async () => {
    const { userId } = await createTestOrg('rep');

    expect(
      await completeGithubDeviceFlow(userId, 'dev-code', stubApi({ exchangeDeviceCode: async () => ({ status: 'expired' }) })),
    ).toEqual({ status: 'expired' });
    expect(
      await completeGithubDeviceFlow(userId, 'dev-code', stubApi({ exchangeDeviceCode: async () => ({ status: 'denied' }) })),
    ).toEqual({ status: 'denied' });
  });

  it('승인되면 계정에 GitHub 신원을 붙이고 토큰을 암호화해 저장한다', async () => {
    const { userId } = await createTestOrg('rep');

    const result = await completeGithubDeviceFlow(userId, 'dev-code', stubApi());
    expect(result).toEqual({ status: 'connected', githubLogin: 'minsu' });

    const user = await pool.query(`SELECT github_id, github_login FROM users WHERE id = $1`, [userId]);
    expect(user.rows[0]).toEqual({ github_id: '4242', github_login: 'minsu' });

    const session = await pool.query(`SELECT github_token_enc, scope FROM oauth_sessions WHERE user_id = $1`, [userId]);
    const stored = session.rows[0]!.github_token_enc as string;
    expect(stored).not.toContain(ACCESS_TOKEN); // 평문이 DB에 남으면 안 된다
    expect(await decryptSecret(stored)).toBe(ACCESS_TOKEN);
    expect(session.rows[0]!.scope).toBe('repo read:org');
  });

  it('이벤트에 토큰이 새지 않는다', async () => {
    const { userId } = await createTestOrg('rep');
    await completeGithubDeviceFlow(userId, 'dev-code', stubApi());

    const { rows } = await pool.query(`SELECT payload FROM events WHERE type = 'GITHUB_LINKED'`);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.payload)).not.toContain(ACCESS_TOKEN);
    expect(rows[0]!.payload).toMatchObject({ githubLogin: 'minsu' });
  });

  it('같은 조직에서 같은 GitHub 계정을 두 번 붙일 수 없다', async () => {
    const { userId, orgId } = await createTestOrg('rep');
    const second = await createTestUser('member');
    await pool.query(`UPDATE users SET org_id = $2 WHERE id = $1`, [second, orgId]);

    await completeGithubDeviceFlow(userId, 'dev-code', stubApi());

    await expect(completeGithubDeviceFlow(second, 'dev-code', stubApi())).rejects.toMatchObject({
      code: 'GITHUB_ACCOUNT_TAKEN',
      status: 409,
    });
  });
});
