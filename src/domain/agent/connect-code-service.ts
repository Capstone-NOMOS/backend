import { withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors.js';
import { hashSecret } from '../../utils/tokens.js';
import { appendEvent } from '../events/append.js';
import { findOrganizationById, findUserById } from '../org/repository.js';
import { insertConnectCode, lockUsableConnectCode, markConnectCodeUsed } from './connect-code-repository.js';
import { displayUserCode, newUserCode, normalizeUserCode } from './device-service.js';
import { issueAgentCredentials, type AgentSpec, type ConnectAgentResult } from './service.js';

// 1회용 연결 코드(024) — 웹에서 받은 연결 명령(`connect --code`)이 "이 계정으로" 연결되게 한다.
//
// 노트북에 예전 계정의 자격 증명이 남아 있으면 connect가 그걸 재사용해 새 계정으로 가입해도 예전 계정의 에이전트로 붙었다(통합 테스트).
// 코드를 낸 CLI는 저장된 자격 증명을 보지 않고 코드의 주인으로 연결한다. 토큰 발급은 연결 키·브라우저 승인과 같은 issueAgentCredentials 한 벌.
//
// 위험: 남이 준 명령을 실행하면 내 노트북이 그 사람의 에이전트가 된다(브라우저 승인 피싱의 반대 방향). 그래서 코드는 10분·1회용이고,
// CLI는 연결된 계정을 반드시 출력한다(응답의 account). 코드 값은 해시로만 저장하고 이벤트에도 싣지 않는다.

export const CONNECT_CODE_TTL_MS = 10 * 60 * 1000;
export const CLI_PACKAGE = '@capstone-nomos/cli@latest';

export type ConnectCodeIssued = { code: string; expiresAt: string; command: string };

export async function issueConnectCode(userId: string): Promise<ConnectCodeIssued> {
  const code = newUserCode();
  const expiresAt = new Date(Date.now() + CONNECT_CODE_TTL_MS);
  await withTransaction(async (tx) => {
    const user = await findUserById(tx, userId);
    if (!user) throw new AppError('UNAUTHENTICATED', 'user not found');
    const { id } = await insertConnectCode(tx, { userId, codeHash: hashSecret(code), expiresAt });
    await appendEvent(tx, {
      orgId: user.orgId,
      type: 'AGENT_CONNECT_CODE_ISSUED',
      onBehalfOf: userId,
      payload: { codeId: id, expiresAt: expiresAt.toISOString() },
    });
  });
  const shown = displayUserCode(code);
  const server = env.API_BASE_URL ? ` --server ${env.API_BASE_URL.replace(/\/$/, '')}` : '';
  return { code: shown, expiresAt: expiresAt.toISOString(), command: `npx ${CLI_PACKAGE} connect --code ${shown}${server}` };
}

export type ConnectByCodeResult = ConnectAgentResult & {
  account: { loginId: string | null; nickname: string | null; orgName: string | null };
};

// CLI 쪽(인증 없음). 틀린·만료·쓰인 코드는 연결 키와 같은 400 + 일반 메시지(어느 경우인지 알려 주지 않는다).
export async function connectByCode(rawCode: string, spec: AgentSpec): Promise<ConnectByCodeResult> {
  const code = normalizeUserCode(rawCode);
  if (!code) throw new AppError('INVALID_CONNECT_REQUEST', 'invalid connect request');
  return withTransaction(async (tx) => {
    const row = await lockUsableConnectCode(tx, hashSecret(code));
    if (!row) throw new AppError('INVALID_CONNECT_REQUEST', 'invalid connect request');
    const user = await findUserById(tx, row.userId);
    if (!user) throw new AppError('INVALID_CONNECT_REQUEST', 'invalid connect request');
    const credentials = await issueAgentCredentials(tx, { id: user.id, orgId: user.orgId }, spec, 'connect_code');
    await markConnectCodeUsed(tx, row.id, credentials.agentId);
    const org = user.orgId ? await findOrganizationById(tx, user.orgId) : null;
    return { ...credentials, account: { loginId: user.loginId, nickname: user.nickname, orgName: org?.name ?? null } };
  });
}
