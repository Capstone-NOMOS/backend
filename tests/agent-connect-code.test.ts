import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { login, signup } from '../src/domain/auth/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// 1회용 연결 코드(024): 웹의 연결 명령이 노트북에 남은 다른 계정과 상관없이 그 계정으로 연결되게 한다.

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

async function http(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { data?: Record<string, unknown>; error?: { code: string } };
  return { status: res.status, data: json.data ?? {}, error: json.error };
}

async function account(loginId: string) {
  const { userId } = await signup({ loginId, password: 'correct-horse-battery', nickname: `${loginId}-닉` });
  const { accessToken } = await login({ loginId, password: 'correct-horse-battery' });
  return { userId, token: accessToken };
}

const SPEC = { agentName: 'shared-laptop', harness: 'claude-code' };

describe('1회용 연결 코드', () => {
  it('코드의 주인 계정으로 연결되고, 명령에 코드가 들어 있으며, 코드 값은 저장·이벤트에 남지 않는다', async () => {
    const minsu = await account('minsu');
    await createOrganization(minsu.userId, 'Acme');
    const issued = await http('POST', '/me/agent-connect-codes', minsu.token);
    expect(issued.status).toBe(201);
    const code = issued.data.code as string;
    expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(issued.data.command).toContain(`connect --code ${code}`);

    // 소문자·하이픈 없이 입력해도 된다.
    const connected = await http('POST', '/agents/connect/code', null, { code: code.replace('-', '').toLowerCase(), ...SPEC });
    expect(connected.status).toBe(201);
    expect(connected.data.account).toEqual({ loginId: 'minsu', nickname: 'minsu-닉', orgName: 'Acme' });

    const owner = await testPool.query(`SELECT user_id FROM agents WHERE id = $1`, [connected.data.agentId]);
    expect(owner.rows[0].user_id).toBe(minsu.userId);
    const me = await http('GET', '/agents/me/account', connected.data.accessToken as string);
    expect(me.data).toEqual({ agentId: connected.data.agentId, agentName: 'shared-laptop', loginId: 'minsu', nickname: 'minsu-닉', orgName: 'Acme' });

    const raw = code.replace('-', '');
    const dump = JSON.stringify((await testPool.query(`SELECT * FROM agent_connect_codes`)).rows) + JSON.stringify((await testPool.query(`SELECT payload FROM events`)).rows);
    expect(dump).not.toContain(raw);
    const methods = await testPool.query(`SELECT payload->>'method' AS m FROM events WHERE type = 'AGENT_CONNECTED'`);
    expect(methods.rows.map((r) => r.m)).toEqual(['connect_code']);
  });

  it('한 번만 쓸 수 있고, 만료·틀린 코드는 모두 같은 400이다', async () => {
    const minsu = await account('minsu');
    const code = (await http('POST', '/me/agent-connect-codes', minsu.token)).data.code as string;
    expect((await http('POST', '/agents/connect/code', null, { code, ...SPEC })).status).toBe(201);
    expect(await http('POST', '/agents/connect/code', null, { code, ...SPEC })).toMatchObject({ status: 400, error: { code: 'INVALID_CONNECT_REQUEST' } });

    const late = (await http('POST', '/me/agent-connect-codes', minsu.token)).data.code as string;
    await testPool.query(`UPDATE agent_connect_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
    expect(await http('POST', '/agents/connect/code', null, { code: late, ...SPEC })).toMatchObject({ status: 400, error: { code: 'INVALID_CONNECT_REQUEST' } });
    expect(await http('POST', '/agents/connect/code', null, { code: 'BBBB-BBBB', ...SPEC })).toMatchObject({ status: 400, error: { code: 'INVALID_CONNECT_REQUEST' } });
    expect(await http('POST', '/agents/connect/code', null, { code: '1234', ...SPEC })).toMatchObject({ status: 400, error: { code: 'INVALID_CONNECT_REQUEST' } });
  });

  it('같은 노트북(같은 에이전트 이름)이라도 새 계정의 코드면 새 계정의 에이전트가 된다', async () => {
    const old = await account('old-user');
    const fresh = await account('new-user');
    const a = await http('POST', '/agents/connect/code', null, { code: (await http('POST', '/me/agent-connect-codes', old.token)).data.code, ...SPEC });
    const b = await http('POST', '/agents/connect/code', null, { code: (await http('POST', '/me/agent-connect-codes', fresh.token)).data.code, ...SPEC });
    expect(a.data.agentId).not.toBe(b.data.agentId);
    expect((b.data.account as { loginId: string }).loginId).toBe('new-user');
  });

  it('코드 발급은 로그인한 사람만', async () => {
    expect((await http('POST', '/me/agent-connect-codes', null)).status).toBe(401);
  });
});
