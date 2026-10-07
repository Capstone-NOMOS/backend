import { rmSync } from 'node:fs';

// 뒷정리용 삭제. Windows에서는 자식 프로세스(claude·vitest)가 끝난 직후에도 폴더가 잠깐 잠겨 있어 EBUSY가 난다.
// Node의 재시도 옵션으로 잠시 기다렸다 다시 지우고, 그래도 못 지우면 경고만 남기고 넘어간다 —
// finally에서 던지면 이미 받아 둔 결과(PM 초안·검증 보고)를 오류가 덮는다(pm-worker에서 실제로 그랬다).
export function removeQuietly(dir: string, warn: (line: string) => void = defaultWarn): boolean {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return true;
  } catch (err) {
    warn(`임시 폴더를 지우지 못했습니다(남겨 둠): ${dir} — ${(err as Error).message}`);
    return false;
  }
}

// stdout은 MCP 서버에서 JSON-RPC 전용이라 경고는 stderr로 쓴다.
function defaultWarn(line: string): void {
  process.stderr.write(`[nomos] 경고: ${line}\n`);
}
