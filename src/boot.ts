// 운영 진입점 (도커 ENTRYPOINT). 사용법: node dist/boot.js <server|migrate>
//
// 순서가 핵심이다. 비밀값을 SSM에서 process.env로 적재한 **뒤에** 나머지를 import한다 —
// env.ts는 import 시점에 검증하므로, 위에서 정적으로 import하면 비밀값 없이 검증이 돌아 죽는다.
// 그래서 이 파일은 ssm.ts 말고는 아무것도 정적으로 import하지 않는다(logger도 env를 읽는다).
import { loadParametersFromSsm } from './config/ssm.js';

function say(line: string): void {
  process.stderr.write(`[boot] ${line}\n`);
}

const command = process.argv[2] ?? 'server';

try {
  const ssmPath = process.env.SSM_PARAMETER_PATH;
  if (ssmPath) {
    const names = await loadParametersFromSsm(ssmPath);
    // 이름만 찍는다. 값은 어디에도 남기지 않는다.
    say(`SSM ${ssmPath} 에서 ${names.length}개 적재: ${names.join(', ') || '(없음)'}`);
  } else {
    say('SSM_PARAMETER_PATH 없음 — 환경변수만 사용');
  }

  if (command === 'migrate') {
    const { runMigrations } = await import('./migrate.js');
    await runMigrations();
    // 풀·타이머가 남아 있어도 끝낸다. 배포 스크립트가 종료 코드로 성패를 판단한다.
    process.exit(0);
  } else if (command === 'server') {
    const { startServer } = await import('./server.js');
    await startServer();
  } else {
    say(`알 수 없는 명령: ${command} (server | migrate)`);
    process.exit(2);
  }
} catch (err) {
  say(`기동 실패: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
