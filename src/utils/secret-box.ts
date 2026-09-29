import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { env } from '../config/env.js';

// 저장용 암호화. GitHub 토큰처럼 "우리가 다시 써야 하는" 비밀값에만 쓴다.
// 연결 키·refresh 토큰처럼 대조만 하면 되는 값은 여전히 sha256 해시로 저장한다 — 복호화할 이유가 없다.
//
// 형식은 접두사로 구분한다. 나중에 키·알고리즘을 바꿀 때 기존 행을 식별할 수 있어야 한다.
//   kms1.<CiphertextBlob>          운영 — KMS가 직접 암·복호화. 키 원문은 이 프로세스에 들어오지 않는다.
//   v1.<iv>.<tag>.<ciphertext>     로컬 — SECRET_ENCRYPTION_KEY로 AES-256-GCM
// (전부 base64url)
//
// 키 출처 규칙:
//   KMS_KEY_ID가 있으면 KMS만 쓴다. KMS 호출이 실패해도 환경변수 키로 내려가지 않는다 —
//   운영에서 약한 키로 말없이 대체되는 것이 가장 위험한 실패 방식이기 때문이다.
//   KMS_KEY_ID가 없으면 SECRET_ENCRYPTION_KEY로 암호화한다.
//
// KMS를 봉투 암호화(데이터 키)가 아니라 직접 호출로 쓰는 이유: 대상이 GitHub 토큰 몇 개뿐이라 4KB 제한에
// 한참 못 미치고, 복호화 한 번 한 번이 CloudTrail에 남는다. 호출 수는 V3 검사 1회당 1번이다.
const LOCAL_VERSION = 'v1';
const KMS_VERSION = 'kms1';

// 복호화할 때 같은 맥락을 요구한다. 다른 용도로 암호화한 KMS 블롭을 이 경로로 풀 수 없게 묶는다.
const ENCRYPTION_CONTEXT = { purpose: 'nomos-secret' };

// 테스트가 실제 AWS 없이 돌 수 있게 교체 가능하게 둔다. send만 쓴다.
export type KmsLike = { send(command: EncryptCommand | DecryptCommand): Promise<{ CiphertextBlob?: Uint8Array; Plaintext?: Uint8Array }> };

let kms: KmsLike | null = null;

function kmsClient(): KmsLike {
  // 자격 증명은 SDK 기본 체인이 EC2 인스턴스 역할에서 가져온다. 액세스 키를 환경변수에 두지 않는다.
  // 리전은 AWS_REGION에서 읽는다(SDK v3는 인스턴스 메타데이터에서 리전을 추론하지 않는다).
  kms ??= new KMSClient({}) as unknown as KmsLike;
  return kms;
}

// 테스트 전용. 운영 코드에서는 부르지 않는다.
export function setKmsClient(client: KmsLike | null): void {
  kms = client;
}

function localKey(): Buffer {
  if (!env.SECRET_ENCRYPTION_KEY) {
    throw new Error('SECRET_ENCRYPTION_KEY (base64, 32 bytes) or KMS_KEY_ID is required');
  }
  const key = Buffer.from(env.SECRET_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) {
    throw new Error('SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }
  return key;
}

function sealLocal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', localKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [LOCAL_VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function openLocal(parts: string[]): string {
  const [, iv, tag, ciphertext] = parts;
  if (!iv || !tag || !ciphertext) throw new Error('malformed sealed secret');
  const decipher = createDecipheriv('aes-256-gcm', localKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

export async function encryptSecret(plaintext: string): Promise<string> {
  if (!env.KMS_KEY_ID) return sealLocal(plaintext);

  const out = await kmsClient().send(
    new EncryptCommand({
      KeyId: env.KMS_KEY_ID,
      Plaintext: Buffer.from(plaintext, 'utf8'),
      EncryptionContext: ENCRYPTION_CONTEXT,
    }),
  );
  if (!out.CiphertextBlob) throw new Error('KMS Encrypt returned no ciphertext');
  return `${KMS_VERSION}.${Buffer.from(out.CiphertextBlob).toString('base64url')}`;
}

export async function decryptSecret(sealed: string): Promise<string> {
  const parts = sealed.split('.');
  const version = parts[0];

  if (version === KMS_VERSION) {
    const blob = parts[1];
    if (parts.length !== 2 || !blob) throw new Error('malformed sealed secret');
    // KMS로 봉인된 값은 KMS로만 푼다. 설정이 빠졌으면 여기서 멈춘다.
    if (!env.KMS_KEY_ID) throw new Error('secret is KMS-sealed but KMS_KEY_ID is not set');
    const out = await kmsClient().send(
      new DecryptCommand({
        // 대칭 키는 블롭에 키 id가 들어 있지만 명시해서 고정한다 — 다른 키로 봉인된 블롭을 받아주지 않는다.
        KeyId: env.KMS_KEY_ID,
        CiphertextBlob: Buffer.from(blob, 'base64url'),
        EncryptionContext: ENCRYPTION_CONTEXT,
      }),
    );
    if (!out.Plaintext) throw new Error('KMS Decrypt returned no plaintext');
    return Buffer.from(out.Plaintext).toString('utf8');
  }

  if (version === LOCAL_VERSION && parts.length === 4) return openLocal(parts);
  throw new Error('malformed sealed secret');
}
