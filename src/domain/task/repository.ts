import type { QueryResultRow } from 'pg';
import type { Queryable } from '../../config/db.js';
import type { TeamRole } from '../roles.js';

export const TASK_STATES = [
  'READY',
  'CLAIMED',
  'IN_PROGRESS',
  'VERIFYING',
  'AWAITING_APPROVAL',
  'BLOCKED',
  'ESCALATED',
  'DONE',
] as const;

export type TaskState =
  | 'READY'
  | 'CLAIMED'
  | 'IN_PROGRESS'
  | 'VERIFYING'
  | 'AWAITING_APPROVAL'
  | 'BLOCKED'
  | 'ESCALATED'
  | 'DONE';

export type Task = {
  id: string;
  projectId: string;
  repoId: string;
  specId: string | null;
  kind: string;
  title: string;
  state: TaskState;
  teamRole: TeamRole | null;
  assigneeAgentId: string | null;
  branchName: string | null;
  blockedReason: string | null;
  retryCount: number;
  // 마지막 수령 시각(017). 화면의 "수령 후 경과"와 응답 없는 에이전트 감시가 쓴다. 수령한 적이 없으면 null.
  claimedAt: string | null;
};

function toTask(row: QueryResultRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    repoId: row.repo_id,
    specId: row.spec_id,
    kind: row.kind,
    title: row.title,
    state: row.state,
    teamRole: row.team_role,
    assigneeAgentId: row.assignee_agent_id,
    branchName: row.branch_name,
    blockedReason: row.blocked_reason,
    retryCount: row.retry_count,
    claimedAt: row.claimed_at ? (row.claimed_at as Date).toISOString() : null,
  };
}

export async function findTaskById(db: Queryable, taskId: string): Promise<Task | null> {
  const { rows } = await db.query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  const row = rows[0];
  return row ? toTask(row) : null;
}

// 아직 DONE이 아닌 선행 태스크의 수.
export async function countUnfinishedDeps(db: Queryable, taskId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM task_deps d
       JOIN tasks t ON t.id = d.depends_on
      WHERE d.task_id = $1 AND t.state <> 'DONE'`,
    [taskId],
  );
  return rows[0]!.n as number;
}

// 조건부 UPDATE 하나로 경합을 처리한다. 낙관적 잠금이지 트랜잭션 잠금이 아니다 —
// SELECT로 확인한 뒤 UPDATE하면 그 사이에 다른 에이전트가 먼저 잡을 수 있다.
// 진 쪽은 0행을 돌려받고, 그게 곧 "이미 CLAIM됨"이다.
export async function claimTaskRow(db: Queryable, taskId: string, agentId: string): Promise<Task | null> {
  const { rows } = await db.query(
    `UPDATE tasks
        SET state = 'CLAIMED', assignee_agent_id = $2, claimed_at = now(), updated_at = now()
      WHERE id = $1 AND state = 'READY' AND assignee_agent_id IS NULL
      RETURNING *`,
    [taskId, agentId],
  );
  const row = rows[0];
  return row ? toTask(row) : null;
}

export async function findArtifactById(db: Queryable, artifactId: string): Promise<Artifact | null> {
  const { rows } = await db.query(`SELECT * FROM artifacts WHERE id = $1`, [artifactId]);
  const row = rows[0];
  return row ? toArtifact(row) : null;
}

// 최신이 앞에 온다. Executor는 방금 모델이 제출한 것(= 첫 행)의 id를 알아야
// V2·V4 결과를 어디에 붙일지 정할 수 있다.
export async function listArtifactsForTask(db: Queryable, taskId: string): Promise<Artifact[]> {
  const { rows } = await db.query(
    `SELECT * FROM artifacts WHERE task_id = $1 ORDER BY attempt DESC`,
    [taskId],
  );
  return rows.map(toArtifact);
}

export type SpecTest = { id: string; criterion: string; testCode: string; lockedAt: string | null };

// 잠기지 않은(locked_at IS NULL) 시험지는 내려보내지 않는다. PM이 확정하기 전의 초안을
// 에이전트가 보면 "통과하도록 코드를 맞추는" 대상이 되고, 그러면 시험지의 의미가 사라진다.
export async function listLockedSpecTests(db: Queryable, specId: string): Promise<SpecTest[]> {
  const { rows } = await db.query(
    `SELECT id, criterion, test_code, locked_at FROM spec_tests
      WHERE spec_id = $1 AND locked_at IS NOT NULL
      ORDER BY created_at, id`,
    [specId],
  );
  return rows.map((r) => ({
    id: r.id,
    criterion: r.criterion,
    testCode: r.test_code,
    lockedAt: r.locked_at,
  }));
}

// V2가 PASS로 올라왔을 때 서버가 다시 보는 값. 산출물보다 **늦게** 잠긴 시험지는
// 결과를 보고 맞춘 것일 수 있으므로 통과의 근거가 될 수 없다.
export async function countSpecTestsLockedBefore(
  db: Queryable,
  specId: string,
  before: string,
): Promise<{ locked: number; lockedInTime: number }> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS locked,
            count(*) FILTER (WHERE locked_at < $2)::int AS locked_in_time
       FROM spec_tests WHERE spec_id = $1 AND locked_at IS NOT NULL`,
    [specId, before],
  );
  return { locked: rows[0]!.locked as number, lockedInTime: rows[0]!.locked_in_time as number };
}

export async function markTaskState(db: Queryable, taskId: string, state: TaskState): Promise<void> {
  await db.query(`UPDATE tasks SET state = $2, updated_at = now() WHERE id = $1`, [taskId, state]);
}

// 검증이 FAIL이면 재시도 횟수를 올리고 다시 잡을 수 있게 돌려놓는다.
// 상한에 닿으면 ESCALATED — 사람이 봐야 한다는 뜻이고, 이 상태에서는 자동 재시도가 없다.
// 한 문장으로 처리하는 이유는 "읽고 판단한 뒤 쓰면" 그 사이에 두 번째 FAIL이 끼어들어
// 같은 횟수를 두 번 쓸 수 있기 때문이다.
export async function failTaskForRetry(
  db: Queryable,
  taskId: string,
  maxRetries: number,
): Promise<{ state: TaskState; retryCount: number }> {
  const { rows } = await db.query(
    `UPDATE tasks
        SET retry_count = retry_count + 1,
            state = CASE WHEN retry_count + 1 >= $2 THEN 'ESCALATED' ELSE 'READY' END,
            -- READY로 돌아갈 때만 담당을 비운다. claimTaskRow가 assignee IS NULL을 요구하므로
            -- 비우지 않으면 아무도 다시 잡을 수 없다. ESCALATED는 누가 하던 일인지 남긴다.
            assignee_agent_id = CASE WHEN retry_count + 1 >= $2 THEN assignee_agent_id ELSE NULL END,
            updated_at = now()
      WHERE id = $1
      RETURNING state, retry_count`,
    [taskId, maxRetries],
  );
  const row = rows[0]!;
  return { state: row.state as TaskState, retryCount: row.retry_count as number };
}

export async function markTaskVerifying(db: Queryable, taskId: string): Promise<void> {
  await db.query(`UPDATE tasks SET state = 'VERIFYING', updated_at = now() WHERE id = $1`, [taskId]);
}

export type Artifact = {
  id: string;
  taskId: string;
  commitSha: string;
  changedPaths: string[];
  triggeredActions: string[];
  gateMode: string;
  attempt: number;
  createdAt: string;
};

function toArtifact(row: QueryResultRow): Artifact {
  return {
    id: row.id,
    taskId: row.task_id,
    commitSha: row.commit_sha,
    changedPaths: row.changed_paths,
    triggeredActions: row.triggered_actions,
    gateMode: row.gate_mode,
    attempt: row.attempt,
    createdAt: row.created_at,
  };
}

// 같은 트랜잭션 안에서 최대 attempt + 1을 계산해 넣는다. 유니크 제약이 있으므로
// 두 요청이 동시에 같은 번호를 노리면 한쪽이 실패한다 (조용히 덮어쓰지 않는다).
export async function insertArtifact(
  db: Queryable,
  input: { taskId: string; commitSha: string; changedPaths: string[]; triggeredActions: string[]; gateMode: string },
): Promise<Artifact> {
  const { rows } = await db.query(
    `INSERT INTO artifacts (task_id, commit_sha, changed_paths, triggered_actions, gate_mode, attempt)
     VALUES ($1, $2, $3, $4, $5,
             (SELECT coalesce(max(attempt), 0) + 1 FROM artifacts WHERE task_id = $1))
     RETURNING *`,
    [input.taskId, input.commitSha, input.changedPaths, input.triggeredActions, input.gateMode],
  );
  return toArtifact(rows[0]!);
}

// 선행 태스크 id 목록. 프롬프트 주입이 "의존 태스크가 만든 노트"를 고를 때 쓴다.
// 선행의 선행까지 전부(순환은 작성 검증이 막는다 — UNION이 한 번 더 막는다).
export async function listAncestorTaskIds(db: Queryable, taskId: string): Promise<string[]> {
  const { rows } = await db.query(
    `WITH RECURSIVE ancestors(id) AS (
       SELECT depends_on FROM task_deps WHERE task_id = $1
       UNION
       SELECT d.depends_on FROM task_deps d JOIN ancestors a ON d.task_id = a.id
     )
     SELECT id FROM ancestors`,
    [taskId],
  );
  return rows.map((r) => r.id as string);
}

export async function listDependencyTaskIds(db: Queryable, taskId: string): Promise<string[]> {
  const { rows } = await db.query(`SELECT depends_on FROM task_deps WHERE task_id = $1`, [taskId]);
  return rows.map((r) => r.depends_on as string);
}

export type TaskListFilter = { state?: string; teamRole?: TeamRole; limit: number };

// 웹 UI와 Executor 폴링이 같이 쓴다. 정렬은 결정적이어야 한다 —
// 폴링이 매번 다른 순서를 받으면 같은 태스크를 두고 경합이 늘어난다.
export async function listTasks(
  db: Queryable,
  projectId: string,
  filter: TaskListFilter,
): Promise<Task[]> {
  const { rows } = await db.query(
    `SELECT * FROM tasks
      WHERE project_id = $1
        AND ($2::text IS NULL OR state = $2)
        AND ($3::text IS NULL OR team_role = $3)
      ORDER BY created_at, id
      LIMIT $4`,
    [projectId, filter.state ?? null, filter.teamRole ?? null, filter.limit],
  );
  return rows.map(toTask);
}

export type TaskSpec = { id: string; featureKey: string; title: string; content: string };

export async function findSpecForTask(db: Queryable, specId: string): Promise<TaskSpec | null> {
  const { rows } = await db.query(
    `SELECT id, feature_key, title, content FROM specs WHERE id = $1`,
    [specId],
  );
  const row = rows[0];
  return row ? { id: row.id, featureKey: row.feature_key, title: row.title, content: row.content } : null;
}

// 브랜치 이름이 비어 있으면 Executor가 만들고 서버에 알린다.
// 서버가 정본을 들고 있어야 재실행·이어받기에서 같은 브랜치를 쓴다.
export async function setTaskBranch(db: Queryable, taskId: string, branchName: string): Promise<void> {
  await db.query(
    `UPDATE tasks SET branch_name = $2, updated_at = now() WHERE id = $1 AND branch_name IS NULL`,
    [taskId, branchName],
  );
}

// 프로젝트 시작(G1) 여부. 시작 전에는 태스크를 가져갈 수 없다.
export async function isProjectStarted(db: Queryable, projectId: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT started_at IS NOT NULL AS started FROM projects WHERE id = $1`, [projectId]);
  return rows[0]?.started === true;
}

// 이 역할의 에이전트가 **지금** 가져갈 수 있는 태스크 — 서버가 푸시하는 스냅샷이자, 끊겼을 때 폴링하는 목록이다.
// claimTask가 거부할 것은 처음부터 빼다: 시작 전 프로젝트, READY가 아님, 담당 있음, 다른 역할, 선행 미완료.
// team_role이 NULL인 태스크(역할 제한 없음)는 claimTask가 누구에게나 허용하므로 모든 역할에 보인다 — 먼저 잡는 쪽이 가져간다.
export async function listClaimableTasks(db: Queryable, projectId: string, teamRole: string): Promise<Task[]> {
  const { rows } = await db.query(
    `SELECT t.* FROM tasks t
       JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = $1
        AND p.started_at IS NOT NULL
        AND t.state = 'READY'
        AND t.assignee_agent_id IS NULL
        AND (t.team_role IS NULL OR t.team_role = $2)
        AND NOT EXISTS (
          SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on
           WHERE d.task_id = t.id AND dt.state <> 'DONE')
      ORDER BY t.created_at, t.id`,
    [projectId, teamRole],
  );
  return rows.map(toTask);
}

// ── 멈춘 태스크(BLOCKED · AGENT_STOPPED) ──────────────────────────────────

// 에이전트가 잡고 있던(CLAIMED·IN_PROGRESS) 태스크를 BLOCKED(AGENT_STOPPED)로. 담당은 남겨 둔다(누가 멈췄는지 화면에 보인다).
// 조건부 UPDATE라 그사이 제출로 상태가 바뀌었으면 아무것도 하지 않고 null.
export async function blockStoppedTask(db: Queryable, taskId: string): Promise<Task | null> {
  const { rows } = await db.query(
    `UPDATE tasks SET state = 'BLOCKED', blocked_reason = 'AGENT_STOPPED', updated_at = now()
      WHERE id = $1 AND state IN ('CLAIMED', 'IN_PROGRESS')
      RETURNING *`,
    [taskId],
  );
  return rows[0] ? toTask(rows[0]) : null;
}

// 대표가 재개: READY로 돌리고 담당을 비운다(같은 역할의 에이전트가 다시 가져간다). retry_count는 건드리지 않는다.
export async function resumeStoppedTask(db: Queryable, taskId: string): Promise<Task | null> {
  const { rows } = await db.query(
    `UPDATE tasks SET state = 'READY', blocked_reason = NULL, assignee_agent_id = NULL, updated_at = now()
      WHERE id = $1 AND state = 'BLOCKED' AND blocked_reason = 'AGENT_STOPPED'
      RETURNING *`,
    [taskId],
  );
  return rows[0] ? toTask(rows[0]) : null;
}

// 응답이 끊긴 수령: 잡은 지(claimed_at) threshold가 지났고, 그 뒤로 실행 보고·도구 사용이 threshold 동안 없는 태스크.
export async function listUnresponsiveClaims(db: Queryable, thresholdMs: number): Promise<{ taskId: string; projectId: string; orgId: string; agentId: string; onBehalfOf: string }[]> {
  const { rows } = await db.query(
    `SELECT t.id, t.project_id, p.org_id, t.assignee_agent_id, a.user_id
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       JOIN agents a ON a.id = t.assignee_agent_id
      WHERE t.state IN ('CLAIMED', 'IN_PROGRESS')
        AND t.claimed_at < now() - make_interval(secs => $1::float8 / 1000)
        AND NOT EXISTS (SELECT 1 FROM agent_activity aa
                         WHERE aa.task_id = t.id AND aa.ts > now() - make_interval(secs => $1::float8 / 1000))
        AND NOT EXISTS (SELECT 1 FROM events e
                         WHERE e.type IN ('AGENT_RUN_STARTED', 'AGENT_RUN_ENDED') AND e.payload->>'taskId' = t.id::text
                           AND e.ts > now() - make_interval(secs => $1::float8 / 1000))`,
    [thresholdMs],
  );
  return rows.map((r) => ({
    taskId: r.id as string,
    projectId: r.project_id as string,
    orgId: r.org_id as string,
    agentId: r.assignee_agent_id as string,
    onBehalfOf: r.user_id as string,
  }));
}
