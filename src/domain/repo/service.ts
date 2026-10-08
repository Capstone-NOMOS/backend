import type { PoolClient } from 'pg';
import { pool, withTransaction, type Queryable } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors.js';
import { appendEvent } from '../events/append.js';
import { recomputePolicyHashesForRepo } from '../policy/policy-hash.js';
import { githubRepApi } from '../github/rep-api.js';
import { isGithubFullName, representativeGithubToken } from '../github/rep-token.js';
import { findLatestOauthSession } from '../oauth/repository.js';
import { findRepoUsage } from '../project/repository.js';
import { decryptSecret } from '../../utils/secret-box.js';
import { logger } from '../../config/logger.js';
import { validateCloneUrl } from './clone-url.js';
import { validatePattern } from './glob.js';
import {
  findOtherRepoByGithubId,
  findRepoById,
  findRepoPathById,
  insertRepo,
  insertRepoPath,
  insertSeedRepoPaths,
  listRepoIdsWithOwnership,
  listRepoPaths,
  listReposByOrg,
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

export type ConnectRepoInput = { fullName: string; githubRepoId?: number; defaultBranch?: string; ownerRole?: OwnerRole };
export type ConnectRepoResult = { id: string; fullName: string; seededPathCount: number; rootOwnerRole: OwnerRole | null };

// 레포들을 조직에 연결한다. 레포마다 (INSERT repos -> 기본 경로 규칙 시드 -> REPO_CONNECTED
// 이벤트)를 하나의 트랜잭션으로 묶는다.
//
// ownerRole을 주면 같은 트랜잭션에서 '**' 행의 소유 역할도 지정한다 — 온보딩 화면이 "레포 + 역할 선택" 한 번으로 끝나게.
// 연결은 멤버 누구나 하지만 **소유권 지정은 대표 전용**이다(관문은 소유권이다). 그래서 대표가 아닌데 ownerRole이 하나라도
// 있으면 아무것도 연결하지 않고 403 — 연결만 되고 역할은 빠지는 반쪽 결과를 남기지 않는다. 소유권 변경은 PATCH와 같은 이벤트를 남긴다.
export async function connectRepos(input: {
  orgId: string;
  actorUserId: string;
  actorOrgRole?: string;
  repos: ConnectRepoInput[];
}): Promise<ConnectRepoResult[]> {
  if (input.repos.some((r) => r.ownerRole !== undefined) && input.actorOrgRole !== 'REPRESENTATIVE') {
    throw new AppError('NOT_REPRESENTATIVE', 'only the organization representative can assign path ownership (ownerRole)');
  }
  // GitHub 호출은 트랜잭션 밖에서 끝낸다.
  const repos = await fillFromGithub(input.orgId, input.repos);
  return withTransaction(async (tx) => {
    const results: ConnectRepoResult[] = [];
    for (const r of repos) {
      results.push(await connectOneRepo(tx, input.orgId, input.actorUserId, r));
    }
    return results;
  });
}

// 직접 입력(fullName만)으로 연결해도 대표의 GitHub 토큰으로 레포를 찾아 github_repo_id·기본 브랜치·clone_url을 채운다 —
// 비어 있으면 V3가 SKIPPED로 남는다(운영 테스트에서 그랬다). 대표가 GitHub를 연결하지 않았거나 레포가 안 보이면 예전처럼 비워 둔다(연결은 막지 않는다).
// 이름은 GitHub의 정본(full_name)으로 맞춘다 — 대소문자가 다르게 입력되면 같은 레포가 두 번 연결될 수 있다.
async function fillFromGithub(orgId: string, repos: ConnectRepoInput[]): Promise<(ConnectRepoInput & { cloneUrl?: string })[]> {
  if (repos.every((r) => r.githubRepoId !== undefined)) return repos;
  const token = await representativeGithubToken(pool, orgId);
  if (token === null) return repos;
  const filled: (ConnectRepoInput & { cloneUrl?: string })[] = [];
  for (const r of repos) {
    if (r.githubRepoId !== undefined || !isGithubFullName(r.fullName)) {
      filled.push(r);
      continue;
    }
    try {
      const found = await githubRepApi().getRepo(token, r.fullName);
      filled.push(
        found === null
          ? r
          : {
              ...r,
              fullName: found.fullName,
              githubRepoId: found.githubRepoId,
              defaultBranch: r.defaultBranch ?? found.defaultBranch,
              cloneUrl: validateCloneUrl(`https://github.com/${found.fullName}`, env.COMMIT_INSPECTOR),
            },
      );
    } catch (err) {
      logger.warn('GitHub repo lookup failed; connecting without github_repo_id', { fullName: r.fullName, error: String(err) });
      filled.push(r);
    }
  }
  return filled;
}

// 레포 하나 연결: INSERT repos → 기본 경로 규칙 시드 → REPO_CONNECTED → (ownerRole이 있으면) '**' 소유 역할 지정.
// 기존 레포 연결과 GitHub에 새로 만든 레포 연결이 같은 한 벌을 탄다.
async function connectOneRepo(
  tx: PoolClient,
  orgId: string,
  actorUserId: string,
  r: ConnectRepoInput & { cloneUrl?: string; createdOnGithub?: { githubOrg: string; githubRepoId: number } },
): Promise<ConnectRepoResult> {
  const repo = await insertRepo(tx, {
    orgId: orgId,
    fullName: r.fullName,
    githubRepoId: r.githubRepoId,
    defaultBranch: r.defaultBranch,
    cloneUrl: r.cloneUrl,
  });
  const seeded = await insertSeedRepoPaths(tx, repo.id, SEED_PATH_RULES);
  await appendEvent(tx, {
    orgId: orgId,
    type: 'REPO_CONNECTED',
    onBehalfOf: actorUserId,
    payload: {
      repoId: repo.id,
      fullName: repo.fullName,
      seededPathCount: seeded.length,
      ...(r.createdOnGithub === undefined ? {} : { createdOnGithub: r.createdOnGithub }),
    },
  });
  let rootOwnerRole: OwnerRole | null = null;
  if (r.ownerRole !== undefined) {
    const root = seeded.find((p) => p.pathPattern === '**');
    if (!root) throw new Error('seed rules must include "**"');
    const updated = await updateRepoPathOwnership(tx, root.id, { ownerRole: r.ownerRole });
    await appendEvent(tx, {
      orgId: orgId,
      type: 'REPO_PATH_UPDATED',
      onBehalfOf: actorUserId,
      payload: {
        pathId: root.id,
        before: { ownerRole: root.ownerRole, access: root.access },
        after: { ownerRole: updated.ownerRole, access: updated.access },
      },
    });
    // 새 레포라 쓰는 프로젝트는 아직 없지만, 경로 규칙을 바꾸는 서비스는 항상 부른다(빠뜨리는 경로를 만들지 않는다).
    await recomputePolicyHashesForRepo(tx, repo.id);
    rootOwnerRole = updated.ownerRole;
  }
  return { id: repo.id, fullName: repo.fullName, seededPathCount: seeded.length, rootOwnerRole };
}

export type CreateGithubRepoInput = {
  orgId: string;
  actorUserId: string;
  githubOrg: string;
  name: string;
  description?: string;
  ownerRole: OwnerRole;
};

export type CreateGithubRepoResult = ConnectRepoResult & { githubRepoId: number; defaultBranch: string; cloneUrl: string };

// GitHub 조직에 비공개 레포를 새로 만들고 곧바로 NOMOS에 연결한다(대표 전용 — 라우트가 막는다).
// 대표 본인의 GitHub 토큰으로 만든다. 팀 프로젝트라 개인 계정에는 만들지 않는다(대표 결정).
//
// - 첫 커밋은 파일 없는 빈 커밋이다(rep-api.ts). 브랜치가 있어야 Executor가 분기할 수 있다.
// - github_repo_id·clone_url을 함께 채운다 — 손으로 PATCH하지 않아도 V3가 처음부터 돈다. clone_url도 같은 검증을 거친다.
// - ownerRole은 필수다. 소유 역할이 없는 레포는 프로젝트에 넣을 수 없으므로(REPO_OWNERSHIP_NOT_SET) 만드는 김에 정한다.
// - GitHub 호출은 트랜잭션으로 되돌릴 수 없다. 만든 뒤 연결이 실패하면 GitHub에는 레포가 남는다 —
//   그 사실을 로그에 남기고, 대표는 기존 연결(POST /orgs/:orgId/repos)로 이어 붙일 수 있다.
export async function createGithubRepo(input: CreateGithubRepoInput): Promise<CreateGithubRepoResult> {
  const token = await representativeToken(input.actorUserId);
  const created = await githubRepApi().createOrgRepo(token, {
    org: input.githubOrg,
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
  });
  const cloneUrl = validateCloneUrl(`https://github.com/${created.fullName}`, env.COMMIT_INSPECTOR);

  try {
    const connected = await withTransaction((tx) =>
      connectOneRepo(tx, input.orgId, input.actorUserId, {
        fullName: created.fullName,
        githubRepoId: created.githubRepoId,
        defaultBranch: created.defaultBranch,
        ownerRole: input.ownerRole,
        cloneUrl,
        createdOnGithub: { githubOrg: input.githubOrg, githubRepoId: created.githubRepoId },
      }),
    );
    return { ...connected, githubRepoId: created.githubRepoId, defaultBranch: created.defaultBranch, cloneUrl };
  } catch (err) {
    logger.error('GitHub 레포는 만들어졌지만 NOMOS 연결에 실패했다 — POST /orgs/:orgId/repos로 다시 연결할 수 있다', {
      fullName: created.fullName,
      error: String(err),
    });
    throw err;
  }
}

// 대표가 레포를 만들 수 있는 GitHub 조직 목록(대표 전용).
export async function listGithubOrgs(actorUserId: string): Promise<string[]> {
  return githubRepApi().listOrgs(await representativeToken(actorUserId));
}

// 대표 본인의 GitHub 토큰(평문은 이 함수 밖으로 GitHub 호출에만 쓴다).
async function representativeToken(userId: string): Promise<string> {
  const session = await findLatestOauthSession(pool, userId);
  if (session === null) {
    throw new AppError('GITHUB_NOT_LINKED', 'GitHub 계정이 연결되어 있지 않습니다 — 먼저 GitHub를 연결하세요(POST /api/auth/github/device/start)');
  }
  return decryptSecret(session.githubTokenEnc);
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

// GET /api/orgs/:orgId/repos — 연결된 레포 목록(조직 멤버 누구나. 연결 자체가 멤버에게 열려 있다).
// ownershipAssigned=false인 레포는 프로젝트에 넣으면 422 REPO_OWNERSHIP_NOT_SET이 난다 — 화면이 미리 알려줄 수 있게.
export type RepoListItem = RepoSettings & {
  ownershipAssigned: boolean;
  activeProjectId: string | null;
  activeProjectName: string | null;
};

export async function listRepos(orgId: string): Promise<RepoListItem[]> {
  const repos = await listReposByOrg(pool, orgId);
  const owned = await listRepoIdsWithOwnership(pool, orgId);
  // 진행 중 프로젝트가 쓰고 있는가 — 프로젝트 생성의 REPO_IN_ACTIVE_PROJECT와 같은 판정(findRepoUsage)이다.
  const usage = new Map((await findRepoUsage(pool, repos.map((r) => r.id))).map((u) => [u.repoId, u]));
  return repos.map((repo) => {
    const used = usage.get(repo.id);
    return {
      ...toSettings(repo),
      ownershipAssigned: owned.has(repo.id),
      activeProjectId: used?.projectId ?? null,
      activeProjectName: used?.projectName ?? null,
    };
  });
}
