// 헤드리스 Claude Code를 띄울 때의 인자. 순수 함수로 둔 이유는 MCP 격리가
// "플래그 하나 빠지면 조용히 무너지는" 종류의 설정이기 때문이다 — 테스트로 고정한다.

// MCP 설정에 쓰는 서버 이름. 도구의 전체 이름이 여기서 파생되므로 한 곳에만 둔다.
export const MCP_SERVER_NAME = 'nomos';

// 서버가 노출하는 도구. Claude Code에서는 mcp__<서버명>__<도구명> 형태로 불린다.
export const NOMOS_TOOLS = ['claim_task', 'submit_artifact', 'publish_note', 'read_notes'] as const;

export function allowedToolNames(): string[] {
  return NOMOS_TOOLS.map((tool) => `mcp__${MCP_SERVER_NAME}__${tool}`);
}

export type ClaudeRunOptions = {
  prompt: string;
  mcpConfigPath: string;
  // 태스크마다 다른 작업공간. settings.json은 브릿지가 여기에 깔아둔다.
  cwd: string;
  model?: string;
};

// --strict-mcp-config가 없으면 사용자의 ~/.claude.json에 등록된 MCP 서버가 함께 로드된다.
// GitHub MCP가 살아 있으면 에이전트가 submit_artifact를 건너뛰고 직접 push할 수 있고,
// 그러면 제출 시점 경로 검증(V3)이 아무것도 못 막는다. 두 플래그는 항상 함께 간다.
export function buildClaudeArgs(options: ClaudeRunOptions): string[] {
  // 프롬프트는 반드시 -p의 **값**으로 준다. 맨 뒤에 위치 인자로 붙이면
  // --allowedTools가 가변 인자라 프롬프트를 도구 이름으로 삼켜버리고,
  // claude는 "Input must be provided…"로 죽는다 (실제로 겪었다).
  const args = ['-p', options.prompt, '--output-format', 'stream-json', '--verbose'];
  if (options.model) args.push('--model', options.model);
  args.push('--mcp-config', options.mcpConfigPath, '--strict-mcp-config');
  // 파일 편집은 작업 폴더 안에서 자동 승인한다 — settings.json의 deny(.env·contracts 등)는 여전히 이긴다.
  // 없으면 모델이 계획만 세우고 "쓰기 권한을 승인해 달라"며 커밋 없이 끝난다(실제로 그랬다).
  args.push('--permission-mode', 'acceptEdits');
  // 헤드리스에는 권한 프롬프트에 답할 사람이 없다. 이게 없으면 모델이 도구를 고른 뒤
  // "승인 대기"에서 멈춘다 — 도구를 못 찾는 것과 증상이 달라 헷갈리기 쉽다.
  // 가변 인자를 마지막에 두어 뒤에 아무것도 붙지 않게 한다.
  args.push('--allowedTools', [...allowedToolNames(), ...allowedBashRules()].join(','));
  return args;
}

// 작업에 필요한 셸 명령만 접두사로 허용한다(커밋·시험 실행). **임의 셸을 열지 말 것** — 셸로 파일을 쓰면
// settings.json의 Edit deny(.env·contracts 등)를 우회한다. 서버의 제출 검증(V3)이 최종 방어선이지만 로컬에서 먼저 막는다.
export const ALLOWED_BASH_PREFIXES = [
  'git status',
  'git diff',
  'git add',
  'git commit',
  'git log',
  'git rev-parse',
  'npm test',
  'npm run test',
  'npx vitest',
  'node --test',
] as const;

export function allowedBashRules(): string[] {
  return ALLOWED_BASH_PREFIXES.map((prefix) => `Bash(${prefix}:*)`);
}

// 우리 MCP 서버 하나만 담은 설정. --mcp-config로 넘긴다.
//
// **토큰을 여기 넣지 않는다.** 이 파일은 Claude Code에 넘기는 설정이고, 자격 증명의 정본은
// ~/.nomos/credentials다(0600). 예전에는 env에 평문으로 박았는데, 재발급된 토큰을 되돌려 쓸 곳이 없어
// 매 실행이 401 한 번을 먹고 시작했다.
//
// workspaceDir은 submit_artifact가 push할 작업공간이다. MCP 서버의 cwd가 작업공간이라는 보장이 없으므로
// 명시한다(경로일 뿐 비밀값이 아니다). 없으면 MCP 서버는 자기 cwd를 쓴다 — 수동 테스트용.
export function buildMcpConfig(input: { serverPath: string; nodePath?: string; workspaceDir?: string }): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: input.nodePath ?? process.execPath,
          args: [input.serverPath],
          ...(input.workspaceDir === undefined ? {} : { env: { NOMOS_WORKSPACE_DIR: input.workspaceDir } }),
        },
      },
    },
    null,
    2,
  );
}
