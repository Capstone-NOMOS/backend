import path from 'node:path';
import type { NomosClient } from '../bridge/nomos-client.js';

// Claude 실행(stream-json)에서 룸에 보일 것을 뽑는다 — 룸을 Claude Code 화면처럼(대표 결정, 서버 020).
// 보내는 것: 도구 종류·대상(작업공간 기준 경로·명령 첫 줄)·성공 여부·수정 줄 수, 에이전트의 말(say, 500자).
// 보내지 않는 것: 파일 내용·diff·명령 출력 — 코드가 서버에 쌓인다. 줄 수는 숫자만 센다.

export type ActivityKind = 'read' | 'edit' | 'write' | 'run' | 'search' | 'other' | 'say';
export type ActivityItem = { kind: ActivityKind; target: string; ok?: boolean; added?: number; removed?: number };

const MAX_TARGET = 300;
const MAX_SAY = 500;

function clip(text: string): string {
  const oneLine = text.split(/\r?\n/)[0]!.trim();
  return oneLine.length > MAX_TARGET ? `${oneLine.slice(0, MAX_TARGET - 1)}…` : oneLine;
}

// 작업공간 안의 경로는 상대 경로로(슬래시 통일), 밖이면 그대로. 노트북의 사용자 폴더 이름이 룸에 찍히지 않게 한다.
function relative(cwd: string, p: unknown): string | null {
  if (typeof p !== 'string' || p === '') return null;
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return path.basename(abs);
  return rel.split(path.sep).join('/');
}

// 명령 안의 작업공간 절대 경로를 '.'으로 바꾼다 — 모델이 `git -C "C:/Users/<이름>/.nomos/..."`처럼 쓰면 사용자 폴더 이름이 룸에 찍힌다(실측).
function hideWorkspace(command: string, cwd: string): string {
  const forms = new Set([cwd, cwd.split(path.sep).join('/'), cwd.split('/').join('\\')]);
  let out = command;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    if (form) out = out.split(form).join('.');
  }
  return out;
}

function countLines(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const body = text.replace(/\r?\n$/, '');
  return body === '' ? 0 : body.split(/\r?\n/).length;
}

// 수정·작성의 줄 수(내용은 보내지 않는다). Edit은 old/new, MultiEdit은 합, Write는 새 내용.
function lineCounts(tool: string, input: Record<string, unknown>): { added?: number; removed?: number } {
  if (tool === 'Write') {
    const added = countLines(input.content);
    return added === null ? {} : { added };
  }
  const edits = tool === 'MultiEdit' && Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input];
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    const a = countLines(e.new_string);
    const r = countLines(e.old_string);
    if (a === null || r === null) return {};
    added += a;
    removed += r;
  }
  return { added, removed };
}

// 에이전트의 말 — 작업공간 경로를 지우고, 빈 줄을 줄이고, 500자에서 자른다.
export function toSay(text: string, cwd: string): ActivityItem | null {
  const cleaned = hideWorkspace(text, cwd).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) return null;
  return { kind: 'say', target: cleaned.length > MAX_SAY ? `${cleaned.slice(0, MAX_SAY - 1)}…` : cleaned };
}

// 도구 하나 → 활동 한 줄. 룸에 보일 필요가 없는 것(NOMOS 도구 — 제출·노트는 서버 이벤트로 이미 보인다, 할 일 목록)은 null.
export function toActivity(tool: string, input: Record<string, unknown>, cwd: string): ActivityItem | null {
  // ToolSearch는 Claude Code가 도구 정의를 불러오는 내부 동작이다(실측: 실행마다 첫 줄로 찍혔다).
  if (tool.startsWith('mcp__nomos__') || ['TodoWrite', 'AskUserQuestion', 'ToolSearch'].includes(tool)) return null;
  const file = (key: string): string | null => relative(cwd, input[key]);
  let item: ActivityItem | null = null;
  switch (tool) {
    case 'Read': {
      const f = file('file_path');
      item = f ? { kind: 'read', target: f } : null;
      break;
    }
    case 'Edit':
    case 'MultiEdit': {
      const f = file('file_path');
      item = f ? { kind: 'edit', target: f } : null;
      break;
    }
    case 'NotebookEdit': {
      const f = file('notebook_path');
      item = f ? { kind: 'edit', target: f } : null;
      break;
    }
    case 'Write': {
      const f = file('file_path');
      item = f ? { kind: 'write', target: f } : null;
      break;
    }
    case 'Bash':
      item = typeof input.command === 'string' && input.command.trim() ? { kind: 'run', target: hideWorkspace(input.command, cwd) } : null;
      break;
    case 'Grep':
    case 'Glob':
      item = typeof input.pattern === 'string' && input.pattern ? { kind: 'search', target: input.pattern } : null;
      break;
    default:
      item = { kind: 'other', target: tool };
  }
  if (!item) return null;
  const counts = item.kind === 'edit' || item.kind === 'write' ? lineCounts(tool, input) : {};
  return { kind: item.kind, target: clip(item.target), ...counts };
}

// 실행 하나의 stream-json을 따라가며 룸에 보낼 줄을 낸다. 도구 줄은 **결과가 온 뒤** 성공 여부를 붙여 낸다(tool_use_id로 짝짓기).
// 결과를 못 받은 도구는 finish()에서 성공 여부 없이 낸다. 형식이 다르거나 깨진 줄은 조용히 건너뛴다(룸 표시가 실행을 막으면 안 된다).
export class ActivityTracker {
  private readonly pending = new Map<string, ActivityItem>();

  constructor(private readonly cwd: string) {}

  observe(line: string): ActivityItem[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return [];
    let msg: { type?: unknown; message?: { content?: unknown } };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      return [];
    }
    if (!Array.isArray(msg.message?.content)) return [];
    const out: ActivityItem[] = [];
    for (const block of msg.message.content as Record<string, unknown>[]) {
      if (msg.type === 'assistant' && block.type === 'text' && typeof block.text === 'string') {
        const say = toSay(block.text, this.cwd);
        if (say) out.push(say);
      } else if (msg.type === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string') {
        const item = toActivity(block.name, (block.input ?? {}) as Record<string, unknown>, this.cwd);
        if (!item) continue;
        if (typeof block.id === 'string') this.pending.set(block.id, item);
        else out.push(item);
      } else if (msg.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const item = this.pending.get(block.tool_use_id);
        if (!item) continue;
        this.pending.delete(block.tool_use_id);
        out.push({ ...item, ok: block.is_error !== true });
      }
    }
    return out;
  }

  // 실행이 끝났다 — 결과를 못 받은 도구도 낸다.
  finish(): ActivityItem[] {
    const rest = [...this.pending.values()];
    this.pending.clear();
    return rest;
  }
}

// 활동을 모아 2초마다 한 번에 보낸다. 보내기 실패는 기록만 하고 넘어간다 — 룸 표시가 태스크 실행을 멈추면 안 된다.
export class ActivityReporter {
  private queue: ActivityItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending: Promise<void> = Promise.resolve();
  private warned = false;
  // 옛 서버(020 전)는 say·성공 여부·줄 수를 400으로 거부한다 — 한 번 거부되면 그 실행 동안은 예전 형식(도구·대상만)으로 낮춰 보낸다.
  private legacy = false;

  constructor(
    private readonly client: Pick<NomosClient, 'postActivity'>,
    private readonly taskId: string,
    private readonly log: (line: string) => void,
    intervalMs = 2_000,
  ) {
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref();
  }

  push(items: ActivityItem[]): void {
    this.queue.push(...items);
  }

  flush(): Promise<void> {
    this.sending = this.sending.then(async () => {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, 50);
        try {
          await this.send(batch);
        } catch (err) {
          if (!this.warned) {
            this.warned = true;
            this.log(`룸 활동 보고 실패(실행은 계속한다): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    });
    return this.sending;
  }

  private async send(batch: ActivityItem[]): Promise<void> {
    if (this.legacy) return this.sendLegacy(batch);
    try {
      await this.client.postActivity(this.taskId, batch);
    } catch (err) {
      if ((err as { status?: unknown }).status !== 400) throw err;
      this.legacy = true;
      await this.sendLegacy(batch);
    }
  }

  private async sendLegacy(batch: ActivityItem[]): Promise<void> {
    const items = batch.filter((i) => i.kind !== 'say').map((i) => ({ kind: i.kind, target: i.target }));
    if (items.length > 0) await this.client.postActivity(this.taskId, items);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

// 실행이 제출 없이 끝났을 때 대표에게 보일 사유를 모은다 — 거부된 쉘 명령과 모델의 마지막 말.
// 거부는 Claude Code가 돌려준 도구 결과(is_error)의 문구로 가른다("requires approval" 등). 문구가 바뀌면 빠질 수 있으나 판정이 아니라 안내라 괜찮다.
const DENIAL = /requires (manual )?approval|permission|not allowed|denied/i;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

export class RunObserver {
  private readonly commands = new Map<string, string>();
  private readonly denied: string[] = [];
  private lastText: string | null = null;
  private resultText: string | null = null;

  constructor(private readonly cwd: string) {}

  observe(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let msg: { type?: unknown; result?: unknown; message?: { content?: unknown } };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === 'result' && typeof msg.result === 'string') this.resultText = msg.result;
    if (!Array.isArray(msg.message?.content)) return;
    for (const block of msg.message.content as Record<string, unknown>[]) {
      if (msg.type === 'assistant' && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        this.lastText = block.text;
      }
      if (msg.type === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string' && SHELL_TOOLS.has(block.name)) {
        const command = (block.input as { command?: unknown } | undefined)?.command;
        if (typeof block.id === 'string' && typeof command === 'string') this.commands.set(block.id, command);
      }
      if (msg.type === 'user' && block.type === 'tool_result' && block.is_error === true && typeof block.tool_use_id === 'string') {
        const command = this.commands.get(block.tool_use_id);
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        if (command !== undefined && DENIAL.test(content)) {
          const shown = clip(hideWorkspace(command, this.cwd));
          if (!this.denied.includes(shown) && this.denied.length < 20) this.denied.push(shown);
        }
      }
    }
  }

  summary(): { lastMessage: string | null; deniedCommands: string[] } {
    const text = this.resultText ?? this.lastText;
    return {
      lastMessage: text ? hideWorkspace(text, this.cwd).trim().slice(0, 2000) : null,
      deniedCommands: [...this.denied],
    };
  }
}
