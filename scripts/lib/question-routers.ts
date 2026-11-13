import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRoutingPrompt, parseRoutingResponse, ROUTING_PROMPT_VERSION, type QuestionRouter, type RoutingDecision, type RoutingInput } from '../../src/domain/question/router.js';
import { resolveClaudeCommand } from '../../src/executor/runner.js';
import { jevQuestionRouter } from '../../src/domain/question/jev-router.js';
import { openAiQuestionRouter } from '../../src/domain/question/openai-router.js';
import { anthropicModel } from '../../src/domain/pm/anthropic-model.js';
import { routeWithLlm } from '../../src/domain/question/llm-route-call.js';

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
          const result = JSON.parse(out) as { result?: string; total_cost_usd?: number; duration_api_ms?: number };
          // 판정 시간 = Claude Code가 모델 API 호출에 쓴 시간(duration_api_ms) — CLI 기동은 빠진다(운영 pm-worker와 같은 값).
          const modelLatencyMs = typeof result.duration_api_ms === 'number' ? Math.round(result.duration_api_ms) : null;
          resolve({ ...parseRoutingResponse(result.result ?? '', input, name), costUsd: result.total_cost_usd ?? null, modelLatencyMs });
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

// 서버와 같은 구현(src/domain/question/*-router.ts)을 그대로 쓴다 — 판정·비용 계산이 운영과 한 벌이다.
// 키는 실행자의 셸 환경변수에서만 읽는다(.env를 읽지 않는다 — 운영 키와 평가 키를 나눠 쓴다).
function requireKey(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 없다 — 셸에서 설정하고 다시 실행한다(.env는 읽지 않는다)`);
  return value;
}

function withCost(router: QuestionRouter): EvalRouter {
  const routeWithCost = async (input: RoutingInput): Promise<RouterRun> => {
    const decision = await router.route(input);
    return { ...decision, costUsd: decision.costUsd ?? null };
  };
  return { name: router.name, routeWithCost, route: routeWithCost };
}

export function openAiEvalRouter(model?: string): EvalRouter {
  return withCost(openAiQuestionRouter({ apiKey: requireKey('OPENAI_API_KEY'), model, effort: 'low' }));
}

export function jevEvalRouter(model?: string): EvalRouter {
  return withCost(jevQuestionRouter({ apiKey: requireKey('TYPESAFE_API_KEY'), model }));
}

// 운영 llm 라우터(QUESTION_ROUTER_LLM_PROVIDER=api)와 같은 호출 — Anthropic API를 직접, 같은 지침·노력(low)·한도(llm-route-call.ts).
// 이름도 운영과 같은 모양(llm:anthropic:<모델>:<프롬프트 버전>)이라 결과를 나란히 놓을 수 있다. 키는 셸의 ANTHROPIC_API_KEY.
// claude(CLI)는 이 PC의 Claude Code를 거쳐 프롬프트 캐시·도구 정의가 달라 OpenAI·Jev와 같은 조건이 아니다 — 라우터 비교에는 이쪽을 쓴다.
export function claudeApiEvalRouter(model = 'claude-sonnet-5-5'): EvalRouter {
  const pm = anthropicModel(requireKey('ANTHROPIC_API_KEY'));
  const name = `llm:anthropic:${model}:${ROUTING_PROMPT_VERSION}`;
  const routeWithCost = async (input: RoutingInput): Promise<RouterRun> => {
    const decision = await routeWithLlm(pm, model, input, name);
    return { ...decision, costUsd: decision.costUsd ?? null };
  };
  return { name, routeWithCost, route: routeWithCost };
}
