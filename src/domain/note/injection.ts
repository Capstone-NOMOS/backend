import type { Queryable } from '../../config/db.js';
import { matches } from '../repo/glob.js';
import { listRepoPaths } from '../repo/repository.js';
import { findTaskById, listDependencyTaskIds } from '../task/repository.js';
import { NOTE_KIND_LABEL } from './kinds.js';
import { listInjectionCandidates, type Note } from './repository.js';

// read_notes 호출에 의존하지 않는다. 에이전트가 도구를 부를지 말지에 맡기면
// 필요한 노트를 안 읽고 작업하는 경우가 생기고, 그게 곧 인계 실패다.
// 그래서 Executor가 프롬프트를 조립할 때 서버가 골라 넣는다.
const CANDIDATE_CAP = 200;
const DEFAULT_LIMIT = 20;

// 세 갈래로 고른다:
//   1. 같은 spec_id — 같은 기능을 이어받는 사람에게 가장 직접적이다
//   2. 선행 태스크(task_deps)가 만든 노트 — 내가 그 결과 위에 올라간다
//   3. affects가 내가 수정할 수 있는 경로와 겹치는 노트 — 내 작업 면에 영향이 온다
// supersedes로 대체된 노트는 후보 쿼리에서 이미 빠진다. 낡은 정보를 프롬프트에 넣으면 안 된다.
export async function selectNotesForTask(
  db: Queryable,
  taskId: string,
  limit: number = DEFAULT_LIMIT,
): Promise<Note[]> {
  const task = await findTaskById(db, taskId);
  if (!task) return [];

  const [candidates, dependencyIds, rules] = [
    await listInjectionCandidates(db, taskId, CANDIDATE_CAP),
    await listDependencyTaskIds(db, taskId),
    await listRepoPaths(db, task.repoId),
  ];
  const dependencies = new Set(dependencyIds);

  // "내가 수정할 수 있는 경로" = 이 레포에서 쓰기 가능하고, 무소유이거나 내 역할 소유인 규칙.
  const writable = rules.filter(
    (rule) => rule.access === 'write' && (rule.ownerRole === null || rule.ownerRole === task.teamRole),
  );

  const relevant = candidates.filter((note) => {
    if (task.specId !== null && note.specId === task.specId) return true;
    if (note.taskId !== null && dependencies.has(note.taskId)) return true;
    return note.affects.some((path) => writable.some((rule) => matches(rule.pathPattern, path)));
  });

  // 후보 쿼리가 이미 seq 내림차순이라 최신순이 유지된다.
  return relevant.slice(0, limit);
}

// 프롬프트에 넣는 블록. 노트는 짧게 유지되므로 원문을 거의 그대로 옮긴다 —
// 요약을 한 번 더 거치면 LLM이 정보를 잃는 지점이 하나 늘어난다.
export function buildNotesPromptBlock(notes: Note[]): string {
  if (notes.length === 0) return '';

  const body = notes
    .map((note) => {
      const lines = [`#${note.seq} [${NOTE_KIND_LABEL[note.kind]}] ${note.headline}`];
      lines.push(...note.keyPoints.map((point) => `  · ${point}`));
      if (note.affects.length > 0) lines.push(`  영향: ${note.affects.join(', ')}`);
      return lines.join('\n');
    })
    .join('\n\n');

  return `[인계 노트]\n${body}`;
}
