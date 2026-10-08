import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActivityReporter, activityFromStreamLine, RunObserver, toActivity, type ActivityItem } from '../src/executor/activity.js';

// Claude stream-json → 룸 활동 한 줄. 보내는 것은 도구 종류와 대상(작업공간 기준 경로·명령 첫 줄)뿐이다.
const cwd = path.resolve('/work/space');
const inWs = (p: string) => path.join(cwd, p);

function assistant(...blocks: unknown[]): string {
  return JSON.stringify({ type: 'assistant', message: { content: blocks } });
}

describe('도구 → 활동', () => {
  it('파일 도구는 작업공간 기준 상대 경로로(사용자 폴더 이름이 룸에 찍히지 않게)', () => {
    expect(toActivity('Read', { file_path: inWs('src/routes/auth.ts') }, cwd)).toEqual({ kind: 'read', target: 'src/routes/auth.ts' });
    expect(toActivity('Edit', { file_path: inWs('src/a.ts') }, cwd)).toEqual({ kind: 'edit', target: 'src/a.ts' });
    expect(toActivity('MultiEdit', { file_path: 'src/b.ts' }, cwd)).toEqual({ kind: 'edit', target: 'src/b.ts' });
    expect(toActivity('Write', { file_path: inWs('docs/x.md') }, cwd)).toEqual({ kind: 'write', target: 'docs/x.md' });
    // 작업공간 밖은 파일 이름만.
    expect(toActivity('Read', { file_path: path.resolve('/home/someone/.ssh/config') }, cwd)).toEqual({ kind: 'read', target: 'config' });
  });

  it('명령은 첫 줄만, 300자로 자른다 — 결과는 보내지 않는다', () => {
    expect(toActivity('Bash', { command: 'npm test' }, cwd)).toEqual({ kind: 'run', target: 'npm test' });
    expect(toActivity('Bash', { command: 'git commit -m "x"\nsecond line' }, cwd)).toEqual({ kind: 'run', target: 'git commit -m "x"' });
    const long = toActivity('Bash', { command: 'x'.repeat(400) }, cwd)!;
    expect(long.target.length).toBe(300);
    expect(toActivity('Grep', { pattern: 'TODO' }, cwd)).toEqual({ kind: 'search', target: 'TODO' });
    // 명령 안의 작업공간 절대 경로는 '.'으로 — 사용자 폴더 이름이 룸에 찍히지 않게(실측: 모델이 git -C <절대 경로>를 썼다).
    const slash = cwd.split(path.sep).join('/');
    expect(toActivity('Bash', { command: `git -C "${slash}" ls-files` }, cwd)).toEqual({ kind: 'run', target: 'git -C "." ls-files' });
    expect(toActivity('Bash', { command: `ls ${cwd}${path.sep}src` }, cwd)).toEqual({ kind: 'run', target: `ls .${path.sep}src` });
  });

  it('NOMOS 도구·할 일 목록은 보내지 않는다(제출·노트는 서버 이벤트로 이미 보인다), 모르는 도구는 이름만', () => {
    expect(toActivity('mcp__nomos__submit_artifact', { commitSha: 'x' }, cwd)).toBeNull();
    expect(toActivity('TodoWrite', { todos: [] }, cwd)).toBeNull();
    expect(toActivity('ToolSearch', { query: 'select:x' }, cwd)).toBeNull();
    expect(toActivity('WebFetch', { url: 'https://x' }, cwd)).toEqual({ kind: 'other', target: 'WebFetch' });
  });
});

describe('stream-json 줄 → 활동', () => {
  it('assistant 메시지의 tool_use만 뽑고, 설명 문장(text)은 버린다', () => {
    const line = assistant(
      { type: 'text', text: '가입 라우트에 이메일 중복 검사를 추가하겠습니다' },
      { type: 'tool_use', name: 'Read', input: { file_path: inWs('src/a.ts') } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    );
    expect(activityFromStreamLine(line, cwd)).toEqual([
      { kind: 'read', target: 'src/a.ts' },
      { kind: 'run', target: 'npm test' },
    ]);
  });

  it('도구 결과(user)·시스템·깨진 줄은 무시한다', () => {
    expect(activityFromStreamLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'SECRET' }] } }), cwd)).toEqual([]);
    expect(activityFromStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }), cwd)).toEqual([]);
    expect(activityFromStreamLine('{not json', cwd)).toEqual([]);
    expect(activityFromStreamLine('', cwd)).toEqual([]);
  });
});

describe('활동 묶어 보내기', () => {
  it('모아서 50줄씩 보내고, 보내기가 실패해도 던지지 않고 한 번만 기록한다', async () => {
    const sent: ActivityItem[][] = [];
    let fail = true;
    const logs: string[] = [];
    const reporter = new ActivityReporter(
      {
        async postActivity(_taskId: string, items: { kind: string; target: string }[]) {
          if (fail) throw new Error('offline');
          sent.push(items as ActivityItem[]);
        },
      },
      'task-1',
      (l) => logs.push(l),
      60_000,
    );
    reporter.push([{ kind: 'read', target: 'a' }]);
    await reporter.flush();
    reporter.push([{ kind: 'read', target: 'b' }]);
    await reporter.flush();
    expect(logs).toHaveLength(1);

    fail = false;
    reporter.push(Array.from({ length: 70 }, (_, i) => ({ kind: 'read' as const, target: `f${i}` })));
    await reporter.close();
    expect(sent.map((b) => b.length)).toEqual([50, 20]);
  });
});

describe('멈춤 사유 모으기(RunObserver)', () => {
  it('거부된 쉘 명령(작업공간 경로 가림)과 마지막 결과 문장을 모은다 — 성공한 명령은 넣지 않는다', () => {
    const o = new RunObserver(cwd);
    const slash = cwd.split(path.sep).join('/');
    o.observe(assistant({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git fetch --all' } }));
    o.observe(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'This command requires approval' }] } }));
    o.observe(assistant({ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'git status' } }));
    o.observe(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'clean' }] } }));
    o.observe(assistant({ type: 'tool_use', id: 't3', name: 'PowerShell', input: { command: `python -m unittest -s ${slash}/tests` } }));
    o.observe(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: [{ type: 'text', text: 'The following part requires approval' }] }] } }));
    // 같은 명령은 한 번만.
    o.observe(assistant({ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'git fetch --all' } }));
    o.observe(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't4', is_error: true, content: 'This command requires approval' }] } }));
    o.observe(assistant({ type: 'text', text: '중간 설명' }));
    o.observe(JSON.stringify({ type: 'result', subtype: 'success', result: '통합 확인에 필요한 git merge 권한이 없어 멈춥니다' }));
    expect(o.summary()).toEqual({
      lastMessage: '통합 확인에 필요한 git merge 권한이 없어 멈춥니다',
      deniedCommands: ['git fetch --all', 'python -m unittest -s ./tests'],
    });
  });

  it('결과 메시지가 없으면 마지막 assistant 문장을 쓴다', () => {
    const o = new RunObserver(cwd);
    o.observe(assistant({ type: 'text', text: '권한이 없어 진행할 수 없습니다' }));
    expect(o.summary()).toEqual({ lastMessage: '권한이 없어 진행할 수 없습니다', deniedCommands: [] });
  });
});
