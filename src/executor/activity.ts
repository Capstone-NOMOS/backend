import path from 'node:path';
import type { NomosClient } from '../bridge/nomos-client.js';

// Claude 실행(stream-json)에서 "무슨 도구로 무엇을 건드렸나"만 뽑아 룸으로 보낸다.
// 보내는 것은 도구 종류와 대상(작업공간 기준 경로·명령 첫 줄)뿐이다. 파일 내용·명령 결과·모델의 설명 문장은 보내지 않는다 —
// 코드가 서버에 쌓이고, 설명은 인계 노트의 몫이다(대표 결정).

export type ActivityKind = 'read' | 'edit' | 'write' | 'run' | 'search' | 'other';
export type ActivityItem = { kind: ActivityKind; target: string };

const MAX_TARGET = 300;

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
  return item ? { kind: item.kind, target: clip(item.target) } : null;
}

// stream-json 한 줄 → 그 줄에 든 도구 호출들. 형식이 다르거나 깨진 줄은 조용히 건너뛴다(룸 표시가 실행을 막으면 안 된다).
export function activityFromStreamLine(line: string, cwd: string): ActivityItem[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let msg: { type?: unknown; message?: { content?: unknown } };
  try {
    msg = JSON.parse(trimmed) as typeof msg;
  } catch {
    return [];
  }
  if (msg.type !== 'assistant' || !Array.isArray(msg.message?.content)) return [];
  const items: ActivityItem[] = [];
  for (const block of msg.message.content as { type?: unknown; name?: unknown; input?: unknown }[]) {
    if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
    const item = toActivity(block.name, (block.input ?? {}) as Record<string, unknown>, cwd);
    if (item) items.push(item);
  }
  return items;
}

// 활동을 모아 2초마다 한 번에 보낸다. 보내기 실패는 기록만 하고 넘어간다 — 룸 표시가 태스크 실행을 멈추면 안 된다.
export class ActivityReporter {
  private queue: ActivityItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending: Promise<void> = Promise.resolve();
  private warned = false;

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
          await this.client.postActivity(this.taskId, batch);
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

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}
