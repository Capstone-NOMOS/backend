import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/utils/password.js';
import { signJwt, verifyJwt } from '../src/utils/tokens.js';

const SECRET = 'unit-test-secret-0123456789-0123456789';

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('JWT', () => {
  it('서명한 토큰을 검증하면 클레임이 돌아온다', () => {
    const token = signJwt({ sub: 'u1', kind: 'user' }, 60, SECRET);
    expect(verifyJwt(token, SECRET)).toMatchObject({ sub: 'u1', kind: 'user' });
  });

  it('다른 비밀키로는 검증되지 않는다', () => {
    const token = signJwt({ sub: 'u1' }, 60, SECRET);
    expect(verifyJwt(token, `${SECRET}-other`)).toBeNull();
  });

  it('payload를 바꿔치기하면 검증되지 않는다', () => {
    const [header, , sig] = signJwt({ sub: 'u1', kind: 'agent' }, 60, SECRET).split('.');
    const forged = `${header}.${b64url({ sub: 'u1', kind: 'user', iat: 0, exp: 9999999999 })}.${sig}`;
    expect(verifyJwt(forged, SECRET)).toBeNull();
  });

  it('alg:none 토큰은 거부한다', () => {
    const token = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: 'u1', iat: 0, exp: 9999999999 })}.`;
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it('만료된 토큰은 거부한다', () => {
    const issuedAt = Date.now();
    const token = signJwt({ sub: 'u1' }, 60, SECRET, issuedAt);
    expect(verifyJwt(token, SECRET, issuedAt + 59_000)).not.toBeNull();
    expect(verifyJwt(token, SECRET, issuedAt + 61_000)).toBeNull();
  });

  it('형식이 깨진 입력에도 던지지 않는다', () => {
    expect(verifyJwt('', SECRET)).toBeNull();
    expect(verifyJwt('a.b', SECRET)).toBeNull();
    expect(verifyJwt('a.b.c.d', SECRET)).toBeNull();
  });
});

describe('scrypt 비밀번호', () => {
  it('맞는 비밀번호만 통과한다', async () => {
    const stored = await hashPassword('s3cret-pass');
    expect(await verifyPassword('s3cret-pass', stored)).toBe(true);
    expect(await verifyPassword('s3cret-pasS', stored)).toBe(false);
  });

  it('같은 비밀번호도 salt 때문에 매번 다르게 저장된다', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('형식이 깨진 저장값은 예외 대신 false', async () => {
    expect(await verifyPassword('x', 'bcrypt$abc$def')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$onlysalt')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });
});
