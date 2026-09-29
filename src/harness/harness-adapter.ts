import type { ChildProcess } from 'node:child_process';

// 인터페이스만. 구현(ClaudeCodeAdapter 등)은 브릿지 착수 시점에.
// 하네스별 차이(실행 방법·스트림 형식·비용 위치)를 브릿지 본체에서 떼어내는 경계다.
// Claude Code에 대해 알려진 사실은 docs/harness-claude-code.md.

export type HarnessEvent = {
  kind: 'text' | 'tool_use' | 'tool_result' | 'result' | 'other';
  raw: unknown;
};

export abstract class HarnessAdapter {
  abstract readonly id: string;

  // 'CLAUDE.md' | 'AGENTS.md'
  abstract constitutionFilename(): string;

  abstract spawn(prompt: string, workdir: string): ChildProcess;

  // 한 줄을 받아 이벤트로. 빈 줄·파싱 불가 줄은 null.
  abstract parseStream(line: string): HarnessEvent | null;

  // 비용이 실린 이벤트가 아니면 null.
  abstract extractCost(ev: HarnessEvent): number | null;

  abstract mcpConfig(serverUrl: string, token: string): object;
}
