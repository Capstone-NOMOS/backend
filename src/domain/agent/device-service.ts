import { randomInt, randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors.js';
import { generateSecret, hashSecret } from '../../utils/tokens.js';
import { appendEvent } from '../events/append.js';
import { violatedConstraint } from '../pg-errors.js';
import { findOrganizationById, findUserById } from '../org/repository.js';
import {
  consumeDeviceRequest,
  decideDeviceRequest,
  findDeviceRequestByCodeHash,
  findDeviceRequestByUserCode,
  insertDeviceRequest,
  recordDevicePoll,
  type DeviceRequest,
} from './device-repository.js';
import { issueAgentCredentials, type AgentSpec, type ConnectAgentResult } from './service.js';

// CLI 연결을 브라우저 승인으로 — OAuth Device Authorization Grant(RFC 8628). NOMOS가 인증 서버다.
//   CLI: start → (코드 출력·브라우저 열기) → interval마다 poll
//   웹:  로그인된 사람이 코드·기기 정보를 확인하고 승인·거부
// 승인되면 poll 한 번이 연결 키 경로와 같은 발급(issueAgentCredentials)을 타고 토큰을 받는다. 토큰은 딱 한 번 나간다.
//
// 대표적인 공격은 피싱이다: 공격자가 자기 CLI로 받은 링크를 피해자에게 보내 승인시키면 공격자의 노트북이 피해자 이름으로 일한다.
// 그래서 승인 화면에 에이전트 이름·요청 IP·시각을 보여 주고, 만료를 10분으로 둔다. 반대 방향(남이 내 코드를 승인)은
// CLI가 연결된 계정을 출력해 드러낸다(poll 응답의 account).

export const DEVICE_FLOW = { expiresInSec: 600, intervalSec: 5, slowDownStepSec: 5 } as const;

// RFC 8628 §6.1 권장 — 자음 20자, 8자리(약 2.5×10¹⁰). 헷갈리는 문자(0/O, 1/I)와 단어가 생기지 않는다.
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;

function newUserCode(): string {
  let code = '';
  for (let i = 0; i < 8; i += 1) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return code;
}

// 사람이 입력한 코드: 대소문자·하이픈·공백을 무시한다(wdjbmjht = WDJB-MJHT).
export function normalizeUserCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  return USER_CODE_PATTERN.test(code) ? code : null;
}

function displayUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function isExpired(req: DeviceRequest): boolean {
  return req.expiresAt.getTime() <= Date.now();
}

// ── CLI 쪽 (인증 없음 — CLI는 아직 자격 증명이 없다) ─────────────────────

export type DeviceStartResult = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export async function startDeviceFlow(spec: AgentSpec, clientIp: string | null): Promise<DeviceStartResult> {
  const deviceCode = generateSecret();
  // 살아 있는 요청끼리 userCode가 겹치면 다시 뽑는다(조합이 커서 사실상 일어나지 않는다).
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const userCode = newUserCode();
    try {
      const request = await withTransaction(async (tx) => {
        const created = await insertDeviceRequest(tx, {
          id: randomUUID(),
          deviceCodeHash: hashSecret(deviceCode),
          userCode,
          agentName: spec.agentName,
          harness: spec.harness,
          skills: spec.skills,
          maxConcurrent: spec.maxConcurrent,
          clientIp,
          pollInterval: DEVICE_FLOW.intervalSec,
          expiresAt: new Date(Date.now() + DEVICE_FLOW.expiresInSec * 1000),
        });
        await appendEvent(tx, {
          orgId: null,
          type: 'AGENT_DEVICE_REQUESTED',
          // 아직 승인할 사람이 없다. 모호한 값 대신 주체를 명시한다(P3).
          onBehalfOf: 'system:device-flow',
          payload: { requestId: created.id, agentName: created.agentName, harness: created.harness, clientIp },
        });
        return created;
      });
      const shown = displayUserCode(request.userCode);
      const verificationUri = `${env.FRONTEND_BASE_URL}/connect/device`;
      return {
        deviceCode,
        userCode: shown,
        verificationUri,
        verificationUriComplete: `${verificationUri}?code=${shown}`,
        expiresIn: DEVICE_FLOW.expiresInSec,
        interval: DEVICE_FLOW.intervalSec,
      };
    } catch (err) {
      if (violatedConstraint(err) === 'agent_device_requests_live_user_code') continue;
      throw err;
    }
  }
  throw new Error('could not allocate a unique device user code');
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | ({ status: 'approved'; account: { loginId: string | null; nickname: string | null; orgName: string | null } } & ConnectAgentResult);

export async function pollDeviceFlow(deviceCode: string): Promise<DevicePollResult> {
  return withTransaction(async (tx) => {
    const req = await findDeviceRequestByCodeHash(tx, hashSecret(deviceCode));
    if (!req) throw new AppError('INVALID_DEVICE_CODE', 'invalid device code');

    // 이미 토큰을 받았거나 만료된 요청은 더 쓸 수 없다. 같은 deviceCode로 토큰이 두 번 나가지 않는다.
    if (req.status === 'CONSUMED' || (req.status !== 'DENIED' && isExpired(req))) return { status: 'expired' };
    if (req.status === 'DENIED') return { status: 'denied' };

    // interval보다 빨리 부르면 간격을 늘리고 그 값을 저장한다(RFC 8628 §3.5).
    const tooFast =
      req.lastPolledAt !== null && Date.now() - req.lastPolledAt.getTime() < req.pollInterval * 1000;
    if (tooFast) {
      const interval = req.pollInterval + DEVICE_FLOW.slowDownStepSec;
      await recordDevicePoll(tx, req.id, interval);
      return { status: 'slow_down', interval };
    }
    await recordDevicePoll(tx, req.id, req.pollInterval);
    if (req.status === 'PENDING') return { status: 'pending' };

    // APPROVED → 이 poll 한 번만 토큰을 받는다(CONSUMED로 넘기는 조건부 UPDATE + 행 잠금).
    if (!(await consumeDeviceRequest(tx, req.id))) return { status: 'expired' };
    const user = await findUserById(tx, req.decidedBy!);
    if (!user) throw new AppError('INVALID_DEVICE_CODE', 'invalid device code');
    const credentials = await issueAgentCredentials(
      tx,
      { id: user.id, orgId: user.orgId },
      { agentName: req.agentName, harness: req.harness, skills: req.skills, maxConcurrent: req.maxConcurrent },
      'device',
    );
    const org = user.orgId ? await findOrganizationById(tx, user.orgId) : null;
    return {
      status: 'approved',
      ...credentials,
      // CLI가 "어느 계정에 연결됐는지" 출력한다 — 남이 내 코드를 승인한 경우를 사용자가 알아챈다.
      account: { loginId: user.loginId, nickname: user.nickname, orgName: org?.name ?? null },
    };
  });
}

// ── 웹 쪽 (사람 토큰) ─────────────────────────────────────────────────────

export type DeviceRequestView = {
  userCode: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'CONSUMED' | 'EXPIRED';
  agentName: string;
  harness: string;
  clientIp: string | null;
  requestedAt: string;
  expiresAt: string;
};

function toView(req: DeviceRequest): DeviceRequestView {
  // EXPIRED는 저장하지 않는다 — 아직 결정·사용되지 않았는데 시간이 지났으면 만료로 보인다.
  const expired = (req.status === 'PENDING' || req.status === 'APPROVED') && isExpired(req);
  return {
    userCode: displayUserCode(req.userCode),
    status: expired ? 'EXPIRED' : req.status,
    agentName: req.agentName,
    harness: req.harness,
    clientIp: req.clientIp,
    requestedAt: req.createdAt.toISOString(),
    expiresAt: req.expiresAt.toISOString(),
  };
}

export async function getDeviceRequest(rawUserCode: string): Promise<DeviceRequestView> {
  const code = normalizeUserCode(rawUserCode);
  const req = code ? await findDeviceRequestByUserCode(pool, code) : null;
  if (!req) throw new AppError('DEVICE_REQUEST_NOT_FOUND', 'device request not found');
  return toView(req);
}

// 승인·거부. 조직이 없어도 승인할 수 있다 — 에이전트는 사용자의 현재 조직(없으면 null)으로 만들어지고,
// 조직에 들어가면 assignAgentsToOrg가 옮긴다(연결 키 경로와 같다).
export async function decideDeviceRequestByUser(
  userId: string,
  rawUserCode: string,
  decision: 'APPROVED' | 'DENIED',
): Promise<{ status: 'APPROVED' | 'DENIED' }> {
  return withTransaction(async (tx) => {
    const code = normalizeUserCode(rawUserCode);
    const req = code ? await findDeviceRequestByUserCode(tx, code, { forUpdate: true }) : null;
    if (!req) throw new AppError('DEVICE_REQUEST_NOT_FOUND', 'device request not found');
    if (req.status !== 'PENDING') {
      throw new AppError('DEVICE_REQUEST_ALREADY_DECIDED', `device request is already ${req.status.toLowerCase()}`);
    }
    if (isExpired(req)) throw new AppError('DEVICE_REQUEST_EXPIRED', 'device request has expired; run login again');

    const user = await findUserById(tx, userId);
    if (!user) throw new AppError('UNAUTHENTICATED', 'user not found');
    await decideDeviceRequest(tx, req.id, decision, userId);
    await appendEvent(tx, {
      orgId: user.orgId,
      type: 'AGENT_DEVICE_DECIDED',
      onBehalfOf: userId,
      payload: { requestId: req.id, decision, agentName: req.agentName, clientIp: req.clientIp },
    });
    return { status: decision };
  });
}
