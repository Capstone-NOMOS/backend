import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../../config/db.js';
import { AppError } from '../../errors.js';
import { assignAgentsToOrg } from '../agent/repository.js';
import { appendEvent } from '../events/append.js';
import { checkCollaborator, hasGithubToken, listUserRepos, type GithubRepo } from '../github/client.js';
import { listReposByOrg } from '../repo/repository.js';
import {
  assignUserToOrg,
  findUserById,
  insertOrganization,
  listUsersByOrg,
} from './repository.js';

export type CreateOrgResult = {
  orgId: string;
  userId: string;
};

// 로그인한 사용자가 조직을 만들고 대표가 된다. 이미 조직이 있으면 409 — 단일 조직.
// 사용자가 먼저 존재하므로 순환 FK는 이 경로에서 문제가 되지 않지만,
// fk_org_created_by는 여전히 DEFERRABLE이라 INSERT 순서에 묶이지 않는다.
export async function createOrganization(userId: string, name: string): Promise<CreateOrgResult> {
  if (name.trim().length === 0) {
    throw new AppError('ORG_NAME_REQUIRED', 'organization name must not be empty');
  }

  const orgId = randomUUID();

  return withTransaction(async (tx) => {
    await insertOrganization(tx, { id: orgId, name, createdBy: userId });

    const user = await assignUserToOrg(tx, userId, orgId, 'REPRESENTATIVE');
    if (!user) {
      const existing = await findUserById(tx, userId);
      if (!existing) throw new AppError('UNAUTHENTICATED', 'user not found');
      throw new AppError('ALREADY_IN_ORG', 'user already belongs to an organization');
    }

    const agentIds = await assignAgentsToOrg(tx, userId, orgId);

    await appendEvent(tx, {
      orgId,
      type: 'ORG_CREATED',
      onBehalfOf: userId,
      payload: { orgName: name, userId, agentIds },
    });

    return { orgId, userId };
  });
}

export async function listAvailableGithubRepos(): Promise<GithubRepo[]> {
  return listUserRepos();
}

export type MemberView = {
  id: string;
  nickname: string | null;
  githubLogin: string | null;
  name: string | null;
  orgRole: string;
  isCollaborator?: boolean;
};

// GitHub 확인이 불가능하거나 실패해도 멤버 목록은 항상 반환한다(isCollaborator만 생략).
// GitHub 계정이 없는 로컬 사용자는 확인할 대상이 없으므로 역시 생략한다.
export async function listMembers(orgId: string): Promise<MemberView[]> {
  const users = await listUsersByOrg(pool, orgId);
  const base = (u: (typeof users)[number]): MemberView => ({
    id: u.id,
    nickname: u.nickname,
    githubLogin: u.githubLogin,
    name: u.name,
    orgRole: u.orgRole,
  });

  if (!hasGithubToken()) return users.map(base);

  const repos = await listReposByOrg(pool, orgId);
  if (repos.length === 0) return users.map(base);

  const results: MemberView[] = [];
  for (const u of users) {
    let isCollaborator: boolean | undefined;
    if (u.githubLogin !== null) {
      for (const repo of repos) {
        try {
          const result = await checkCollaborator(repo.fullName, u.githubLogin);
          isCollaborator = (isCollaborator ?? false) || result;
        } catch {
          continue;
        }
      }
    }
    results.push({ ...base(u), ...(isCollaborator === undefined ? {} : { isCollaborator }) });
  }
  return results;
}
