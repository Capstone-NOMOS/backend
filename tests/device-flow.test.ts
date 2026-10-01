import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { login, signup } from '../src/domain/auth/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// CLI 연결을 브라우저 승인으로(RFC 8628). 시간(만료·poll 간격)은 서비스가 바꾸는 값이 아니라 흐른 시간이라,
// 기다리는 대신 행의 시각을 직접 당긴다 — 상태 전이는 전부 서비스를 거친다.

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await resetSchema();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await pool.end();
  await testPool.end();
});

type Body = { data?: Record<string, never>; error?: { code: string; message: string } };

async function call(
  method: string,
  url: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${baseUrl}/api${url}`, {
    method,
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

async function account(loginId: string) {
  const { userId } = await signup({ loginId, password: 'correct-horse-battery', nickname: loginId });
  const { accessToken } = await login({ loginId, password: 'correct-horse-battery' });
  return { userId, token: accessToken };
}

type Started = { deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string; expiresIn: number; interval: number };

async function start(headers: Record<string, string> = {}): Promise<Started> {
  const res = await call('POST', '/agents/device/start', {
    body: { agentName: 'benzity-mbp', harness: 'claude-code', skills: [], maxConcurrent: 2 },
    headers,
  });
  expect(res.status).toBe(201);
  return res.body.data as unknown as Started;
}

async function poll(deviceCode: string) {
  // 간격 검사(slow_down)에 걸리지 않게 마지막 poll 시각을 비운다 — 간격 검사 자체는 아래 테스트가 따로 본다.
  await pool.query(`UPDATE agent_device_requests SET last_polled_at = NULL`);
  const res = await call('POST', '/agents/device/poll', { body: { deviceCode } });
  return { status: res.status, data: res.body.data as unknown as Record<string, unknown>, error: res.body.error };
}

describe('브라우저 승인으로 CLI 연결', () => {
  it('start는 코드·주소를 주고, 승인하면 poll 한 번이 토큰과 연결된 계정을 받는다 — 두 번째 poll은 expired', async () => {
    const me = await account('rep');
    const { orgId } = await createOrganization(me.userId, 'Acme Inc.');
    const s = await start();
    expect(s.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(s).toMatchObject({ expiresIn: 600, interval: 5 });
    expect(s.verificationUriComplete).toBe(`${s.verificationUri}?code=${s.userCode}`);

    expect((await poll(s.deviceCode)).data).toEqual({ status: 'pending' });

    const view = await call('GET', `/agents/device/requests/${s.userCode}`, { token: me.token });
    expect(view.body.data).toMatchObject({ userCode: s.userCode, status: 'PENDING', agentName: 'benzity-mbp', harness: 'claude-code' });

    expect((await call('POST', `/agents/device/requests/${s.userCode}/approve`, { token: me.token })).body.data).toEqual({ status: 'APPROVED' });

    const approved = await poll(s.deviceCode);
    expect(approved.data).toMatchObject({ status: 'approved', account: { loginId: 'rep', orgName: 'Acme Inc.' } });
    // 받은 refresh token이 실제로 동작하고, 에이전트는 승인한 사람의 것이다.
    const refreshed = await call('POST', '/agents/token/refresh', { body: { refreshToken: approved.data.refreshToken } });
    expect(refreshed.status).toBe(200);
    const agent = await pool.query(`SELECT user_id, org_id, name FROM agents WHERE id = $1`, [approved.data.agentId]);
    expect(agent.rows[0]).toEqual({ user_id: me.userId, org_id: orgId, name: 'benzity-mbp' });

    expect((await poll(s.deviceCode)).data).toEqual({ status: 'expired' });
    expect((await call('GET', `/agents/device/requests/${s.userCode}`, { token: me.token })).body.data).toMatchObject({ status: 'CONSUMED' });
  });

  it('이벤트: 요청은 system:device-flow, 결정·연결은 승인한 사람 명의(연결 방식 device)', async () => {
    const me = await account('rep');
    const s = await start();
    await call('POST', `/agents/device/requests/${s.userCode}/approve`, { token: me.token });
    await poll(s.deviceCode);

    const rows = await pool.query(
      `SELECT type, on_behalf_of, payload FROM events WHERE type IN ('AGENT_DEVICE_REQUESTED', 'AGENT_DEVICE_DECIDED', 'AGENT_CONNECTED') ORDER BY id`,
    );
    expect(rows.rows.map((r) => [r.type, r.on_behalf_of])).toEqual([
      ['AGENT_DEVICE_REQUESTED', 'system:device-flow'],
      ['AGENT_DEVICE_DECIDED', me.userId],
      ['AGENT_CONNECTED', me.userId],
    ]);
    expect(rows.rows[2]!.payload.method).toBe('device');
    // deviceCode는 해시로만 저장하고 이벤트에도 남기지 않는다.
    expect(JSON.stringify(rows.rows)).not.toContain(s.deviceCode);
    const stored = await pool.query(`SELECT device_code_hash FROM agent_device_requests`);
    expect(stored.rows[0]!.device_code_hash).not.toBe(s.deviceCode);
  });

  it('거부하면 denied이고, 이미 결정된 요청은 다시 결정할 수 없다(409)', async () => {
    const me = await account('rep');
    const s = await start();
    expect((await call('POST', `/agents/device/requests/${s.userCode}/deny`, { token: me.token })).body.data).toEqual({ status: 'DENIED' });
    expect((await poll(s.deviceCode)).data).toEqual({ status: 'denied' });
    const again = await call('POST', `/agents/device/requests/${s.userCode}/approve`, { token: me.token });
    expect(again.status).toBe(409);
    expect(again.body.error!.code).toBe('DEVICE_REQUEST_ALREADY_DECIDED');
  });

  it('만료되면 승인은 410, poll은 expired, 조회는 EXPIRED', async () => {
    const me = await account('rep');
    const s = await start();
    await pool.query(`UPDATE agent_device_requests SET expires_at = now() - interval '1 second'`);

    const approve = await call('POST', `/agents/device/requests/${s.userCode}/approve`, { token: me.token });
    expect(approve.status).toBe(410);
    expect(approve.body.error!.code).toBe('DEVICE_REQUEST_EXPIRED');
    expect((await poll(s.deviceCode)).data).toEqual({ status: 'expired' });
    expect((await call('GET', `/agents/device/requests/${s.userCode}`, { token: me.token })).body.data).toMatchObject({ status: 'EXPIRED' });
  });

  it('interval보다 빨리 부르면 slow_down이고 간격이 늘어 저장된다', async () => {
    const s = await start();
    expect((await call('POST', '/agents/device/poll', { body: { deviceCode: s.deviceCode } })).body.data).toEqual({ status: 'pending' });
    expect((await call('POST', '/agents/device/poll', { body: { deviceCode: s.deviceCode } })).body.data).toEqual({ status: 'slow_down', interval: 10 });
    expect((await pool.query(`SELECT poll_interval FROM agent_device_requests`)).rows[0]!.poll_interval).toBe(10);
  });

  it('userCode는 대소문자·하이픈을 무시한다', async () => {
    const me = await account('rep');
    const s = await start();
    const loose = s.userCode.replace('-', '').toLowerCase();
    expect((await call('GET', `/agents/device/requests/${loose}`, { token: me.token })).status).toBe(200);
    expect((await call('POST', `/agents/device/requests/${loose}/approve`, { token: me.token })).body.data).toEqual({ status: 'APPROVED' });
    // 형식이 아닌 코드·없는 코드는 404
    expect((await call('GET', '/agents/device/requests/AAAA-AAAA', { token: me.token })).status).toBe(404);
    expect((await call('GET', '/agents/device/requests/BCDF-GHJK', { token: me.token })).status).toBe(404);
  });

  it('조직 없이 승인해도 되고, 나중에 조직에 들어가면 에이전트가 따라온다', async () => {
    const me = await account('solo');
    const s = await start();
    await call('POST', `/agents/device/requests/${s.userCode}/approve`, { token: me.token });
    const approved = await poll(s.deviceCode);
    expect(approved.data).toMatchObject({ status: 'approved', account: { loginId: 'solo', orgName: null } });

    const { orgId } = await createOrganization(me.userId, 'Later Inc.');
    const agent = await pool.query(`SELECT org_id FROM agents WHERE id = $1`, [approved.data.agentId]);
    expect(agent.rows[0]!.org_id).toBe(orgId);
  });

  it('모르는 deviceCode는 400, 승인·조회는 사람 토큰이 필요하다', async () => {
    const res = await call('POST', '/agents/device/poll', { body: { deviceCode: 'nope' } });
    expect(res.status).toBe(400);
    expect(res.body.error!.code).toBe('INVALID_DEVICE_CODE');

    const s = await start();
    expect((await call('POST', `/agents/device/requests/${s.userCode}/approve`)).status).toBe(401);
    expect((await call('GET', `/agents/device/requests/${s.userCode}`)).status).toBe(401);
  });

  // 운영은 Caddy 뒤다. trust proxy 1이면 X-Forwarded-For의 맨 오른쪽(프록시가 붙인 값)을 요청 IP로 쓴다.
  it('요청 IP를 승인 화면에 보여 준다 — 프록시가 붙인 X-Forwarded-For를 쓴다', async () => {
    const me = await account('rep');
    const s = await start({ 'X-Forwarded-For': '198.51.100.9, 203.0.113.7' });
    const view = await call('GET', `/agents/device/requests/${s.userCode}`, { token: me.token });
    expect(view.body.data).toMatchObject({ clientIp: '203.0.113.7' });
  });
});
