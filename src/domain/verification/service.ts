import type { PoolClient } from 'pg';
import { withTransaction, type Queryable } from '../../config/db.js';
import { AppError } from '../../errors.js';
import { logger } from '../../config/logger.js';
import { appendEvent } from '../events/append.js';
import { getPolicySnapshot } from '../policy/policy-cache.js';
import { inspectPaths } from '../policy/scope-check.js';
import { findRepoById } from '../repo/repository.js';
import type { RepoPath } from '../repo/types.js';
import type { TeamRole } from '../roles.js';
import {
  countSpecTestsLockedBefore,
  failTaskForRetry,
  findArtifactById,
  findTaskById,
  markTaskState,
  type Artifact,
  type Task,
  type TaskState,
} from '../task/repository.js';
import { getCommitInspector, CommitNotFoundError, InspectionSkipped } from './commit-inspector.js';
import {
  insertVerification,
  listVerifications,
  type VerificationInput,
  type VerificationResult,
  type VerificationStage,
} from './repository.js';

// ⑦(계약) 전까지 V1A가 돌 수 없는 이유. "LLM 판정이 필요해서"가 아니다 —
// OpenAPI는 기계가 읽는 형식이고 응답 스키마·상태코드·필드명 비교는 결정적이다(P2 위반 아님).
// 비교 대상인 contracts.schema_yaml을 담을 테이블이 아직 없을 뿐이다.
const V1A_SKIP_REASON = 'contracts 테이블 미구현 — ⑦ 이후 가능';

// AWAITING_APPROVAL에서 나올 길이 아직 없다. approvals 테이블은 ERD에만 있고 승인·반려 API도
// 없으므로, 이 상태에 들어간 태스크는 사람이 DB를 직접 고치기 전까지 멈춰 있다.
// 조용히 멈추면 "왜 안 도나"를 로그에서 찾을 수 없어 경고·이벤트·응답 세 곳에 같은 문장을 남긴다.
// 승인 API가 생기면 이 상수와 사용처를 지우는 것이 그 작업의 체크리스트다.
const APPROVAL_PATH_MISSING =
  '승인 경로 미구현 — approvals 테이블과 승인 API가 없어 이 태스크는 AWAITING_APPROVAL에서 더 진행되지 않는다';

// 이 세 단계가 전부 보고돼야 태스크가 끝난다.
// V1A·V1B가 빠진 이유는 "선택"이기 때문이다 — 계약이 없는 태스크, 배포 주소가 없는 레포가 정상이다.
// 대신 SKIPPED를 PASS로 적지 않으므로 나중에 무엇이 실제로 검증됐는지 셀 수 있다.
const REQUIRED_STAGES: VerificationStage[] = ['V3', 'V2', 'V4'];

export const MAX_RETRIES = 3;

export type StageOutcome = { stage: VerificationStage; result: VerificationResult };

export type VerificationSummary = {
  artifactId: string;
  attempt: number;
  stages: StageOutcome[];
  // DONE·AWAITING_APPROVAL·RETRY·ESCALATED·PENDING(아직 보고 안 된 단계가 있음)·SETTLED(이미 결론남)
  outcome: string;
  taskState: TaskState;
  retryCount: number;
  // 결론은 났지만 그 상태에서 나올 경로가 아직 없을 때의 안내. 지금은 AWAITING_APPROVAL 하나뿐이다.
  notice?: string;
};

type Plan = {
  artifact: Artifact;
  task: Task;
  repo: {
    id: string;
    orgId: string;
    cloneUrl: string | null;
    githubRepoId: number | null;
    devBaseUrl: string | null;
  };
  rules: RepoPath[];
  teamRole: TeamRole;
};

// ── V3 — 경로 검사 ────────────────────────────────────────────────────────
// 신고한 changed_paths가 아니라 커밋의 **실제** diff를 기준으로 본다.
// 신고를 믿으면 신고에서 빼버린 파일은 아무 검사도 받지 않는다.

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

async function evaluateV3(plan: Plan): Promise<VerificationInput> {
  const started = Date.now();
  const base = { artifactId: plan.artifact.id, stage: 'V3' as const, executedBy: 'server' as const };
  const done = (result: VerificationResult, detail: Record<string, unknown>): VerificationInput => ({
    ...base,
    result,
    detail,
    durationMs: Date.now() - started,
  });

  let actual: string[];
  try {
    // 읽을 수 있는 전제(clone_url, github_repo_id, 대표 GitHub 연결)는 구현체마다 다르므로 구현체가 판단한다.
    actual = await getCommitInspector().changedPaths({
      repoId: plan.repo.id,
      orgId: plan.repo.orgId,
      cloneUrl: plan.repo.cloneUrl,
      githubRepoId: plan.repo.githubRepoId,
      commitSha: plan.artifact.commitSha,
    });
  } catch (err) {
    if (err instanceof CommitNotFoundError) {
      // 없는 커밋을 제출한 것이다. 못 읽은 게 아니라 틀린 것이므로 FAIL이다.
      return done('FAIL', { reason: 'commit not found', commitSha: plan.artifact.commitSha });
    }
    if (err instanceof InspectionSkipped) {
      return done('SKIPPED', { reason: err.reason, inspector: getCommitInspector().kind });
    }
    // 서버 쪽 사정(디스크·네트워크)으로 못 읽었다. 이걸 FAIL로 적으면 에이전트가
    // 자기 잘못이 아닌 일로 재시도 횟수를 잃는다.
    logger.warn('V3 diff 취득 실패', { artifactId: plan.artifact.id, err: String(err) });
    return done('SKIPPED', { reason: `diff 취득 실패: ${String(err)}` });
  }

  const declaredSet = new Map(plan.artifact.changedPaths.map((p) => [normalize(p), p]));
  const actualSet = new Map(actual.map((p) => [normalize(p), p]));

  // 신고 누락 — 실제로 건드렸는데 제출에서 빠진 것. V3가 존재하는 이유가 이 항목이다.
  const undeclared = [...actualSet].filter(([k]) => !declaredSet.has(k)).map(([, v]) => v);
  // 과다 신고 — 안 건드렸는데 신고한 것. 감사 기록이 실제와 어긋나므로 통과시키지 않는다.
  const overdeclared = [...declaredSet].filter(([k]) => !actualSet.has(k)).map(([, v]) => v);

  if (undeclared.length > 0 || overdeclared.length > 0) {
    return done('FAIL', {
      reason: 'changed_paths가 커밋의 실제 diff와 다르다',
      commitSha: plan.artifact.commitSha,
      undeclared,
      overdeclared,
    });
  }

  // 실제 diff의 모든 경로를 3·4단계에 다시 태운다. 제출 시점 검사와 같은 판정기다.
  const verdict = inspectPaths(plan.rules, actual, plan.teamRole, true);
  if (!verdict.ok) {
    return done('FAIL', {
      reason: verdict.detail,
      deniedStage: verdict.stage,
      // 집계용 구분(TOOL_DENIED payload의 reason과 같은 값). 여기서 reason은 사람이 읽는 문구라 키를 달리한다.
      denialReason: verdict.reason,
      path: verdict.path,
      ownerRole: verdict.ownerRole,
      pathViolation: verdict.pathViolation,
    });
  }

  return done('PASS', { pathCount: actual.length, inspector: getCommitInspector().kind });
}

// ── V1B — 실제 응답 ───────────────────────────────────────────────────────
// 계약(⑦)이 없으므로 지금 결정적으로 볼 수 있는 것은 "배포된 개발 서버가 살아 있는가"뿐이다.
// 응답 스키마 대조는 contracts가 생긴 뒤 V1A와 같은 자리에서 붙는다.
const V1B_TIMEOUT_MS = 5_000;

async function evaluateV1B(plan: Plan): Promise<VerificationInput> {
  const started = Date.now();
  const base = { artifactId: plan.artifact.id, stage: 'V1B' as const, executedBy: 'server' as const };
  const done = (result: VerificationResult, detail: Record<string, unknown>): VerificationInput => ({
    ...base,
    result,
    detail,
    durationMs: Date.now() - started,
  });

  if (plan.repo.devBaseUrl === null) {
    return done('SKIPPED', { reason: 'repos.dev_base_url 미설정 — 호출할 배포본이 없다' });
  }

  try {
    const res = await fetch(plan.repo.devBaseUrl, { signal: AbortSignal.timeout(V1B_TIMEOUT_MS) });
    // 5xx는 배포본이 실제로 깨진 것이므로 FAIL이다.
    return res.status >= 500
      ? done('FAIL', {
          reason: `dev 배포본이 ${res.status}로 답했다`,
          status: res.status,
          url: plan.repo.devBaseUrl,
        })
      : done('PASS', { checked: 'liveness', status: res.status, url: plan.repo.devBaseUrl });
  } catch (err) {
    // 연결 자체가 안 되는 것은 팀원 노트북이 꺼져 있는 경우가 대부분이다.
    // 이걸 FAIL로 적으면 코드와 무관한 이유로 태스크가 재시도 횟수를 잃는다.
    return done('SKIPPED', {
      reason: `dev 배포본에 연결할 수 없다: ${String(err)}`,
      url: plan.repo.devBaseUrl,
    });
  }
}

// ── 결론 ──────────────────────────────────────────────────────────────────

async function settle(tx: Queryable, artifact: Artifact, task: Task): Promise<VerificationSummary> {
  const all = await listVerifications(tx, artifact.id);
  const stages: StageOutcome[] = all.map((v) => ({ stage: v.stage, result: v.result }));
  const summary = (
    outcome: string,
    taskState: TaskState,
    retryCount: number,
    notice?: string,
  ): VerificationSummary => ({
    artifactId: artifact.id,
    attempt: artifact.attempt,
    stages,
    outcome,
    taskState,
    retryCount,
    ...(notice === undefined ? {} : { notice }),
  });

  // 이미 결론이 난 뒤 늦게 도착한 보고는 상태를 건드리지 않는다.
  // 건드리면 한 번의 FAIL로 retry_count가 두 번 오를 수 있다.
  if (task.state !== 'VERIFYING') {
    return summary('SETTLED', task.state, task.retryCount);
  }

  if (all.some((v) => v.result === 'FAIL')) {
    const next = await failTaskForRetry(tx, task.id, MAX_RETRIES);
    return summary(next.state === 'ESCALATED' ? 'ESCALATED' : 'RETRY', next.state, next.retryCount);
  }

  const reported = new Set(all.map((v) => v.stage));
  if (!REQUIRED_STAGES.every((s) => reported.has(s))) {
    return summary('PENDING', task.state, task.retryCount);
  }

  // 전부 통과했어도 정책 게이트가 AUTO가 아니면 사람·PM의 승인이 남아 있다.
  // 여기서 DONE으로 적으면 6단계 게이트를 검증이 대신 열어주는 셈이 된다.
  const next: TaskState = artifact.gateMode === 'AUTO' ? 'DONE' : 'AWAITING_APPROVAL';
  await markTaskState(tx, task.id, next);
  if (next === 'DONE') return summary(next, next, task.retryCount);

  logger.warn(APPROVAL_PATH_MISSING, {
    taskId: task.id,
    artifactId: artifact.id,
    gateMode: artifact.gateMode,
  });
  return summary(next, next, task.retryCount, APPROVAL_PATH_MISSING);
}

type EventContext = {
  orgId: string;
  projectId: string;
  onBehalfOf: string;
  policyHash: string;
  agentId?: string;
};

async function recordSummary(
  tx: PoolClient,
  ctx: EventContext,
  task: Task,
  summary: VerificationSummary,
): Promise<void> {
  await appendEvent(tx, {
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    type: 'VERIFICATION_COMPLETED',
    ...(ctx.agentId === undefined ? {} : { actorAgentId: ctx.agentId }),
    onBehalfOf: ctx.onBehalfOf,
    policyHash: ctx.policyHash,
    payload: {
      taskId: task.id,
      artifactId: summary.artifactId,
      attempt: summary.attempt,
      stages: summary.stages,
      outcome: summary.outcome,
      taskState: summary.taskState,
      retryCount: summary.retryCount,
      ...(summary.notice === undefined ? {} : { notice: summary.notice }),
    },
  });
}

// ── 서버 단계 실행 ────────────────────────────────────────────────────────
// 제출 응답 안에서 동기로 돈다. V1A·V1B·V3는 전부 서버가 혼자 판정할 수 있고,
// 비동기로 돌리면 "제출은 됐는데 결과는 언제 오는가"를 관리하는 상태가 하나 더 는다.
//
// git fetch와 HTTP 호출은 **트랜잭션 밖**에서 한다. 안에서 하면 네트워크가 느린 동안
// 커넥션과 행 잠금을 잡고 있게 된다.

export async function runServerVerifications(
  ctx: EventContext,
  artifactId: string,
): Promise<VerificationSummary> {
  const plan = await withTransaction<Plan>(async (tx) => {
    const artifact = await findArtifactById(tx, artifactId);
    if (!artifact) throw new AppError('ARTIFACT_NOT_FOUND', `artifact ${artifactId} not found`);
    const task = await findTaskById(tx, artifact.taskId);
    if (!task) throw new AppError('TASK_NOT_FOUND', `task ${artifact.taskId} not found`);
    const repo = await findRepoById(tx, task.repoId);
    if (!repo) throw new AppError('REPO_NOT_FOUND', `repository ${task.repoId} not found`);

    const snapshot = await getPolicySnapshot(tx, ctx.projectId, ctx.policyHash);
    return {
      artifact,
      task,
      repo: {
        id: repo.id,
        orgId: repo.orgId,
        cloneUrl: repo.cloneUrl,
        githubRepoId: repo.githubRepoId,
        devBaseUrl: repo.devBaseUrl,
      },
      rules: snapshot.repoPaths.filter((p) => p.repoId === task.repoId),
      // 태스크에 역할 제한이 없으면(통합 태스크) 소유권 판정은 소유자 없는 규칙만 통과시킨다.
      // 제출 시점 판정과 같은 기준을 재현하기만 하면 된다 — 새 판정을 만들지 않는다.
      teamRole: (task.teamRole ?? 'BACKEND') as TeamRole,
    };
  });

  const results: VerificationInput[] = [
    {
      artifactId,
      stage: 'V1A',
      result: 'SKIPPED',
      executedBy: 'server',
      detail: {
        reason: V1A_SKIP_REASON,
        compares: 'contracts.schema_yaml(OpenAPI)과 실제 응답의 스키마·상태코드·필드명',
      },
    },
    await evaluateV1B(plan),
    await evaluateV3(plan),
  ];

  return withTransaction(async (tx) => {
    for (const r of results) await insertVerification(tx, r);
    // 결론을 내리기 직전에 태스크를 다시 읽는다 — 위 I/O 동안 상태가 바뀌었을 수 있다.
    const task = (await findTaskById(tx, plan.task.id))!;
    const summary = await settle(tx, plan.artifact, task);
    await recordSummary(tx, ctx, task, summary);
    return summary;
  });
}

// ── 브릿지 단계 보고 ──────────────────────────────────────────────────────
// V2(PM 시험지)·V4(린트)는 작업공간이 있어야 돌 수 있다. 제출 시점에는 결과가 물리적으로
// 존재할 수 없으므로 별도 엔드포인트로 받는다. 받는 쪽은 결과를 적고 결론만 다시 계산한다.

export type BridgeVerificationInput = {
  stage: VerificationStage;
  result: VerificationResult;
  detail: Record<string, unknown>;
  durationMs?: number;
};

export async function recordBridgeVerification(
  ctx: EventContext & { agentId: string },
  artifactId: string,
  input: BridgeVerificationInput,
): Promise<VerificationSummary> {
  return withTransaction(async (tx) => {
    const artifact = await findArtifactById(tx, artifactId);
    if (!artifact) throw new AppError('ARTIFACT_NOT_FOUND', `artifact ${artifactId} not found`);
    const task = await findTaskById(tx, artifact.taskId);
    if (!task || task.projectId !== ctx.projectId) {
      throw new AppError('ARTIFACT_NOT_FOUND', `artifact ${artifactId} not found`);
    }
    // 남의 태스크 결과를 대신 보고할 수 없다. 보고가 상태를 바꾸므로 담당자 확인이 필요하다.
    if (task.assigneeAgentId !== ctx.agentId) {
      throw new AppError('NOT_TASK_ASSIGNEE', 'task is assigned to another agent');
    }
    // 서버가 판정하는 단계를 브릿지가 보고할 수 없다. 로컬을 믿지 않는 것이 V3의 전제다.
    if (input.stage !== 'V2' && input.stage !== 'V4') {
      throw new AppError('VERIFICATION_STAGE_NOT_REPORTABLE', `stage ${input.stage} is judged by the server`);
    }
    if (input.result === 'SKIPPED' && typeof input.detail.reason !== 'string') {
      throw new AppError('VALIDATION_ERROR', 'SKIPPED must carry detail.reason');
    }

    // V2는 "PM이 미리 잠근 시험지를 통과했는가"이지 "로컬에서 테스트가 초록이었는가"가 아니다.
    // 산출물보다 늦게 잠긴 시험지는 결과를 보고 맞춘 것일 수 있어 통과의 근거가 되지 못하므로,
    // 브릿지가 PASS를 보고해도 서버가 시각을 다시 보고 뒤집는다.
    let result = input.result;
    let detail = input.detail;
    if (input.stage === 'V2' && result === 'PASS') {
      if (task.specId === null) {
        result = 'SKIPPED';
        detail = { ...detail, reason: '태스크에 spec이 없어 대조할 시험지가 없다' };
      } else {
        const { locked, lockedInTime } = await countSpecTestsLockedBefore(tx, task.specId, artifact.createdAt);
        if (locked === 0) {
          result = 'SKIPPED';
          detail = { ...detail, reason: '잠긴 spec_tests가 없다' };
        } else if (lockedInTime < locked) {
          result = 'FAIL';
          detail = {
            ...detail,
            reason: '산출물보다 늦게 잠긴 시험지가 있다 — 결과를 보고 맞춘 시험지일 수 있다',
            locked,
            lockedInTime,
          };
        }
      }
    }

    const inserted = await insertVerification(tx, {
      artifactId,
      stage: input.stage,
      result,
      executedBy: 'bridge',
      detail,
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    });
    if (!inserted) {
      throw new AppError(
        'VERIFICATION_ALREADY_RECORDED',
        `${input.stage} is already recorded for this artifact`,
      );
    }

    const summary = await settle(tx, artifact, task);
    await recordSummary(tx, ctx, task, summary);
    return summary;
  });
}

export async function getArtifactVerifications(artifactId: string) {
  return withTransaction((tx) => listVerifications(tx, artifactId));
}
