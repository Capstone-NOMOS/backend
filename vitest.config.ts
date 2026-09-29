import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-invariants.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    env: {
      DATABASE_URL: 'postgres://postgres:postgres@localhost:55432/nomos_test',
      LOG_LEVEL: 'error',
      API_BASE_URL: 'http://localhost:3000',
      FRONTEND_BASE_URL: 'http://localhost:5173',
      // 테스트는 setCommitInspector로 구현체를 바꿔 끼운다. 기본값이 없으므로 여기서 고른다.
      COMMIT_INSPECTOR: 'mirror',
      JWT_SECRET: 'test-only-secret-not-for-production-0123456789',
      SECRET_ENCRYPTION_KEY: 'dGVzdC1vbmx5LWVuY3J5cHRpb24ta2V5LTMyYnl0ZXM=',
      GITHUB_CLIENT_ID: 'test-client-id',
    },
    // 통합 테스트가 같은 DB 스키마를 공유하며 TRUNCATE로 서로를 격리하므로 직렬로 실행한다.
    fileParallelism: false,
  },
});
