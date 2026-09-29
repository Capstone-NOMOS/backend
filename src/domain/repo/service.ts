import { pool, withTransaction, type Queryable } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors.js';
import { appendEvent } from '../events/append.js';
import { recomputePolicyHashesForRepo } from '../policy/policy-hash.js';
import { validateCloneUrl } from './clone-url.js';
import { validatePattern } from './glob.js';
import {
  findOtherRepoByGithubId,
  findRepoById,
  findRepoPathById,
  insertRepo,
  insertRepoPath,
  insertSeedRepoPaths,
  listRepoPaths,
  maxPriorityInBand,
  updateRepoPathOwnership,
  updateRepoSettings as updateRepoSettingsRow,
  type Repo,
} from './repository.js';
import { PRIORITY_BAND, SEED_PATH_RULES } from './seed-paths.js';
import type { OwnerRole, RepoPath } from './types.js';

// repoId가 orgId 소속인지 확인한다. 존재하지 않으면 404, 다른 조직 소유면 403(CROSS_ORG_ACCESS).
// 모든 라우트가 이 검사를 거치도록 강제해 다른 조직의 리소스 접근을 막는다.
async function assertRepoInOrg(db: Queryable, orgId: string, repoId: string): Promise<Repo> {
  const repo = await findRepoById(db, repoId);
  if (!repo) {
    throw new AppError('REPO_NOT_FOUND', `repo ${repoId} not found`);
  }
  if (repo.orgId !== orgId) {
    throw new AppError('CROSS_ORG_ACCESS', `repo ${repoId} does not belong to this organization`);
  }
  return repo;
}

export type ConnectRepoInput = { fullName: string; githubRepoId?: number; defaultBranch?: string };
export type ConnectRepoResult = { id: string; fullName: string; seededPathCount: number };

// 레포들을 조직에 연결한다. 레포마다 (INSERT repos -> 기본 경로 규칙 시드 -> REPO_CONNECTED
// 이벤트)를 하나의 트랜잭션으로 묶는다.
export async function connectRepos(input: {
  orgId: string;
  actorUserId: string;
  repos: ConnectRepoInput[];
}): Promise<ConnectRepoResult[]> {
  return withTransaction(async (tx) => {
    const results: ConnectRepoResult[] = [];
    for (const r of input.repos) {
      const repo = await insertRepo(tx, {
        orgId: input.orgId,
        fullName: r.fullName,
        githubRepoId: r.githubRepoId,
        defaultBranch: r.defaultBranch,
      });
      const seeded = await insertSeedRepoPaths(tx, repo.id, SEED_PATH_RULES);
      await appendEvent(tx, {
        orgId: input.orgId,
        type: 'REPO_CONNECTED',
        onBehalfOf: input.actorUserId,
        payload: { repoId: repo.id, fullName: repo.fullName, seededPathCount: seeded.length },
      });
      results.push({ id: repo.id, fullName: repo.fullName, seededPathCount: seeded.length });
    }
    return results;
  });
}

// 레포의 경로 규칙 전체를 조회한다 (priority 내림차순, repository 레이어에서 정렬).
export async function getRepoPaths(orgId: string, repoId: string): Promise<RepoPath[]> {
  const repo = await assertRepoInOrg(pool, orgId, repoId);
  return listRepoPaths(pool, repo.id);
}

export type UpdatePathOwnershipInput = {
  ownerRole?: OwnerRole | null;
  access?: 'write' | 'read' | 'denied';
};

// 경로 소유권(owner_role) / 접근 등급(access)을 수정한다. actionKey, priority는 여기서 바뀌지 않는다
// (호출부가 애초에 그 필드를 받지 않는다). 조직 상한(priority 900+) 행은 어떤 필드도 바꿀 수 없다 —
// '.env' 차단과 '.env.example' 예외처럼 조직 전체에 걸린 규칙이라 레포 단위 조정 대상이 아니다.
export async function updatePathOwnership(
  orgId: string,
  actorUserId: string,
  repoId: string,
  pathId: string,
  updates: UpdatePathOwnershipInput,
): Promise<RepoPath> {
  return withTransaction(async (tx) => {
    const repo = await assertRepoInOrg(tx, orgId, repoId);
    const existing = await findRepoPathById(tx, repo.id, pathId);
    if (!existing) {
      throw new AppError('PATH_NOT_FOUND', `path ${pathId} not found on repo ${repoId}`);
    }
    if (existing.priority >= PRIORITY_BAND.orgCeiling.min) {
      throw new AppError('IMMUTABLE_ORG_CEILING', `"${existing.pathPattern}" is an organization ceiling rule`);
    }

    const before = { ownerRole: existing.ownerRole, access: existing.access };
    const updated = await updateRepoPathOwnership(tx, pathId, updates);
    const after = { ownerRole: updated.ownerRole, access: updated.access };

    await appendEvent(tx, {
      orgId,
      type: 'REPO_PATH_UPDATED',
      onBehalfOf: actorUserId,
      payload: { pathId, before, after },
    });

    // 경로 규칙이 바뀌면 이 레포를 쓰는 프로젝트의 policy_hash가 달라져야 한다.
    // 이걸 빠뜨리면 이미 발급된 에이전트 토큰이 만료까지 옛 규칙으로 통과한다.
    await recomputePolicyHashesForRepo(tx, repo.id);

    return updated;
  });
}

export type AddRepoPathInput = {
  pathPattern: string;
  ownerRole?: OwnerRole | null;
  access: 'write' | 'read' | 'denied';
  priority?: number; // manual 대역(200~299). 라우트 스키마가 범위를 검증한다
};

// 레포 내부를 세분화하는 경로 규칙을 하나 추가한다 (source='manual').
// priority를 안 주면 manual 대역에서 가장 큰 값 + 1 — 나중에 추가한 규칙이 이긴다.
// 레포 안에서 priority는 유일하므로 사전순 폴백이 발동하지 않는다.
// 규칙 추가도 상태 변화이므로 INSERT와 이벤트를 한 트랜잭션으로 묶는다(P5).
// 새로 생기는 행이라 before는 빈 객체다 — REPO_PATH_UPDATED payload에서 before가 {}이면 생성을 뜻한다.
export async function addRepoPath(
  orgId: string,
  actorUserId: string,
  repoId: string,
  input: AddRepoPathInput,
): Promise<RepoPath> {
  validatePattern(input.pathPattern);
  const band = PRIORITY_BAND.manual;

  return withTransaction(async (tx) => {
    const repo = await assertRepoInOrg(tx, orgId, repoId);

    let priority = input.priority;
    if (priority === undefined) {
      const max = await maxPriorityInBand(tx, repo.id, band.min, band.max);
      priority = max === null ? band.min : max + 1;
      if (priority > band.max) {
        throw new AppError('PATH_PRIORITY_TAKEN', `manual priority band ${band.min}~${band.max} is full`);
      }
    }

    const path = await insertRepoPath(tx, {
      repoId: repo.id,
      pathPattern: input.pathPattern,
      ownerRole: input.ownerRole ?? null,
      access: input.access,
      actionKey: null,
      priority,
      source: 'manual',
    });

    await appendEvent(tx, {
      orgId,
      type: 'REPO_PATH_UPDATED',
      onBehalfOf: actorUserId,
      payload: {
        pathId: path.id,
        before: {},
        after: {
          pathPattern: path.pathPattern,
          ownerRole: path.ownerRole,
          access: path.access,
          actionKey: path.actionKey,
          priority: path.priority,
          source: path.source,
        },
      },
    });

    await recomputePolicyHashesForRepo(tx, repo.id);

    return path;
  });
}

export type UpdateRepoSettingsInput = { githubRepoId?: number | null; cloneUrl?: string | null };

// 레포 설정 화면이 보는 모양. 레포 행을 그대로 내지 않는다 — 나중에 비밀이 섞일 수 있는 컬럼이 생겨도 새지 않게.
export type RepoSettings = {
  id: string;
  fullName: string;
  githubRepoId: number | null;
  defaultBranch: string;
  devBranch: string;
  cloneUrl: string | null;
};

function toSettings(repo: Repo): RepoSettings {
  return {
    id: repo.id,
    fullName: repo.fullName,
    githubRepoId: repo.githubRepoId,
    defaultBranch: repo.defaultBranch,
    devBranch: repo.devBranch,
    cloneUrl: repo.cloneUrl,
  };
}

// V3가 커밋을 어디서 읽는지를 정하는 두 값을 고친다(대표 전용 — 라우트가 막는다).
//   github_repo_id  github 모드. 이름이 아니라 id로 찾으므로 레포 이름을 바꿔도 불변이다
//   clone_url       mirror 모드. 서버가 git clone에 넘기므로 validateCloneUrl이 보안 경계다
// 연결할 때 github_repo_id를 빠뜨리면 예전에는 SQL로 고쳐야 했다.
// 경로 규칙이 아니므로 policy_hash는 바뀌지 않는다.
export async function updateRepoSettings(
  orgId: string,
  actorUserId: string,
  repoId: string,
  input: UpdateRepoSettingsInput,
): Promise<RepoSettings> {
  const updates: UpdateRepoSettingsInput = {};
  if (input.githubRepoId !== undefined) updates.githubRepoId = input.githubRepoId;
  if (input.cloneUrl !== undefined) updates.cloneUrl = input.cloneUrl === null ? null : validateCloneUrl(input.cloneUrl, env.COMMIT_INSPECTOR);

  return withTransaction(async (tx) => {
    const repo = await assertRepoInOrg(tx, orgId, repoId);

    if (updates.githubRepoId !== undefined && updates.githubRepoId !== null) {
      const other = await findOtherRepoByGithubId(tx, orgId, updates.githubRepoId, repo.id);
      if (other) {
        throw new AppError(
          'REPO_ALREADY_CONNECTED',
          `github_repo_id ${updates.githubRepoId} is already used by ${other.fullName} (${other.id})`,
        );
      }
    }

    const updated = await updateRepoSettingsRow(tx, repo.id, updates);
    await appendEvent(tx, {
      orgId,
      type: 'REPO_UPDATED',
      onBehalfOf: actorUserId,
      payload: {
        repoId: repo.id,
        before: { githubRepoId: repo.githubRepoId, cloneUrl: repo.cloneUrl },
        after: { githubRepoId: updated.githubRepoId, cloneUrl: updated.cloneUrl },
      },
    });
    return toSettings(updated);
  });
}
