import { startServer } from './server.js';

// 로컬 개발 진입점(npm run dev). .env는 env.ts가 읽는다. 운영은 boot.ts를 쓴다.
await startServer();
