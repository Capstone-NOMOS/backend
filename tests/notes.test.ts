import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/config/db.js';
import { NOTE_LIMITS } from '../src/domain/note/kinds.js';
import { publishNote, readNotes } from '../src/domain/note/service.js';
import { buildNotesPromptBlock, selectNotesForTask } from '../src/domain/note/injection.js';
import { buildNoteTitle } from '../src/domain/note/title.js';
import { findForeignAgentMentions, validateNoteShape } from '../src/domain/note/validate.js';
import { claimTask, type AgentContext } from '../src/domain/task/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { createTestAgent, createTestOrg, createTestProject } from './fixtures.js';
import { expectDenied } from './helpers/assert-denied.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

beforeAll(async () => {
  await resetSchema();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await pool.end();
  await testPool.end();
});

const VALID = {
  kind: 'IMPLEMENTED' as const,
  headline: '참여신청 API 구현 완료',
  keyPoints: ['정원 초과는 409로 거절', '중복 신청은 멱등 처리'],
  affects: [],
};

describe('노트 형식 검증', () => {
  it('정상 입력은 위반이 없다', () => {
    expect(validateNoteShape(VALID)).toEqual([]);
  });

  it('headline 초과는 글자수와 상한을 함께 돌려준다 — 자르지 않는다', () => {
    const violations = validateNoteShape({ ...VALID, headline: '가'.repeat(61) });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ field: 'headline', length: 61, limit: NOTE_LIMITS.headline });
  });

  it('key_points는 몇 번째가 몇 자인지 알려준다', () => {
    const violations = validateNoteShape({
      ...VALID,
      keyPoints: ['짧음', '가'.repeat(121), '가'.repeat(200)],
    });

    expect(violations.map((v) => [v.index, v.length])).toEqual([
      [1, 121],
      [2, 200],
    ]);
  });

  it('key_points 개수는 1~5개다', () => {
    expect(validateNoteShape({ ...VALID, keyPoints: [] })[0]).toMatchObject({ field: 'keyPoints', length: 0 });
    expect(
      validateNoteShape({ ...VALID, keyPoints: ['a', 'b', 'c', 'd', 'e', 'f'] })[0],
    ).toMatchObject({ field: 'keyPoints', length: 6 });
  });

  it('700자는 headline + key_points 합계이고 affects는 안 센다', () => {
    const long = { ...VALID, headline: '가'.repeat(60), keyPoints: ['나'.repeat(120), '다'.repeat(120)] };
    expect(validateNoteShape(long)).toEqual([]);

    // affects를 길게 채워도 예산에 영향이 없다 — 영향 경로 보고를 길이와 경쟁시키지 않는다.
    expect(validateNoteShape({ ...long, affects: ['라'.repeat(200), '마'.repeat(200)] })).toEqual([]);

    // 개별 상한만 지키면 예산은 초과할 수 없다: 60 + 5x120 = 660 < 700.
    // 즉 앱에서 budget 위반은 개수·길이 위반과 함께만 나온다. 이 상한이 실제로 일하는 층은
    // 원소별 길이를 볼 수 없는 DB다(notes_budget_chk) — 아래 'DB CHECK' 묶음에서 확인한다.
    const over = { ...VALID, keyPoints: Array(6).fill('나'.repeat(120)) };
    const fields = validateNoteShape(over).map((v) => v.field);
    expect(fields).toContain('keyPoints');
    const budget = validateNoteShape(over).find((v) => v.field === 'budget');
    expect(budget).toMatchObject({ limit: NOTE_LIMITS.budget });
    expect(budget!.length).toBeGreaterThan(NOTE_LIMITS.budget);
  });

  it('affects는 10개 이하, 각 200자 이하다', () => {
    expect(validateNoteShape({ ...VALID, affects: Array(11).fill('src/a.ts') })[0]).toMatchObject({
      field: 'affects',
      length: 11,
    });
    expect(validateNoteShape({ ...VALID, affects: ['가'.repeat(201)] })[0]).toMatchObject({
      field: 'affects',
      index: 0,
      length: 201,
    });
  });

  it('DEVIATION은 affects가 필수다', () => {
    expect(validateNoteShape({ ...VALID, kind: 'DEVIATION' })).toEqual([
      { field: 'kind', message: 'DEVIATION은 affects가 최소 1개 필요합니다' },
    ]);
    expect(validateNoteShape({ ...VALID, kind: 'DEVIATION', affects: ['contracts/F-03.yaml'] })).toEqual([]);
  });

  it('줄바꿈과 마크다운 머리표를 거부한다 — 길이 제한 우회 수단이다', () => {
    expect(validateNoteShape({ ...VALID, headline: '한\n줄' })[0]).toMatchObject({ field: 'headline' });
    expect(validateNoteShape({ ...VALID, keyPoints: ['## 제목'] })[0]).toMatchObject({
      field: 'keyPoints',
      index: 0,
    });
  });
});

describe('과실 주장 판별', () => {
  const others = { ids: ['11111111-1111-1111-1111-111111111111'], names: ['jihoon-laptop'] };

  it('다른 에이전트 이름이나 id가 있으면 거부하고 raise_dispute로 안내한다', () => {
    const byName = findForeignAgentMentions([{ field: 'keyPoints', index: 0, text: 'jihoon-laptop이 깨뜨렸다' }], others);
    expect(byName[0]).toMatchObject({ field: 'keyPoints', index: 0 });
    expect(byName[0]!.message).toContain('raise_dispute');

    const byId = findForeignAgentMentions(
      [{ field: 'headline', text: `${others.ids[0]} 때문에 실패` }],
      others,
    );
    expect(byId[0]).toMatchObject({ field: 'headline' });
  });

  it('자연어로 심사하지 않는다 — 비난하는 문장도 이름이 없으면 통과한다', () => {
    // 판정은 문자열 포함 여부뿐이다(P2). "누가 잘못했나"를 LLM에 묻지 않는다.
    expect(
      findForeignAgentMentions([{ field: 'keyPoints', index: 0, text: '상대 쪽 계약이 잘못돼 막혔다' }], others),
    ).toEqual([]);
  });
});

describe('제목 조립', () => {
  it('서버가 조립한다 — #seq - 역할 기능 종류 — headline', () => {
    expect(
      buildNoteTitle({ seq: 3, teamRole: 'BACKEND', featureKey: 'F-03', kind: 'DECIDED', headline: '409로 거절' }),
    ).toBe('#3 - 백엔드 F-03 결정 사항 — 409로 거절');
  });

  it('명세에 매이지 않은 노트는 feature_key가 빠진다', () => {
    expect(
      buildNoteTitle({ seq: 1, teamRole: 'FRONTEND', featureKey: null, kind: 'GOTCHA', headline: null }),
    ).toBe('#1 - 프론트엔드 주의 사항');
  });
});

type Session = {
  userId: string;
  orgId: string;
  projectId: string;
  agentId: string;
  repoId: string;
  specId: string;
  taskId: string;
  ctx: AgentContext;
};

// 노트는 CLAIM한 태스크에만 붙는다. 그래서 준비 과정이 claim까지 간다.
// 아래 네 테이블은 아직 서비스 함수가 없어 직접 INSERT한다 (Phase 2 스키마).
async function setup(loginId = 'rep'): Promise<Session> {
  const { userId, orgId } = await createTestOrg(loginId);
  const projectId = await createTestProject({ orgId, userId });
  const agentId = await createTestAgent(userId);
  const [repo] = await connectRepos({ orgId, actorUserId: userId, repos: [{ fullName: 'acme/web' }] });
  const repoId = repo!.id;

  await pool.query(`INSERT INTO project_repos (project_id, repo_id) VALUES ($1, $2)`, [projectId, repoId]);
  await pool.query(`INSERT INTO project_members (project_id, agent_id, team_role) VALUES ($1, $2, 'BACKEND')`, [
    projectId,
    agentId,
  ]);
  await pool.query(
    `INSERT INTO project_policies (project_id, action_key, mode, lock_key)
     SELECT $1, action_key, mode_l2, lock_key FROM action_catalog`,
    [projectId],
  );
  const spec = await pool.query(
    `INSERT INTO specs (project_id, feature_key, title, content) VALUES ($1, 'F-03', '참여신청', 'WHEN …')
     RETURNING id`,
    [projectId],
  );
  const task = await pool.query(
    `INSERT INTO tasks (project_id, repo_id, spec_id, title, state, kind, team_role)
     VALUES ($1, $2, $3, 'T-042', 'READY', 'IMPLEMENT', 'BACKEND') RETURNING id`,
    [projectId, repoId, spec.rows[0]!.id],
  );
  const project = await pool.query(`SELECT policy_hash FROM projects WHERE id = $1`, [projectId]);

  const ctx: AgentContext = {
    agentId,
    onBehalfOf: userId,
    orgId,
    projectId,
    policyHash: project.rows[0]!.policy_hash,
  };
  await claimTask(ctx, task.rows[0]!.id);

  return { userId, orgId, projectId, agentId, repoId, specId: spec.rows[0]!.id, taskId: task.rows[0]!.id, ctx };
}

async function countNotes(): Promise<number> {
  return (await pool.query(`SELECT count(*)::int AS n FROM notes`)).rows[0]!.n as number;
}

describe('publish_note', () => {
  it('제목을 서버가 조립해 돌려주고 NOTE_PUBLISHED를 남긴다', async () => {
    const s = await setup();

    const published = await publishNote(s.ctx, s.taskId, VALID);

    expect(published.note.seq).toBe(1);
    expect(published.title).toBe('#1 - 백엔드 F-03 구현 완료 — 참여신청 API 구현 완료');
    // 연결은 태스크에서 물려받는다 — 클라이언트가 아무 명세에나 붙일 수 없다.
    expect(published.note).toMatchObject({ specId: s.specId, repoId: s.repoId, taskId: s.taskId });

    const { rows } = await pool.query(`SELECT payload FROM events WHERE type = 'NOTE_PUBLISHED'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ seq: 1, kind: 'IMPLEMENTED', title: published.title });
  });

  it('seq는 프로젝트별 1부터 올라간다', async () => {
    const s = await setup();

    const first = await publishNote(s.ctx, s.taskId, VALID);
    const second = await publishNote(s.ctx, s.taskId, { ...VALID, kind: 'GOTCHA' });

    expect([first.note.seq, second.note.seq]).toEqual([1, 2]);
  });

  it('CLAIM하지 않은 태스크에는 붙일 수 없다 — 거부는 남고 노트는 안 생긴다', async () => {
    const s = await setup();
    const other = await pool.query(
      `INSERT INTO tasks (project_id, repo_id, title, state, kind) VALUES ($1, $2, '남의 것', 'READY', 'IMPLEMENT')
       RETURNING id`,
      [s.projectId, s.repoId],
    );

    await expectDenied(publishNote(s.ctx, other.rows[0]!.id, VALID), {
      code: 'NOT_TASK_ASSIGNEE',
      stage: 'membership',
      emptyTables: ['notes'],
    });
  });

  it('형식 위반은 422로 되돌려주고, 권한 거부 이벤트는 남기지 않는다', async () => {
    const s = await setup();

    await expect(
      publishNote(s.ctx, s.taskId, { ...VALID, headline: '가'.repeat(61), keyPoints: ['나'.repeat(121)] }),
    ).rejects.toMatchObject({ code: 'NOTE_INVALID', status: 422 });

    expect(await countNotes()).toBe(0);
    // 오타를 M5′(차단된 도구 호출)에 섞으면 분자가 오염된다.
    const denied = await pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'TOOL_DENIED'`);
    expect(denied.rows[0]!.n).toBe(0);
  });

  it('DEVIATION에 affects가 없으면 422', async () => {
    const s = await setup();

    await expect(publishNote(s.ctx, s.taskId, { ...VALID, kind: 'DEVIATION' })).rejects.toMatchObject({
      code: 'NOTE_INVALID',
    });
    expect(await countNotes()).toBe(0);
  });

  it('다른 에이전트를 지목하면 422이고 raise_dispute로 안내한다', async () => {
    const s = await setup();
    const otherAgent = await createTestAgent(s.userId, 'jihoon-laptop');
    await pool.query(`INSERT INTO project_members (project_id, agent_id, team_role) VALUES ($1, $2, 'FRONTEND')`, [
      s.projectId,
      otherAgent,
    ]);

    const failure = publishNote(s.ctx, s.taskId, {
      ...VALID,
      keyPoints: ['jihoon-laptop이 계약을 깨뜨려서 막혔다'],
    });

    await expect(failure).rejects.toMatchObject({
      code: 'NOTE_INVALID',
      details: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('raise_dispute') }),
      ]),
    });
  });

  it('다른 프로젝트의 노트는 정정할 수 없다', async () => {
    const s = await setup();
    const elsewhere = await setup('rep2');
    const theirs = await publishNote(elsewhere.ctx, elsewhere.taskId, VALID);

    await expect(
      publishNote(s.ctx, s.taskId, { ...VALID, supersedes: theirs.note.id }),
    ).rejects.toMatchObject({ code: 'NOTE_INVALID' });
  });
});

describe('read_notes', () => {
  it('spec_id·since_seq·limit로 걸러 읽고 이벤트를 남기지 않는다', async () => {
    const s = await setup();
    await publishNote(s.ctx, s.taskId, VALID);
    await publishNote(s.ctx, s.taskId, { ...VALID, kind: 'GOTCHA' });
    const before = await pool.query(`SELECT count(*)::int AS n FROM events`);

    expect(await readNotes(s.ctx, s.projectId, { limit: 20 })).toHaveLength(2);
    expect(await readNotes(s.ctx, s.projectId, { sinceSeq: 1, limit: 20 })).toHaveLength(1);
    expect(await readNotes(s.ctx, s.projectId, { specId: s.specId, limit: 1 })).toHaveLength(1);

    // 조회까지 기록하면 events가 열람 로그가 된다.
    const after = await pool.query(`SELECT count(*)::int AS n FROM events`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('다른 프로젝트의 노트는 읽을 수 없다', async () => {
    const s = await setup();
    const elsewhere = await setup('rep2');

    await expect(readNotes(s.ctx, elsewhere.projectId, {})).rejects.toMatchObject({
      code: 'NOT_PROJECT_MEMBER',
    });
  });
});

describe('DB CHECK — 어떤 경로로 들어와도 막힌다', () => {
  async function insertRaw(s: Session, overrides: Record<string, unknown>): Promise<unknown> {
    const values = { kind: 'IMPLEMENTED', headline: '제목', key_points: ['한 줄'], affects: [], ...overrides };
    return pool.query(
      `INSERT INTO notes (project_id, seq, kind, headline, key_points, affects, author_agent_id, on_behalf_of)
       VALUES ($1, 99, $2, $3, $4, $5, $6, $7)`,
      [s.projectId, values.kind, values.headline, values.key_points, values.affects, s.agentId, s.userId],
    );
  }

  it('원소별 길이는 CHECK로 볼 수 없지만 합계 700자는 막는다', async () => {
    const s = await setup();

    // 이게 notes_budget_chk가 실제로 일하는 자리다. 앱 검증(각 120자)을 우회해 들어와도
    // 한 항목에 800자를 밀어넣으면 DB가 거부한다.
    await expect(insertRaw(s, { key_points: ['가'.repeat(800)] })).rejects.toThrow(/notes_budget_chk/);
  });

  it('줄바꿈·머리표·어휘·개수를 막는다', async () => {
    const s = await setup();

    await expect(insertRaw(s, { headline: '두\n줄' })).rejects.toThrow(/notes_no_newline_chk/);
    await expect(insertRaw(s, { key_points: ['## 제목'] })).rejects.toThrow(/notes_no_heading_chk/);
    await expect(insertRaw(s, { kind: 'NOTICE' })).rejects.toThrow(/notes_kind_chk/);
    await expect(insertRaw(s, { key_points: [] })).rejects.toThrow(/notes_key_points_count_chk/);
    await expect(insertRaw(s, { kind: 'DEVIATION' })).rejects.toThrow(/notes_deviation_affects_chk/);
    await expect(insertRaw(s, { affects: Array(11).fill('src/a.ts') })).rejects.toThrow(
      /notes_affects_count_chk/,
    );
  });

  it('같은 프로젝트에서 seq가 겹치면 유니크 위반이다', async () => {
    const s = await setup();
    await insertRaw(s, {});

    await expect(insertRaw(s, {})).rejects.toThrow(/uq_notes_seq/);
  });
});

describe('프롬프트 주입 대상 선택', () => {
  // read_notes 호출에 의존하지 않는 이유: 에이전트가 도구를 부를지 말지에 맡기면
  // 필요한 노트를 안 읽고 작업하는 경우가 생기고, 그게 곧 인계 실패다.

  // 같은 세션의 에이전트로 다른 명세의 태스크를 하나 더 잡아 노트를 남긴다.
  async function noteOnOtherSpec(s: Session, affects: string[], featureKey: string): Promise<string> {
    const spec = await pool.query(
      `INSERT INTO specs (project_id, feature_key, title, content) VALUES ($1, $2, '다른 기능', 'WHEN …')
       RETURNING id`,
      [s.projectId, featureKey],
    );
    const task = await pool.query(
      `INSERT INTO tasks (project_id, repo_id, spec_id, title, state, kind, team_role)
       VALUES ($1, $2, $3, 'T-099', 'READY', 'IMPLEMENT', 'BACKEND') RETURNING id`,
      [s.projectId, s.repoId, spec.rows[0]!.id],
    );
    await claimTask(s.ctx, task.rows[0]!.id);
    const published = await publishNote(s.ctx, task.rows[0]!.id, { ...VALID, affects });
    return published.note.id;
  }

  it('같은 spec의 노트를 고른다', async () => {
    const s = await setup();
    const mine = await publishNote(s.ctx, s.taskId, VALID);

    const selected = await selectNotesForTask(pool, s.taskId);

    expect(selected.map((n) => n.id)).toContain(mine.note.id);
  });

  it('선행 태스크가 만든 노트를 고른다', async () => {
    const s = await setup();
    // 다른 명세의 태스크를 선행으로 걸면, spec이 달라도 그 결과 위에 올라가므로 필요하다.
    const earlier = await pool.query(
      `INSERT INTO tasks (project_id, repo_id, title, state, kind) VALUES ($1, $2, '선행', 'READY', 'IMPLEMENT')
       RETURNING id`,
      [s.projectId, s.repoId],
    );
    await claimTask(s.ctx, earlier.rows[0]!.id);
    const theirs = await publishNote(s.ctx, earlier.rows[0]!.id, VALID);
    await pool.query(`INSERT INTO task_deps (task_id, depends_on) VALUES ($1, $2)`, [
      s.taskId,
      earlier.rows[0]!.id,
    ]);

    const selected = await selectNotesForTask(pool, s.taskId);

    expect(selected.map((n) => n.id)).toContain(theirs.note.id);
  });

  it('affects가 내가 수정할 수 있는 경로와 겹칠 때만 고른다', async () => {
    const s = await setup();
    // '**'를 프론트엔드 소유로 돌리면 백엔드가 쓸 수 있는 건 무소유 규칙(tests/** 등)뿐이다.
    await pool.query(`UPDATE repo_paths SET owner_role = 'FRONTEND' WHERE repo_id = $1 AND path_pattern = '**'`, [
      s.repoId,
    ]);
    const overlapping = await noteOnOtherSpec(s, ['tests/participation.test.ts'], 'F-98');
    const unrelated = await noteOnOtherSpec(s, ['src/index.ts'], 'F-99');

    const selected = (await selectNotesForTask(pool, s.taskId)).map((n) => n.id);

    expect(selected).toContain(overlapping);
    expect(selected).not.toContain(unrelated);
  });

  it('정정된 노트는 빠지고 최신본만 남는다', async () => {
    const s = await setup();
    const first = await publishNote(s.ctx, s.taskId, VALID);
    const corrected = await publishNote(s.ctx, s.taskId, { ...VALID, supersedes: first.note.id });

    const selected = (await selectNotesForTask(pool, s.taskId)).map((n) => n.id);

    expect(selected).toContain(corrected.note.id);
    expect(selected).not.toContain(first.note.id);
  });

  it('상한을 넘으면 최신순으로 자른다', async () => {
    const s = await setup();
    for (let i = 0; i < 4; i += 1) {
      await publishNote(s.ctx, s.taskId, { ...VALID, headline: `노트 ${i}` });
    }

    const selected = await selectNotesForTask(pool, s.taskId, 2);

    expect(selected).toHaveLength(2);
    expect(selected[0]!.seq).toBeGreaterThan(selected[1]!.seq);
  });

  it('블록은 종류 라벨·요점·영향을 담고, 없으면 빈 문자열이다', async () => {
    const s = await setup();
    await publishNote(s.ctx, s.taskId, { ...VALID, kind: 'DEVIATION', affects: ['contracts/F-03.yaml'] });

    const block = buildNotesPromptBlock(await selectNotesForTask(pool, s.taskId));

    expect(block).toContain('[인계 노트]');
    expect(block).toContain('[명세 이탈]');
    expect(block).toContain('· 정원 초과는 409로 거절');
    expect(block).toContain('영향: contracts/F-03.yaml');
    expect(buildNotesPromptBlock([])).toBe('');
  });
});
