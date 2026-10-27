import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BRIEFING_NOTES_FILE, mergeAcknowledged, readBriefingNoteIds, writeBriefingNotes } from '../src/bridge/briefing-notes.js';
import { buildTaskPrompt } from '../src/executor/prompt.js';
import { excludeNomosFiles, NOMOS_LOCAL_FILES } from '../src/executor/workspace.js';

// 브리핑으로 받은 노트를 제출 때 "확인한 노트"로 보내는 파일, 그리고 NOMOS가 작업공간에 쓰는 파일을 커밋에서 빼는 처리.

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'nomos-handoff-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('브리핑 노트 파일', () => {
  it('쓴 태스크의 id만 읽고, 다른 태스크·없는 파일·깨진 파일은 빈 목록', () => {
    const dir = tmp();
    expect(readBriefingNoteIds(dir, 't1')).toEqual([]);
    writeBriefingNotes(dir, 't1', ['n2', 'n1']);
    expect(readBriefingNoteIds(dir, 't1')).toEqual(['n2', 'n1']);
    expect(readBriefingNoteIds(dir, 't2')).toEqual([]); // 엉뚱한 태스크의 노트를 확인한 것으로 보내지 않는다
    writeFileSync(path.join(dir, BRIEFING_NOTES_FILE), '{not json');
    expect(readBriefingNoteIds(dir, 't1')).toEqual([]);
  });

  it('브리핑으로 받은 것과 모델이 확인한 것을 합친다(중복 없이)', () => {
    expect(mergeAcknowledged(['b', 'a'], ['c', 'a'])).toEqual(['a', 'b', 'c']);
    expect(mergeAcknowledged([], undefined)).toEqual([]);
  });
});

describe('작업공간 파일을 커밋에서 뺀다', () => {
  it('레포 info/exclude에 한 번만 넣고, 그 파일들은 git status에 안 나온다', () => {
    const repo = tmp();
    execFileSync('git', ['init', '-q', repo]);
    excludeNomosFiles(repo);
    excludeNomosFiles(repo); // 두 번 불러도 한 번만
    const exclude = readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8');
    for (const p of NOMOS_LOCAL_FILES) expect(exclude.split('\n').filter((l) => l === p)).toHaveLength(1);

    writeFileSync(path.join(repo, '.nomos-mcp.json'), '{}');
    writeFileSync(path.join(repo, '.nomos-briefing.json'), '{}');
    writeFileSync(path.join(repo, 'real.ts'), 'x');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' });
    expect(status).toContain('real.ts');
    expect(status).not.toContain('.nomos-');
  });
});

describe('프롬프트 — 질문으로 정해진 결정', () => {
  const base = { task: { id: 't1', title: 'T', teamRole: 'BACKEND' }, repo: { fullName: 'a/api' }, spec: null, notesBlock: '', writablePaths: [{ pathPattern: '**' }] };
  const decision = { question: '스터디 목록 한 페이지 크기는?', answer: '20개', askerRole: 'FRONTEND', targetRole: 'BACKEND', decidedByName: '홍길동' };

  it('결정이 있으면 절이 생기고, 따르라·바꾸려면 다시 물으라고 적는다', () => {
    const prompt = buildTaskPrompt({ ...base, decisions: [decision] }, 'task/t1');
    expect(prompt).toContain('# 질문으로 정해진 결정');
    expect(prompt).toContain('구현이 이 결정과 다르면 결정을 따른다');
    expect(prompt).toContain('AskUserQuestion으로 그 역할에 다시 묻는다');
    expect(prompt).toContain('- [물은 쪽 FRONTEND · 정한 쪽 BACKEND 홍길동] Q: 스터디 목록 한 페이지 크기는?\n  A: 20개');
  });

  it('결정이 없거나 옛 서버(필드 없음)면 절을 넣지 않는다 — 제출 반려 안내는 늘 있다', () => {
    for (const prompt of [buildTaskPrompt({ ...base, decisions: [] }, 'task/t1'), buildTaskPrompt(base, 'task/t1')]) {
      expect(prompt).not.toContain('# 질문으로 정해진 결정');
      expect(prompt).toContain('DECISIONS_UNACKNOWLEDGED');
      expect(prompt).toContain('acknowledged_decision_ids');
    }
  });
});
