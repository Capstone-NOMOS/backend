import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// 브리핑으로 프롬프트에 넣은 인계 노트의 id. 제출할 때 "이미 받은 노트"로 서버에 함께 보낸다.
// 서버는 관련 노트를 전부 확인해야 제출을 받는다(NOTES_UNACKNOWLEDGED). 프롬프트로 전달된 노트는 확인한 것이므로
// 모델이 id를 옮겨 적게 하지 않고 브릿지가 넣는다 — 모델이 직접 넣는 건 반려 뒤 새로 받은 노트뿐이다.
// Executor가 작업공간에 쓰고(브리핑 직후), MCP 서버의 submit_artifact가 읽는다. 둘은 다른 프로세스다.

export const BRIEFING_NOTES_FILE = '.nomos-briefing.json';

export function writeBriefingNotes(workspaceDir: string, taskId: string, noteIds: string[]): void {
  writeFileSync(path.join(workspaceDir, BRIEFING_NOTES_FILE), `${JSON.stringify({ taskId, noteIds }, null, 2)}\n`);
}

// 다른 태스크의 파일이거나 없으면 빈 목록 — 엉뚱한 태스크의 노트를 확인한 것으로 보내지 않는다.
export function readBriefingNoteIds(workspaceDir: string, taskId: string): string[] {
  const file = path.join(workspaceDir, BRIEFING_NOTES_FILE);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { taskId?: unknown; noteIds?: unknown };
    if (parsed.taskId !== taskId || !Array.isArray(parsed.noteIds)) return [];
    return parsed.noteIds.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

export function mergeAcknowledged(briefed: string[], fromModel: string[] | undefined): string[] {
  return [...new Set([...briefed, ...(fromModel ?? [])])].sort();
}

// 지금 작업공간의 태스크 id — 권한 도구가 AskUserQuestion을 어느 태스크의 질문으로 올릴지 정한다. 없으면 null.
export function readBriefingTaskId(workspaceDir: string): string | null {
  const file = path.join(workspaceDir, BRIEFING_NOTES_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { taskId?: unknown };
    return typeof parsed.taskId === 'string' ? parsed.taskId : null;
  } catch {
    return null;
  }
}
