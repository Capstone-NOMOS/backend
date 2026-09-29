import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';

// env.ts가 .env를 직접 읽게 만든 뒤, 그 로딩이 테스트를 오염시키지 않는다는 것을 고정한다.
// 이 파일이 깨지면 "테스트가 개발 DB를 TRUNCATE한다"는 사고로 이어진다.
describe('환경변수 로딩', () => {
  it('테스트는 항상 테스트 DB를 쓴다 — .env의 개발 DB가 아니다', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(env.DATABASE_URL).toContain('nomos_test');
    expect(env.DATABASE_URL).not.toMatch(/\/nomos_dev$/);
  });

  it('.env 전용 값이 테스트로 새지 않는다', () => {
    // vitest.config.ts의 test.env가 주지 않는 값은 undefined여야 한다.
    // 새면 GitHub 호출이 실제로 나가고, 테스트가 네트워크에 의존하게 된다.
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.KMS_KEY_ID).toBeUndefined();
  });

  it('테스트 환경에도 서명·암호화 키는 주어진다', () => {
    expect(env.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(env.SECRET_ENCRYPTION_KEY).toBeDefined();
  });
});
