import type { PoolClient } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors.js';
import { assignAgentsToOrg } from '../agent/repository.js';
import { appendEvent } from '../events/append.js';
import { assignUserToOrg, findOrganizationById, findUserById } from '../org/repository.js';
import type { TeamRole } from '../roles.js';
import { findInviteByToken, insertInvite, listPendingInvites, markInviteUsed, revokePendingInvite } from './repository.js';

const DEFAULT_EXPIRES_IN_DAYS = 7;

export type CreateInviteResult = { inviteId: string; token: string; url: string; expiresAt: string; teamRole: TeamRole | null };

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
    inviteId,
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
  // 없는 토큰이면 null(존재 여부를 숨긴다). 만료·사용된 초대도 원래 만료 시각을 준다.
  expiresAt: string | null;
  reason?: 'expired' | 'used' | 'revoked' | 'not_found';
};

// 존재하지 않는 토큰도 404가 아니라 valid:false로 응답해 토큰 존재 여부를 숨긴다.
export async function previewInvite(token: string): Promise<InvitePreview> {
  const invite = await findInviteByToken(pool, token);
  if (!invite) {
    return { orgName: '', valid: false, teamRole: null, expiresAt: null, reason: 'not_found' };
  }

  const org = await findOrganizationById(pool, invite.orgId);
  const orgName = org?.name ?? '';
  const teamRole = invite.teamRole;
  const expiresAt = new Date(invite.expiresAt).toISOString();

  if (invite.usedBy !== null) {
    return { orgName, valid: false, teamRole, expiresAt, reason: 'used' };
  }
  if (invite.revokedAt !== null) {
    return { orgName, valid: false, teamRole, expiresAt, reason: 'revoked' };
  }
  if (new Date(invite.expiresAt).getTime() < Date.now()) {
    return { orgName, valid: false, teamRole, expiresAt, reason: 'expired' };
  }
  return { orgName, valid: true, teamRole, expiresAt };
}

export type AcceptInviteResult = { userId: string; orgId: string };

// 로그인한 사용자를 초대한 조직에 넣고, 그 사용자가 이미 연결해 둔 에이전트도 함께 넣는다.
// 이미 그 조직 소속이면 초대를 소비하지 않고 성공을 돌려준다(재시도 멱등).
// 다른 조직 소속이면 409 — 단일 조직.
export async function acceptInvite(token: string, userId: string): Promise<AcceptInviteResult> {
  return withTransaction(async (tx) => {
    const invite = await findInviteByToken(tx, token);
    // 해산한 조직(029)의 초대는 없는 것으로 본다 — 해산이 대기 초대를 전부 취소하지만, 쓰인·만료된 링크도 같은 답을 낸다.
    if (!invite || !(await findOrganizationById(tx, invite.orgId))) {
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
    if (invite.revokedAt !== null) {
      throw new AppError('INVITE_REVOKED', 'invite was cancelled by the representative');
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

export type PendingInviteView = { inviteId: string; url: string; teamRole: TeamRole | null; expiresAt: string; expired: boolean; createdAt: string };

// 보낸 초대 중 아직 쓰이지도 취소되지도 않은 것(대표, 021). 링크를 다시 복사하거나 취소할 때 쓴다.
export async function listInvites(orgId: string): Promise<PendingInviteView[]> {
  const invites = await listPendingInvites(pool, orgId);
  const now = Date.now();
  return invites.map((i) => ({
    inviteId: i.id,
    url: `${env.FRONTEND_BASE_URL}/invites/${i.token}`,
    teamRole: i.teamRole,
    expiresAt: new Date(i.expiresAt).toISOString(),
    expired: new Date(i.expiresAt).getTime() < now,
    createdAt: new Date(i.createdAt).toISOString(),
  }));
}

// 초대 취소(대표, 021). 쓰인 초대·이미 취소한 초대·다른 조직 초대는 404 — 가입을 되돌리는 건 멤버 내보내기다.
export async function revokeInvite(orgId: string, actorUserId: string, inviteId: string): Promise<{ inviteId: string }> {
  return withTransaction(async (tx) => {
    if (!(await revokeInviteInTx(tx, orgId, actorUserId, inviteId))) {
      throw new AppError('INVITE_NOT_FOUND', `no pending invite ${inviteId}`);
    }
    return { inviteId };
  });
}

// 초대 취소 한 벌 — 직접 취소와 조직 해산(029)이 같이 쓴다. 대기 중인 초대가 아니면 false.
export async function revokeInviteInTx(tx: PoolClient, orgId: string, actorUserId: string, inviteId: string): Promise<boolean> {
  if (!(await revokePendingInvite(tx, orgId, inviteId))) return false;
  await appendEvent(tx, { orgId, type: 'INVITE_REVOKED', onBehalfOf: actorUserId, payload: { inviteId } });
  return true;
}

// 조직 해산(029) — 대기 중인 초대를 전부 취소한다. 취소한 초대 id.
export async function revokeAllInvitesInTx(tx: PoolClient, orgId: string, actorUserId: string): Promise<string[]> {
  const revoked: string[] = [];
  for (const invite of await listPendingInvites(tx, orgId)) {
    if (await revokeInviteInTx(tx, orgId, actorUserId, invite.id)) revoked.push(invite.id);
  }
  return revoked;
}
