import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { login, rotateConnectKey, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { authenticate } from '../src/middleware/auth.js';
import { hashSecret, verifyJwt } from '../src/utils/tokens.js';
import { createTestOrg } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

const PASSWORD = 'correct-horse-battery';

beforeAll(async () => {
  await resetSchema();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await pool.end();
  await testPool.end();
});

function connectInput(connectKey: string, agentName = 'laptop') {
  return { connectKey, agentName, harness: 'claude-code@2.1.263', skills: ['typescript'], maxConcurrent: 2 };
}

// authenticate 미들웨어를 Express 없이 한 번 돌려 next에 넘어온 값을 돌려준다.
async function runAuthenticate(token: string): Promise<{ err: unknown; req: Request }> {
  const req = {
    header: (name: string) => (name === 'Authorization' ? `Bearer ${token}` : undefined),
  } as unknown as Request;
  let err: unknown;
  await authenticate(req, {} as Response, ((e?: unknown) => {
    err = e;
  }) as NextFunction);
  return { err, req };
}

describe('가입·로그인', () => {
  it('GitHub 계정 없이 가입하고 로그인할 수 있다', async () => {
    const { userId } = await signup({ loginId: 'alice', password: PASSWORD, nickname: '앨리스' });

    const { rows } = await pool.query('SELECT github_id, github_login, org_id FROM users WHERE id = $1', [userId]);
    expect(rows[0]).toEqual({ github_id: null, github_login: null, org_id: null });

    const { accessToken } = await login({ loginId: 'alice', password: PASSWORD });
    const claims = verifyJwt(accessToken, env.JWT_SECRET);
    expect(claims?.sub).toBe(userId);
    expect(claims?.kind).toBe('user');
  });

  it('비밀번호는 scrypt$ 형식으로만 저장된다', async () => {
    const { userId } = await signup({ loginId: 'alice', password: PASSWORD, nickname: 'a' });

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    expect(rows[0]!.password_hash).toMatch(/^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(rows[0]!.password_hash).not.toContain(PASSWORD);
  });

  it('연결 키는 가입 응답에만 평문으로 오고, DB와 이벤트에는 해시만 남는다', async () => {
    const { userId, connectKey } = await signup({ loginId: 'alice', password: PASSWORD, nickname: 'a' });

    const user = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    expect(user.rows[0]!.connect_key_hash).toBe(hashSecret(connectKey));
    expect(JSON.stringify(user.rows[0])).not.toContain(connectKey);

    const events = await pool.query('SELECT payload FROM events');
    expect(JSON.stringify(events.rows)).not.toContain(connectKey);
  });

  it('없는 아이디와 틀린 비밀번호는 같은 에러를 낸다', async () => {
    await signup({ loginId: 'alice', password: PASSWORD, nickname: 'a' });

    const expected = { code: 'INVALID_CREDENTIALS', status: 401 };
    await expect(login({ loginId: 'alice', password: 'wrong-password' })).rejects.toMatchObject(expected);
    await expect(login({ loginId: 'nobody', password: PASSWORD })).rejects.toMatchObject(expected);
  });

  it('이미 쓰인 아이디로는 가입할 수 없다', async () => {
    await signup({ loginId: 'alice', password: PASSWORD, nickname: 'a' });
    await expect(signup({ loginId: 'alice', password: PASSWORD, nickname: 'b' })).rejects.toMatchObject({
      code: 'LOGIN_ID_TAKEN',
      status: 409,
    });
  });

  it('가입 이벤트는 조직 없이 기록된다', async () => {
    const { userId } = await signup({ loginId: 'alice', password: PASSWORD, nickname: 'a' });

    const { rows } = await pool.query(`SELECT org_id, on_behalf_of FROM events WHERE type = 'USER_SIGNED_UP'`);
    expect(rows).toEqual([{ org_id: null, on_behalf_of: userId }]);
  });
});

describe('CLI 연결', () => {
  it('조직·프로젝트 없이 연결하면 pending 에이전트가 생긴다', async () => {
    const { connectKey } = await signup({ loginId: 'alice', password: PASSWORD, nickname: 'a' });

    const { agentId, accessToken, refreshToken } = await connectAgent(connectInput(connectKey));

    const agent = await pool.query('SELECT status, org_id, skills FROM agents WHERE id = $1', [agentId]);
    expect(agent.rows[0]).toEqual({ status: 'pending', org_id: null, skills: ['typescript'] });

    expect(verifyJwt(accessToken, env.JWT_SECRET)?.kind).toBe('agent');

    const token = await pool.query('SELECT token_hash FROM agent_tokens WHERE agent_id = $1', [agentId]);
    expect(token.rows[0]!.token_hash).toBe(hashSecret(refreshToken));
  });

  it('잘못된 연결 키는 400이고 무엇이 틀렸는지 드러내지 않는다', async () => {
    await expect(connectAgent(connectInput('not-a-real-key'))).rejects.toMatchObject({
      code: 'INVALID_CONNECT_REQUEST',
      status: 400,
      message: 'invalid connect request',
    });
  });

  it('같은 이름으로 다시 연결하면 에이전트를 새로 만들지 않는다', async () => {
    const { connectKey } = await signup({ loginId: 'alice', password: PASSWORD, nickname: 'a' });

    const first = await connectAgent(connectInput(connectKey));
    const second = await connectAgent({ ...connectInput(connectKey), harness: 'claude-code@2.2.0' });

    expect(second.agentId).toBe(first.agentId);
    const { rows } = await pool.query('SELECT harness FROM agents');
    expect(rows).toEqual([{ harness: 'claude-code@2.2.0' }]);
  });

  it('refresh token으로 새 access token을 받고, 잘못된 refresh token은 401이다', async () => {
    const { connectKey } = await signup({ loginId: 'alice', password: PASSWORD, nickname: 'a' });
    const { agentId, refreshToken } = await connectAgent(connectInput(connectKey));

    const { accessToken } = await refreshAgentToken(refreshToken);
    expect(verifyJwt(accessToken, env.JWT_SECRET)?.sub).toBe(agentId);

    await expect(refreshAgentToken('bogus')).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN', status: 401 });
  });

  it('연결 키를 교체하면 기존 키는 더 이상 쓸 수 없다', async () => {
    const { userId, connectKey: oldKey } = await signup({ loginId: 'alice', password: PASSWORD, nickname: 'a' });

    const { connectKey: newKey } = await rotateConnectKey(userId);

    await expect(connectAgent(connectInput(oldKey))).rejects.toMatchObject({ status: 400 });
    await expect(connectAgent(connectInput(newKey))).resolves.toMatchObject({ agentId: expect.any(String) });
  });
});

describe('authenticate 미들웨어', () => {
  it('사용자 access token이면 req.user를 붙인다', async () => {
    const { userId } = await signup({ loginId: 'alice', password: PASSWORD, nickname: 'a' });
    const { accessToken } = await login({ loginId: 'alice', password: PASSWORD });

    const { err, req } = await runAuthenticate(accessToken);
    expect(err).toBeUndefined();
    expect(req.user).toEqual({ id: userId, orgId: null, orgRole: 'MEMBER' });
  });

  it('에이전트 access token으로는 사람 전용 API를 부를 수 없다', async () => {
    const { connectKey } = await signup({ loginId: 'alice', password: PASSWORD, nickname: 'a' });
    const { accessToken } = await connectAgent(connectInput(connectKey));

    const { err } = await runAuthenticate(accessToken);
    expect(err).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });

  it('역할은 토큰이 아니라 DB에서 읽는다 — 조직을 만든 직후 옛 토큰으로도 대표로 판정된다', async () => {
    await signup({ loginId: 'alice', password: PASSWORD, nickname: 'a' });
    const { accessToken } = await login({ loginId: 'alice', password: PASSWORD }); // org_role: MEMBER 시점 토큰
    const { rows } = await pool.query(`SELECT id FROM users WHERE login_id = 'alice'`);
    const { createOrganization } = await import('../src/domain/org/service.js');
    await createOrganization(rows[0]!.id, 'Acme');

    const { req } = await runAuthenticate(accessToken);
    expect(req.user?.orgRole).toBe('REPRESENTATIVE');
  });
});

describe('조직 합류', () => {
  it('초대 수락 시 users.org_id와 agents.org_id가 함께 채워진다', async () => {
    const { userId: repId, orgId } = await createTestOrg('rep');
    const { token } = await createInvite(orgId, repId, { teamRole: 'BACKEND' });

    const bob = await signup({ loginId: 'bob', password: PASSWORD, nickname: 'Bob' });
    const { agentId } = await connectAgent(connectInput(bob.connectKey, 'bob-laptop'));

    await acceptInvite(token, bob.userId);

    const user = await pool.query('SELECT org_id, org_role FROM users WHERE id = $1', [bob.userId]);
    expect(user.rows[0]).toEqual({ org_id: orgId, org_role: 'MEMBER' });

    const agent = await pool.query('SELECT org_id FROM agents WHERE id = $1', [agentId]);
    expect(agent.rows[0]!.org_id).toBe(orgId);

    const joined = await pool.query(`SELECT payload FROM events WHERE type = 'MEMBER_JOINED'`);
    expect(joined.rows[0]!.payload.teamRole).toBe('BACKEND');
  });

  it('조직을 만들면 먼저 연결해 둔 에이전트도 그 조직에 들어간다', async () => {
    const { userId, connectKey } = await signup({ loginId: 'alice', password: PASSWORD, nickname: 'a' });
    const { agentId } = await connectAgent(connectInput(connectKey));

    const { createOrganization } = await import('../src/domain/org/service.js');
    const { orgId } = await createOrganization(userId, 'Acme');

    const { rows } = await pool.query('SELECT org_id FROM agents WHERE id = $1', [agentId]);
    expect(rows[0]!.org_id).toBe(orgId);
  });

  it('다른 조직 소속은 초대를 수락할 수 없다', async () => {
    const { userId: repA, orgId: orgA } = await createTestOrg('rep-a', 'Org A');
    const { userId: repB } = await createTestOrg('rep-b', 'Org B');
    const { token } = await createInvite(orgA, repA);

    await expect(acceptInvite(token, repB)).rejects.toMatchObject({ code: 'ALREADY_IN_ORG', status: 409 });
  });

  it('이미 수락한 사람이 다시 수락해도 성공한다 (멱등)', async () => {
    const { userId: repId, orgId } = await createTestOrg('rep');
    const { token } = await createInvite(orgId, repId);
    const bob = await signup({ loginId: 'bob', password: PASSWORD, nickname: 'Bob' });

    await acceptInvite(token, bob.userId);
    await expect(acceptInvite(token, bob.userId)).resolves.toEqual({ userId: bob.userId, orgId });

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'MEMBER_JOINED'`);
    expect(rows[0]!.n).toBe(1);
  });
});
