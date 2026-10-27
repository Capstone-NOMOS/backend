import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// 브리핑으로 프롬프트에 넣은 인계 노트의 id. 제출할 때 "이미 받은 노트"로 서버에 함께 보낸다.
// 서버는 관련 노트를 전부 확인해야 제출을 받는다(NOTES_UNACKNOWLEDGED). 프롬프트로 전달된 노트는 확인한 것이므로
// 모델이 id를 옮겨 적게 하지 않고 브릿지가 넣는다 — 모델이 직접 넣는 건 반려 뒤 새로 받은 노트뿐이다.
// 질문으로 정해진 결정(decisions)도 같다 — 브리핑으로 받은 결정 id를 함께 남기고 제출 때 보낸다(DECISIONS_UNACKNOWLEDGED).
// Executor가 작업공간에 쓰고(브리핑 직후), MCP 서버의 submit_artifact가 읽는다. 둘은 다른 프로세스다.

export const BRIEFING_NOTES_FILE = '.nomos-briefing.json';

export function writeBriefingNotes(workspaceDir: string, taskId: string, noteIds: string[], decisionIds: string[] = []): void {
  writeFileSync(path.join(workspaceDir, BRIEFING_NOTES_FILE), `${JSON.stringify({ taskId, noteIds, decisionIds }, null, 2)}\n`);
}

// 다른 태스크의 파일이거나 없으면 빈 목록 — 엉뚱한 태스크의 노트·결정을 확인한 것으로 보내지 않는다.
function readBriefingIds(workspaceDir: string, taskId: string, key: 'noteIds' | 'decisionIds'): string[] {
  const file = path.join(workspaceDir, BRIEFING_NOTES_FILE);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { taskId?: unknown; noteIds?: unknown; decisionIds?: unknown };
    const ids = parsed[key];
    if (parsed.taskId !== taskId || !Array.isArray(ids)) return [];
    return ids.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

export function readBriefingNoteIds(workspaceDir: string, taskId: string): string[] {
  return readBriefingIds(workspaceDir, taskId, 'noteIds');
}

export function readBriefingDecisionIds(workspaceDir: string, taskId: string): string[] {
  return readBriefingIds(workspaceDir, taskId, 'decisionIds');
}

export function mergeAcknowledged(briefed: string[], fromModel: string[] | undefined): string[] {
  return [...new Set([...briefed, ...(fromModel ?? [])])].sort();
}

export type SubmitBody = { commitSha: string; changedPaths: string[]; acknowledgedNoteIds?: string[]; acknowledgedDecisionIds: string[] };

// submit_artifact가 서버에 보내는 본문. 브리핑으로 받은 노트·결정과 모델이 반려 뒤 확인한 것을 합친다.
// acknowledgedDecisionIds는 비어 있어도 **항상** 보낸다 — 서버는 이 필드가 없으면 옛 CLI(0.1.14 이하)로 보고 결정 확인을 건너뛴다.
export function buildSubmitBody(input: {
  workspaceDir: string;
  taskId: string;
  commitSha: string;
  changedPaths: string[];
  acknowledgedNoteIds?: string[];
  acknowledgedDecisionIds?: string[];
}): SubmitBody {
  const acknowledgedNoteIds = mergeAcknowledged(readBriefingNoteIds(input.workspaceDir, input.taskId), input.acknowledgedNoteIds);
  return {
    commitSha: input.commitSha,
    changedPaths: input.changedPaths,
    ...(acknowledgedNoteIds.length === 0 ? {} : { acknowledgedNoteIds }),
    acknowledgedDecisionIds: mergeAcknowledged(readBriefingDecisionIds(input.workspaceDir, input.taskId), input.acknowledgedDecisionIds),
  };
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
