import { describe, expect, it } from 'vitest';
import { allowedBashRules, allowedToolNames, buildClaudeArgs, buildMcpConfig } from '../src/bridge/claude-args.js';

const OPTIONS = {
  prompt: '태스크 T-042를 구현하세요',
  mcpConfigPath: 'C:/work/t-042/.nomos-mcp.json',
  cwd: 'C:/work/t-042',
};

describe('MCP 격리', () => {
  it('--mcp-config와 --strict-mcp-config는 항상 함께 간다', () => {
    const args = buildClaudeArgs(OPTIONS);

    expect(args).toContain('--mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe(OPTIONS.mcpConfigPath);
    // 이게 빠지면 사용자의 ~/.claude.json에 등록된 MCP 서버가 함께 로드된다.
    // GitHub MCP가 살아 있으면 submit_artifact를 건너뛰고 직접 push할 수 있어 V3가 무의미해진다.
    expect(args).toContain('--strict-mcp-config');
  });

  it('헤드리스에는 --allowedTools가 반드시 있다', () => {
    const args = buildClaudeArgs(OPTIONS);

    // 없으면 모델이 도구를 고른 뒤 "권한 승인 대기"에서 멈춘다 — -p 모드에는 승인할 사람이 없다.
    // 도구를 못 찾는 것과 증상이 달라서 원인을 찾기 어렵다.
    expect(args).toContain('--allowedTools');
    const allowed = args[args.indexOf('--allowedTools') + 1]!.split(',');
    expect(allowed).toEqual([
      'mcp__nomos__claim_task',
      'mcp__nomos__submit_artifact',
      'mcp__nomos__publish_note',
      'mcp__nomos__read_notes',
      ...allowedBashRules(),
    ]);
  });

  it('파일 편집은 자동 승인(acceptEdits), 셸은 커밋·시험 명령 접두사만 — 임의 셸은 Edit deny를 우회한다', () => {
    const args = buildClaudeArgs(OPTIONS);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    const bash = args[args.indexOf('--allowedTools') + 1]!.split(',').filter((t) => t.startsWith('Bash'));
    expect(bash).toContain('Bash(git commit:*)');
    // 접두사 없는 Bash·와일드카드 Bash는 없다.
    for (const rule of bash) expect(rule, rule).toMatch(/^Bash\([a-z][a-z0-9 -]+:\*\)$/);
  });

  it('도구 이름은 설정의 서버 이름에서 파생된다', () => {
    const serverName = Object.keys(
      JSON.parse(buildMcpConfig({ serverPath: 's.js' })).mcpServers,
    )[0];

    // 설정의 서버 이름과 --allowedTools의 접두사가 갈라지면 조용히 권한이 안 걸린다.
    for (const name of allowedToolNames()) {
      expect(name.startsWith(`mcp__${serverName}__`)).toBe(true);
    }
  });

  it('프롬프트는 -p의 값이고, 가변 인자(--allowedTools)가 맨 뒤다', () => {
    const args = buildClaudeArgs(OPTIONS);

    // 프롬프트를 맨 뒤 위치 인자로 두면 --allowedTools가 도구 이름으로 삼킨다.
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe(OPTIONS.prompt);
    expect(args[args.length - 2]).toBe('--allowedTools');
  });

  it('모델은 주면 붙고 안 주면 빠진다', () => {
    expect(buildClaudeArgs(OPTIONS)).not.toContain('--model');

    const withModel = buildClaudeArgs({ ...OPTIONS, model: 'claude-sonnet-5' });
    expect(withModel[withModel.indexOf('--model') + 1]).toBe('claude-sonnet-5');
  });

  it('설정에는 우리 MCP 서버 하나만 들어가고, 비밀값은 들어가지 않는다', () => {
    const raw = buildMcpConfig({ serverPath: 'C:/nomos/dist/bridge/mcp-server.js' });
    const config = JSON.parse(raw);

    expect(Object.keys(config.mcpServers)).toEqual(['nomos']);
    expect(config.mcpServers.nomos.args).toEqual(['C:/nomos/dist/bridge/mcp-server.js']);

    // 토큰은 ~/.nomos/credentials(0600)에만 둔다. 이 파일은 Claude Code에 넘기는 설정이라 성격이 다르다.
    expect(raw).not.toMatch(/token|TOKEN|secret|SECRET/);
    expect(config.mcpServers.nomos.env).toBeUndefined();
  });
});
