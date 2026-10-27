import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BRIEFING_NOTES_FILE, buildSubmitBody, readBriefingDecisionIds, readBriefingNoteIds, writeBriefingNotes } from '../src/bridge/briefing-notes.js';

// MCP submit_artifact가 서버에 보내는 본문. 브리핑으로 받은 노트·결정(작업공간 파일)과 모델이 반려 뒤 확인한 것을 합친다.
// acknowledgedDecisionIds는 비어 있어도 항상 보낸다 — 서버는 이 필드가 없으면 옛 CLI(0.1.14 이하)로 보고 결정 확인을 건너뛴다.

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'nomos-submit-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const base = { taskId: 't1', commitSha: 'abc1234', changedPaths: ['src/a.ts'] };

describe('submit_artifact 본문', () => {
  it('브리핑 파일의 결정 id와 모델이 넣은 id를 합쳐(중복 없이, 정렬) 보낸다', () => {
    const dir = tmp();
    writeBriefingNotes(dir, 't1', ['n1'], ['q1:1', 'q1:0']);
    expect(buildSubmitBody({ ...base, workspaceDir: dir, acknowledgedDecisionIds: ['q2:0', 'q1:0'] })).toEqual({
      commitSha: 'abc1234',
      changedPaths: ['src/a.ts'],
      acknowledgedNoteIds: ['n1'],
      acknowledgedDecisionIds: ['q1:0', 'q1:1', 'q2:0'],
    });
  });

  it('받은 결정이 없어도 acknowledgedDecisionIds는 빈 배열로 항상 보낸다 — 파일이 없거나 다른 태스크 것이어도', () => {
    const none = tmp();
    expect(buildSubmitBody({ ...base, workspaceDir: none })).toEqual({ commitSha: 'abc1234', changedPaths: ['src/a.ts'], acknowledgedDecisionIds: [] });
    const other = tmp();
    writeBriefingNotes(other, 't2', ['n9'], ['q9:0']);
    expect(buildSubmitBody({ ...base, workspaceDir: other }).acknowledgedDecisionIds).toEqual([]);
  });

  it('옛 CLI가 남긴 브리핑 파일(decisionIds 없음)도 읽는다 — 노트는 그대로, 결정은 빈 목록', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, BRIEFING_NOTES_FILE), JSON.stringify({ taskId: 't1', noteIds: ['n1'] }));
    expect(readBriefingNoteIds(dir, 't1')).toEqual(['n1']);
    expect(readBriefingDecisionIds(dir, 't1')).toEqual([]);
    expect(buildSubmitBody({ ...base, workspaceDir: dir })).toMatchObject({ acknowledgedNoteIds: ['n1'], acknowledgedDecisionIds: [] });
  });
});
