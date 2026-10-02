import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';
import type { NoteKind } from './kinds.js';

export type Note = {
  id: string;
  projectId: string;
  seq: number;
  taskId: string | null;
  specId: string | null;
  repoId: string | null;
  kind: NoteKind;
  headline: string;
  keyPoints: string[];
  affects: string[];
  authorAgentId: string;
  onBehalfOf: string;
  supersedes: string | null;
  createdAt: string;
};

function toNote(row: QueryResultRow): Note {
  return {
    id: row.id,
    projectId: row.project_id,
    seq: row.seq,
    taskId: row.task_id,
    specId: row.spec_id,
    repoId: row.repo_id,
    kind: row.kind,
    headline: row.headline,
    keyPoints: row.key_points,
    affects: row.affects,
    authorAgentId: row.author_agent_id,
    onBehalfOf: row.on_behalf_of,
    supersedes: row.supersedes,
    createdAt: row.created_at,
  };
}

// seq는 프로젝트별 1부터. 같은 문장 안에서 채번하고, 유니크 제약이 경합을 잡는다.
// 별도 SELECT로 읽어 계산하면 두 노트가 같은 번호를 받을 수 있다.
export async function insertNote(
  db: Queryable,
  input: {
    projectId: string;
    taskId: string | null;
    specId: string | null;
    repoId: string | null;
    kind: NoteKind;
    headline: string;
    keyPoints: string[];
    affects: string[];
    authorAgentId: string;
    onBehalfOf: string;
    supersedes: string | null;
  },
): Promise<Note> {
  const { rows } = await db.query(
    `INSERT INTO notes (project_id, seq, task_id, spec_id, repo_id, kind, headline, key_points, affects,
                        author_agent_id, on_behalf_of, supersedes)
     VALUES ($1,
             (SELECT coalesce(max(seq), 0) + 1 FROM notes WHERE project_id = $1),
             $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      input.projectId,
      input.taskId,
      input.specId,
      input.repoId,
      input.kind,
      input.headline,
      input.keyPoints,
      input.affects,
      input.authorAgentId,
      input.onBehalfOf,
      input.supersedes,
    ],
  );
  return toNote(rows[0]!);
}

export async function listNotes(
  db: Queryable,
  filter: { projectId: string; specId?: string; sinceSeq?: number; limit: number },
): Promise<Note[]> {
  const { rows } = await db.query(
    `SELECT * FROM notes
      WHERE project_id = $1
        AND ($2::uuid IS NULL OR spec_id = $2)
        AND ($3::int IS NULL OR seq > $3)
      ORDER BY seq DESC
      LIMIT $4`,
    [filter.projectId, filter.specId ?? null, filter.sinceSeq ?? null, filter.limit],
  );
  return rows.map(toNote);
}

export async function findNoteById(db: Queryable, noteId: string): Promise<Note | null> {
  const { rows } = await db.query(`SELECT * FROM notes WHERE id = $1`, [noteId]);
  const row = rows[0];
  return row ? toNote(row) : null;
}

// 같은 프로젝트의 다른 에이전트들의 id와 이름. 과실 주장 판별에 쓴다.
// 자연어 심사가 아니라 이 목록과의 문자열 포함 검사만 한다 (P2).
export async function listOtherAgentIdentifiers(
  db: Queryable,
  projectId: string,
  selfAgentId: string,
): Promise<{ ids: string[]; names: string[] }> {
  const { rows } = await db.query(
    `SELECT a.id, a.name FROM project_members m
       JOIN agents a ON a.id = m.agent_id
      WHERE m.project_id = $1 AND m.agent_id <> $2`,
    [projectId, selfAgentId],
  );
  return { ids: rows.map((r) => r.id as string), names: rows.map((r) => r.name as string) };
}

export async function findSpecFeatureKey(db: Queryable, specId: string): Promise<string | null> {
  const { rows } = await db.query(`SELECT feature_key FROM specs WHERE id = $1`, [specId]);
  return rows[0]?.feature_key ?? null;
}

// 프롬프트 주입 후보. 세 갈래를 한 번에 긁어온다:
//   같은 spec / 선행 태스크가 만든 것 / affects가 채워진 같은 프로젝트의 것
// 세 번째는 경로 겹침을 봐야 하는데 glob 매칭이 JS에 있으므로 여기서는 후보만 고른다.
// supersedes로 대체된 노트는 아예 제외한다 — 낡은 정보를 프롬프트에 넣으면 안 된다.
export async function listInjectionCandidates(
  db: Queryable,
  taskId: string,
  candidateCap: number,
): Promise<Note[]> {
  const { rows } = await db.query(
    `WITH RECURSIVE task AS (SELECT id, project_id, spec_id FROM tasks WHERE id = $1),
       -- 선행을 끝까지 따라간다(직접 선행만 보면 한 단계 건너뛴 태스크의 결정이 전달되지 않는다).
       ancestors(id) AS (
         SELECT depends_on FROM task_deps WHERE task_id = $1
         UNION
         SELECT d.depends_on FROM task_deps d JOIN ancestors a ON d.task_id = a.id
       )
     SELECT n.* FROM notes n, task t
      WHERE n.project_id = t.project_id
        AND n.id NOT IN (SELECT supersedes FROM notes WHERE supersedes IS NOT NULL)
        AND (
          (t.spec_id IS NOT NULL AND n.spec_id = t.spec_id)
          OR n.task_id IN (SELECT id FROM ancestors)
          OR n.kind = 'DECIDED'
          OR cardinality(n.affects) > 0
        )
      ORDER BY n.seq DESC
      LIMIT $2`,
    [taskId, candidateCap],
  );
  return rows.map(toNote);
}
