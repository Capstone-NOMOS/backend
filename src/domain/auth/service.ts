import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { generateSecret, hashSecret, signJwt } from '../../utils/tokens.js';
import { appendEvent } from '../events/append.js';
import { findCredentialsByLoginId, insertUser, updateConnectKeyHash } from '../org/repository.js';

// 사람 토큰은 24시간(기능명세 F-02). 에이전트 토큰(1시간)보다 긴 이유: 사람 토큰에는 권한이 없고
// authenticate가 매 요청 조직·역할을 DB에서 다시 읽으므로, 오래 살아도 옛 권한으로 판정되지 않는다.
// 남는 위험은 탈취된 토큰을 만료 전에 끊을 수 없다는 것 — 로그아웃·강제 만료는 아직 없다(refresh 도입 시 함께).
const USER_ACCESS_TTL_SECONDS = 24 * 60 * 60;

// 없는 아이디일 때도 scrypt를 한 번 돌려 응답 시간으로 아이디 존재 여부가 드러나지 않게 한다.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('nomos-timing-equalizer');
  return dummyHash;
}

export type SignupInput = { loginId: string; password: string; nickname: string };

// 연결 키 평문은 이 반환값에만 존재한다. DB에는 해시만 남으므로 이후 재조회할 방법이 없다.
export async function signup(input: SignupInput): Promise<{ userId: string; connectKey: string }> {
  const passwordHash = await hashPassword(input.password);
  const connectKey = generateSecret();
  const userId = randomUUID();

  await withTransaction(async (tx) => {
    await insertUser(tx, {
      id: userId,
      loginId: input.loginId,
      passwordHash,
      nickname: input.nickname,
      connectKeyHash: hashSecret(connectKey),
    });
    await appendEvent(tx, {
      orgId: null,
      type: 'USER_SIGNED_UP',
      onBehalfOf: userId,
      payload: { userId, loginId: input.loginId },
    });
  });

  return { userId, connectKey };
}

export type LoginResult = { accessToken: string; tokenType: 'Bearer'; expiresIn: number };

// 없는 아이디와 틀린 비밀번호는 같은 에러를 낸다.
// 토큰의 org_role은 참고용이다 — 권한 판정은 매 요청 DB에서 다시 읽는다(auth 미들웨어).
export async function login(input: { loginId: string; password: string }): Promise<LoginResult> {
  const credentials = await findCredentialsByLoginId(pool, input.loginId);
  if (!credentials) {
    await verifyPassword(input.password, await getDummyHash());
    throw new AppError('INVALID_CREDENTIALS', 'invalid login id or password');
  }

  const ok = await verifyPassword(input.password, credentials.passwordHash);
  if (!ok) {
    throw new AppError('INVALID_CREDENTIALS', 'invalid login id or password');
  }

  const { user } = credentials;
  const accessToken = signJwt(
    { sub: user.id, kind: 'user', org_role: user.orgRole },
    USER_ACCESS_TTL_SECONDS,
    env.JWT_SECRET,
  );
  return { accessToken, tokenType: 'Bearer', expiresIn: USER_ACCESS_TTL_SECONDS };
}

// 새 키를 발급하면 기존 키의 해시를 덮어쓰므로 기존 키는 즉시 무효가 된다.
export async function rotateConnectKey(userId: string): Promise<{ connectKey: string }> {
  const connectKey = generateSecret();

  await withTransaction(async (tx) => {
    const user = await updateConnectKeyHash(tx, userId, hashSecret(connectKey));
    if (!user) {
      throw new AppError('UNAUTHENTICATED', 'user not found');
    }
    await appendEvent(tx, {
      orgId: user.orgId,
      type: 'CONNECT_KEY_ROTATED',
      onBehalfOf: user.id,
      payload: { userId: user.id },
    });
  });

  return { connectKey };
}
