import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { login, signup } from '../src/domain/auth/service.js';
import { deviceLogin, DeviceLoginError } from '../src/executor/device-login.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// executor login의 브라우저 승인 경로. 서버 응답 순서별 동작은 가짜 fetch로, 실제 왕복은 실제 서버로 확인한다.

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

const STARTED = {
  deviceCode: 'dc',
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://web.example/connect/device',
  verificationUriComplete: 'https://web.example/connect/device?code=WDJB-MJHT',
  expiresIn: 600,
  interval: 5,
};

// start 응답 뒤에 poll 응답을 차례로 낸다.
function fakeServer(polls: Record<string, unknown>[]) {
  const requests: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    requests.push(u);
    const data = u.endsWith('/start') ? STARTED : polls.shift();
    return new Response(JSON.stringify({ data }), { status: u.endsWith('/start') ? 201 : 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe('deviceLogin — 응답별 동작', () => {
  it('코드와 주소를 출력하고 브라우저를 연 뒤, slow_down이면 간격을 늘려 승인될 때까지 기다린다', async () => {
    const { fetchImpl } = fakeServer([
      { status: 'pending' },
      { status: 'slow_down', interval: 10 },
      { status: 'approved', accessToken: 'at', refreshToken: 'rt', agentId: 'ag', account: { loginId: 'rep', nickname: '대표', orgName: 'Acme' } },
    ]);
    const lines: string[] = [];
    const opened: string[] = [];
    const slept: number[] = [];
    const result = await deviceLogin({
      baseUrl: 'https://api.example',
      agentName: 'mbp',
      fetchImpl,
      openUrl: async (url) => (opened.push(url), true),
      sleep: async (ms) => void slept.push(ms),
      out: (l) => lines.push(l),
    });

    expect(opened).toEqual([STARTED.verificationUriComplete]);
    expect(lines.join('\n')).toContain('WDJB-MJHT');
    expect(slept).toEqual([5000, 5000, 10000]);
    expect(result).toEqual({
      credentials: { baseUrl: 'https://api.example', accessToken: 'at', refreshToken: 'rt', agentId: 'ag' },
      account: { loginId: 'rep', nickname: '대표', orgName: 'Acme' },
    });
  });

  it('브라우저를 열지 못해도 주소를 안내하고 계속 기다린다', async () => {
    const { fetchImpl } = fakeServer([
      { status: 'approved', accessToken: 'at', refreshToken: 'rt', agentId: 'ag', account: { loginId: 'x', nickname: null, orgName: null } },
    ]);
    const lines: string[] = [];
    await deviceLogin({ baseUrl: 'https://api.example', agentName: 'mbp', fetchImpl, openUrl: async () => false, sleep: async () => {}, out: (l) => lines.push(l) });
    expect(lines.join('\n')).toContain('직접 여세요');
  });

  it.each([
    [{ status: 'denied' }, /거부/],
    [{ status: 'expired' }, /만료/],
  ])('%o이면 안내와 함께 실패한다', async (reply, message) => {
    const { fetchImpl } = fakeServer([reply]);
    await expect(
      deviceLogin({ baseUrl: 'https://api.example', agentName: 'mbp', fetchImpl, openUrl: async () => true, sleep: async () => {}, out: () => {} }),
    ).rejects.toThrow(message);
  });

  it('서버 오류는 코드와 함께 실패한다', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'bad' } }), { status: 400 })) as unknown as typeof fetch;
    await expect(
      deviceLogin({ baseUrl: 'https://api.example', agentName: 'mbp', fetchImpl, openUrl: async () => true, sleep: async () => {}, out: () => {} }),
    ).rejects.toBeInstanceOf(DeviceLoginError);
  });
});

describe('deviceLogin — 실제 서버와 왕복', () => {
  it('웹에서 승인하면 토큰을 받고, 그 refresh token이 동작한다', async () => {
    await signup({ loginId: 'rep', password: 'correct-horse-battery', nickname: '대표' });
    const { accessToken: human } = await login({ loginId: 'rep', password: 'correct-horse-battery' });

    let userCode = '';
    let approved = false;
    const result = await deviceLogin({
      baseUrl,
      agentName: 'mbp',
      openUrl: async () => true,
      out: (line) => {
        const m = /코드: (\S+)/.exec(line);
        if (m) userCode = m[1]!;
      },
      // 기다리는 대신: 첫 대기에서 사람이 웹으로 승인하고, poll 간격 검사는 지난 시각으로 돌려 둔다.
      sleep: async () => {
        if (!approved) {
          approved = true;
          const res = await fetch(`${baseUrl}/api/agents/device/requests/${userCode}/approve`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${human}` },
          });
          expect(res.status).toBe(200);
        }
        await pool.query(`UPDATE agent_device_requests SET last_polled_at = NULL`);
      },
    });

    expect(result.account).toMatchObject({ loginId: 'rep', nickname: '대표' });
    const refreshed = await fetch(`${baseUrl}/api/agents/token/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: result.credentials.refreshToken }),
    });
    expect(refreshed.status).toBe(200);
  });
});
