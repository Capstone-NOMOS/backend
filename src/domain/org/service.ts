import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../../config/db.js';
import { AppError } from '../../errors.js';
import {
  assignAgentsToOrg,
  detachUserAgentsFromOrg,
  listConnectedAgentsOfUser,
  markAgentDisconnected,
  revokeAgentTokens,
} from '../agent/repository.js';
import { agentRevoked } from '../dispatch/agent-revoked.js';
import { tasksChanged } from '../dispatch/tasks-changed.js';
import type { GithubRevokeResult } from '../events/types.js';
import { detachAgentFromActiveProject, revokeGithubAccess } from '../project/service.js';
import { appendEvent } from '../events/append.js';
import { logger } from '../../config/logger.js';
import { githubRepApi, type GithubRepoInfo } from '../github/rep-api.js';
import { representativeGithubToken } from '../github/rep-token.js';
import { listReposByOrg } from '../repo/repository.js';
import {
  assignUserToOrg,
  findOrganizationById,
  findUserById,
  insertOrganization,
  listUsersByOrg,
  removeUserFromOrg,
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

// 연결 드롭다운: 그 조직 대표가 GitHub에서 접근할 수 있는 레포. 대표가 GitHub를 연결하지 않았으면 빈 배열(500이 아니다 — 직접 입력 경로가 열려 있다).
// 서버 공용 PAT를 쓰지 않는다 — 쓰면 모든 조직이 그 PAT 주인의 레포를 본다.
export async function listAvailableGithubRepos(orgId: string): Promise<GithubRepoInfo[]> {
  const token = await representativeGithubToken(pool, orgId);
  if (token === null) {
    logger.warn('representative has no GitHub link; returning empty repo list', { orgId });
    return [];
  }
  return githubRepApi().listRepos(token);
}

// 사용자를 가리키는 키는 다른 응답(createOrg·acceptInvite·프로젝트 멤버)과 같은 userId로 쓴다.
export type MemberView = {
  userId: string;
  loginId: string | null;
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
    userId: u.id,
    loginId: u.loginId,
    nickname: u.nickname,
    githubLogin: u.githubLogin,
    name: u.name,
    orgRole: u.orgRole,
  });

  const token = await representativeGithubToken(pool, orgId);
  if (token === null) return users.map(base);

  const repos = await listReposByOrg(pool, orgId);
  if (repos.length === 0) return users.map(base);

  const results: MemberView[] = [];
  for (const u of users) {
    let isCollaborator: boolean | undefined;
    if (u.githubLogin !== null) {
      for (const repo of repos) {
        try {
          const result = await githubRepApi().isCollaborator(token, repo.fullName, u.githubLogin);
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

// GET /api/me — 로그인 직후 프론트가 "어느 조직의 누구인가"를 아는 유일한 경로.
// 로그인 응답에 넣지 않는 이유: 토큰은 신원만 증명하고 조직·역할은 매 요청 DB가 정본이다.
// 로그인 시점 값을 들고 다니면 조직을 만들거나 초대를 수락한 직후에 옛 값이 남는다.
export type MeView = {
  userId: string;
  loginId: string | null;
  nickname: string | null;
  githubLogin: string | null;
  orgId: string | null;
  orgName: string | null;
  // 조직이 없으면 null. users.org_role은 NOT NULL(기본 MEMBER)이라 그대로 내면 "조직 없는 MEMBER"로 읽힌다.
  orgRole: 'REPRESENTATIVE' | 'MEMBER' | null;
};

export async function getMe(userId: string): Promise<MeView> {
  const user = await findUserById(pool, userId);
  if (!user) throw new AppError('UNAUTHENTICATED', 'user not found');
  const org = user.orgId === null ? null : await findOrganizationById(pool, user.orgId);
  return {
    userId: user.id,
    loginId: user.loginId,
    nickname: user.nickname,
    githubLogin: user.githubLogin,
    orgId: user.orgId,
    orgName: org?.name ?? null,
    orgRole: user.orgId === null ? null : user.orgRole,
  };
}

// 조직에서 멤버를 뺀다(021). 대표가 다른 멤버를 내보내거나, 멤버 본인이 나간다. 대표는 나갈 수 없다(조직에 대표가 없어진다).
// - 계정은 남고 조직만 비운다(대표 결정) — 다른 조직의 초대를 받을 수 있다. 지난 기록(이벤트·노트·제출)은 그대로 남는다.
// - 그 사람의 에이전트는 맡은 진행 중 프로젝트에서 빠지고 연결이 해제된다. 진행 중 태스크를 붙잡고 있으면 409 ACTIVE_TASKS_HELD.
export async function removeOrgMember(
  actor: { userId: string; orgId: string; orgRole: string },
  orgId: string,
  userId: string,
): Promise<{ userId: string; agentIds: string[]; unassignedFrom: string[]; githubRevocations: GithubRevokeResult[] }> {
  const self = actor.userId === userId;
  if (!self && actor.orgRole !== 'REPRESENTATIVE') {
    throw new AppError('NOT_REPRESENTATIVE', 'only the representative can remove other members');
  }
  const target = await findUserById(pool, userId);
  if (!target || target.orgId !== orgId) throw new AppError('ORG_MEMBER_NOT_FOUND', `user ${userId} is not a member of this organization`);
  if (target.orgRole === 'REPRESENTATIVE') {
    throw new AppError('REPRESENTATIVE_CANNOT_LEAVE', 'the representative cannot leave or be removed from the organization');
  }

  const result = await withTransaction(async (tx) => {
    const agents = await listConnectedAgentsOfUser(tx, userId);
    const unassignedFrom: string[] = [];
    for (const agent of agents) {
      const projectId = await detachAgentFromActiveProject(tx, agent.id, actor.userId, 'org_member_removed');
      if (projectId) unassignedFrom.push(projectId);
      await markAgentDisconnected(tx, agent.id);
      await revokeAgentTokens(tx, agent.id);
    }
    await detachUserAgentsFromOrg(tx, userId);
    if (!(await removeUserFromOrg(tx, userId, orgId))) {
      throw new AppError('ORG_MEMBER_NOT_FOUND', `user ${userId} is not a member of this organization`);
    }
    const agentIds = agents.map((a) => a.id as string);
    await appendEvent(tx, {
      orgId,
      type: 'ORG_MEMBER_REMOVED',
      onBehalfOf: actor.userId,
      payload: { userId, self, agentIds, unassignedFrom },
    });
    return { userId, agentIds, unassignedFrom };
  });
  for (const projectId of result.unassignedFrom) tasksChanged(projectId);
  for (const agentId of result.agentIds) agentRevoked(agentId);
  // 조직의 GitHub 레포 전부에서 접근을 회수한다(커밋 뒤 — 실패해도 탈퇴는 그대로).
  const githubRevocations = await revokeGithubAccess({
    orgId,
    onBehalfOf: actor.userId,
    projectId: null,
    agentId: null,
    userId,
    scope: { kind: 'org' },
    trigger: 'org_member_removed',
  });
  return { ...result, githubRevocations };
}
