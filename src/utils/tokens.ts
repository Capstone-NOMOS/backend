import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// 연결 키·refresh token처럼 사람이 아니라 기계가 쓰는 비밀값.
export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

// 무작위 32바이트라 느린 해시가 필요 없다. 오히려 결정적이어야 해시로 행을 찾을 수 있다
// (salt를 넣는 scrypt로는 connect_key_hash 유니크 인덱스 조회가 불가능하다).
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

// ── JWT (HS256) ─────────────────────────────────────────────────────────────

// 헤더는 우리가 발급하는 이 한 가지뿐이다. 검증 때 바이트 단위로 비교해
// alg:none이나 다른 알고리즘으로 바꿔치기한 토큰을 파싱 전에 버린다.
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

export type JwtClaims = Record<string, unknown> & { iat: number; exp: number };

function signature(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

export function signJwt(
  claims: Record<string, unknown>,
  ttlSeconds: number,
  secret: string,
  nowMs: number = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const payload = Buffer.from(JSON.stringify({ ...claims, iat, exp: iat + ttlSeconds })).toString('base64url');
  const signingInput = `${HEADER}.${payload}`;
  return `${signingInput}.${signature(signingInput, secret)}`;
}

// 서명·헤더·만료 중 하나라도 어긋나면 null. 형식이 깨진 입력에도 던지지 않는다.
export function verifyJwt(token: string, secret: string, nowMs: number = Date.now()): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  if (header !== HEADER) return null;

  const expected = Buffer.from(signature(`${header}.${payload}`, secret));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null) return null;

  const { iat, exp } = claims as { iat?: unknown; exp?: unknown };
  if (typeof iat !== 'number' || typeof exp !== 'number') return null;
  if (Math.floor(nowMs / 1000) >= exp) return null;

  return claims as JwtClaims;
}
