import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// argon2·bcrypt는 네이티브 빌드가 필요하고 Windows에서 자주 깨지므로 의존성 없는 scrypt를 쓴다.
const KEY_LENGTH = 64;

function scryptAsync(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// 저장 형식: scrypt$<salt base64>$<key base64>
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

// 형식이 깨진 저장값은 예외 대신 false. timingSafeEqual은 길이가 다르면 던지므로 먼저 길이를 맞춘다.
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  if (expected.length === 0) return false;

  const actual = await scryptAsync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}
