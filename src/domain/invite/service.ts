import { randomBytes, randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors.js';
import { assignAgentsToOrg } from '../agent/repository.js';
import { appendEvent } from '../events/append.js';
import { assignUserToOrg, findOrganizationById, findUserById } from '../org/repository.js';
import type { TeamRole } from '../roles.js';
import { findInviteByToken, insertInvite, markInviteUsed } from './repository.js';

const DEFAULT_EXPIRES_IN_DAYS = 7;

export type CreateInviteResult = { token: string; url: string; expiresAt: string; teamRole: TeamRole | null };

export async function createInvite(
  orgId: string,
  actorUserId: string,
  options: { expiresInDays?: number; teamRole?: TeamRole } = {},
): Promise<CreateInviteResult> {
  const token = randomBytes(16).toString('base64url');
  const inviteId = randomUUID();
  const expiresInDays = options.expiresInDays ?? DEFAULT_EXPIRES_IN_DAYS;
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  const teamRole = options.teamRole ?? null;

  await withTransaction(async (tx) => {
    await insertInvite(tx, { id: inviteId, orgId, token, teamRole, createdBy: actorUserId, expiresAt });
    await appendEvent(tx, {
      orgId,
      type: 'INVITE_CREATED',
      onBehalfOf: actorUserId,
      payload: { inviteId, expiresAt: expiresAt.toISOString(), teamRole },
    });
  });

  return {
    token,
    // 사람이 여는 링크이므로 프론트 주소다. 프론트의 /invites/:token 화면이 GET /api/invites/:token으로
    // 미리보기를 그리고, 로그인 후 POST .../accept를 부른다.
    url: `${env.FRONTEND_BASE_URL}/invites/${token}`,
    expiresAt: expiresAt.toISOString(),
    teamRole,
  };
}

export type InvitePreview = {
  orgName: string;
  valid: boolean;
  teamRole: TeamRole | null;
  reason?: 'expired' | 'used' | 'not_found';
};

// 존재하지 않는 토큰도 404가 아니라 valid:false로 응답해 토큰 존재 여부를 숨긴다.
export async function previewInvite(token: string): Promise<InvitePreview> {
  const invite = await findInviteByToken(pool, token);
  if (!invite) {
    return { orgName: '', valid: false, teamRole: null, reason: 'not_found' };
  }

  const org = await findOrganizationById(pool, invite.orgId);
  const orgName = org?.name ?? '';
  const teamRole = invite.teamRole;

  if (invite.usedBy !== null) {
    return { orgName, valid: false, teamRole, reason: 'used' };
  }
  if (new Date(invite.expiresAt).getTime() < Date.now()) {
    return { orgName, valid: false, teamRole, reason: 'expired' };
  }
  return { orgName, valid: true, teamRole };
}

export type AcceptInviteResult = { userId: string; orgId: string };

// 로그인한 사용자를 초대한 조직에 넣고, 그 사용자가 이미 연결해 둔 에이전트도 함께 넣는다.
// 이미 그 조직 소속이면 초대를 소비하지 않고 성공을 돌려준다(재시도 멱등).
// 다른 조직 소속이면 409 — 단일 조직.
export async function acceptInvite(token: string, userId: string): Promise<AcceptInviteResult> {
  return withTransaction(async (tx) => {
    const invite = await findInviteByToken(tx, token);
    if (!invite) {
      throw new AppError('INVITE_NOT_FOUND', 'invite token not found');
    }

    const user = await findUserById(tx, userId);
    if (!user) {
      throw new AppError('UNAUTHENTICATED', 'user not found');
    }
    if (user.orgId === invite.orgId) {
      return { userId, orgId: invite.orgId };
    }

    if (invite.usedBy !== null) {
      throw new AppError('INVITE_ALREADY_USED', 'invite has already been used');
    }
    if (new Date(invite.expiresAt).getTime() < Date.now()) {
      throw new AppError('INVITE_EXPIRED', 'invite has expired');
    }
    if (user.orgId !== null) {
      throw new AppError('ALREADY_IN_ORG', 'user already belongs to another organization');
    }

    const joined = await assignUserToOrg(tx, userId, invite.orgId, 'MEMBER');
    if (!joined) {
      throw new AppError('ALREADY_IN_ORG', 'user already belongs to another organization');
    }
    const used = await markInviteUsed(tx, invite.id, userId);
    if (!used) {
      throw new AppError('INVITE_ALREADY_USED', 'invite has already been used');
    }

    const agentIds = await assignAgentsToOrg(tx, userId, invite.orgId);

    await appendEvent(tx, {
      orgId: invite.orgId,
      type: 'INVITE_ACCEPTED',
      onBehalfOf: userId,
      payload: { inviteId: invite.id, userId, agentIds },
    });
    await appendEvent(tx, {
      orgId: invite.orgId,
      type: 'MEMBER_JOINED',
      onBehalfOf: userId,
      payload: { userId, orgRole: 'MEMBER', teamRole: invite.teamRole },
    });

    return { userId, orgId: invite.orgId };
  });
}
