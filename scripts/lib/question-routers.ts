import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRoutingPrompt, parseRoutingResponse, ROUTING_PROMPT_VERSION, type QuestionRouter, type RoutingDecision, type RoutingInput } from '../../src/domain/question/router.js';
import { resolveClaudeCommand } from '../../src/executor/runner.js';

// 평가 장치용 라우터 구현들. 서버에는 아직 붙이지 않는다 — 여기서 비교해 보고 쓸 만한 것을 router-registry에 연결한다.
// 서버 설정(env)을 import하지 않는다 — 서버 비밀값 없이 노트북에서 돈다.

export type RouterRun = RoutingDecision & { costUsd: number | null };
export type EvalRouter = QuestionRouter & { routeWithCost(input: RoutingInput): Promise<RouterRun> };

// 이 PC의 Claude Code(구독)로 판정만 시킨다. 도구 없이(--tools ""), 빈 MCP로, 빈 폴더에서 —
// 레포 폴더에서 돌리면 CLAUDE.md가 딸려 들어가 판정과 비용이 둘 다 흔들린다.
export function claudeCliRouter(model?: string): EvalRouter {
  const name = `llm:claude-cli${model ? `:${model}` : ''}:${ROUTING_PROMPT_VERSION}`;
  const cwd = path.join(tmpdir(), 'nomos-router-eval');
  mkdirSync(cwd, { recursive: true });
  const emptyMcp = path.join(cwd, 'mcp.json');
  writeFileSync(emptyMcp, JSON.stringify({ mcpServers: {} }));

  const routeWithCost = (input: RoutingInput) =>
    new Promise<RouterRun>((resolve, reject) => {
      const args = ['-p', buildRoutingPrompt(input), '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', emptyMcp, ...(model ? ['--model', model] : [])];
      const { command, commandArgs } = resolveClaudeCommand(args);
      const child = spawn(command, commandArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('close', () => {
        try {
          const result = JSON.parse(out) as { result?: string; total_cost_usd?: number };
          resolve({ ...parseRoutingResponse(result.result ?? '', input, name), costUsd: result.total_cost_usd ?? null });
        } catch (err) {
          reject(new Error(`unparseable router output: ${err instanceof Error ? err.message : String(err)} — ${out.slice(0, 200)}`));
        }
      });
    });
  return { name, routeWithCost, route: routeWithCost };
}

// 외부 결정 모델(Jev 등)을 붙이는 자리. RoutingInput을 JSON으로 POST하고 {target, confidence?, reason?}를 받는다.
// 그쪽 API 형식이 다르면 이 함수만 바꾼다 — 서버·평가 장치는 QuestionRouter만 본다.
export function httpRouter(url: string, name = `http:${new URL(url).host}`): EvalRouter {
  const routeWithCost = async (input: RoutingInput): Promise<RouterRun> => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    if (!res.ok) throw new Error(`${name} returned ${res.status}`);
    return { ...parseRoutingResponse(await res.text(), input, name), costUsd: null };
  };
  return { name, routeWithCost, route: routeWithCost };
}
