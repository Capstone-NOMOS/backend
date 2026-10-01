import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Credentials } from '../src/bridge/credentials.js';
import { pool } from '../src/config/db.js';
import { connectAgent } from '../src/domain/agent/service.js';
import { signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { assignMember, createProject } from '../src/domain/project/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { connect, serverCalls, type ConnectDeps } from '../src/executor/connect.js';
import { ensureRepo, resolveCloneSource } from '../src/executor/repo-checkout.js';
import { assignRootOwner } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

// nomos connect — 로그인 → 배정 대기(자동 재발급) → start, 그리고 태스크 레포 자동 클론.

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

const CREDS: Credentials = { baseUrl: 'https://api.example', accessToken: 'at', refreshToken: 'rt', agentId: 'ag' };
const SELF = { projectId: 'p1', teamRole: 'BACKEND', maxConcurrent: 2 };

function fakeDeps(over: Partial<ConnectDeps> & { selves?: (typeof SELF | null)[] }) {
  const calls: string[] = [];
  const lines: string[] = [];
  const selves = over.selves ?? [SELF];
  const deps: ConnectDeps = {
    server: 'https://api.example',
    agentName: 'mbp',
    readCredentials: () => CREDS,
    login: async () => void calls.push('login'),
    refresh: async () => (calls.push('refresh'), 'ok'),
    describeSelf: async () => (calls.push('describe'), selves.shift() ?? null),
    sleep: async () => void calls.push('sleep'),
    log: (l) => lines.push(l),
    ...over,
  };
  return { deps, calls, lines };
}

describe('connect — 단계별 동작', () => {
  it('자격 증명이 없으면 로그인부터, 배정돼 있으면 바로 끝난다', async () => {
    const { deps, calls } = fakeDeps({ readCredentials: () => null });
    expect(await connect(deps)).toEqual(SELF);
    expect(calls).toEqual(['login', 'describe']);
  });

  it('다른 서버의 자격 증명이면 다시 로그인한다', async () => {
    const { deps, calls, lines } = fakeDeps({ readCredentials: () => ({ ...CREDS, baseUrl: 'http://localhost:3000' }) });
    await connect(deps);
    expect(calls[0]).toBe('login');
    expect(lines.join('\n')).toContain('http://localhost:3000');
  });

  it('저장된 자격 증명이 거부되면(재발급 4xx) 다시 로그인한다', async () => {
    const { deps, calls } = fakeDeps({ refresh: async () => 'rejected' });
    await connect(deps);
    expect(calls).toEqual(['login', 'describe']);
  });

  it('배정 전이면 한 번만 안내하고, 기다릴 때마다 재발급해 배정을 확인한다', async () => {
    const { deps, calls, lines } = fakeDeps({ selves: [null, null, SELF] });
    expect(await connect(deps)).toEqual(SELF);
    expect(calls).toEqual(['refresh', 'describe', 'sleep', 'refresh', 'describe', 'sleep', 'refresh', 'describe']);
    expect(lines.filter((l) => l.includes('배정되지 않았다'))).toHaveLength(1);
    expect(lines.join('\n')).toContain('"mbp"');
  });
});

describe('connect — 실제 서버와 왕복', () => {
  it('배정 전에는 기다리고, 대표가 배정하면 재발급된 토큰으로 프로젝트를 받는다', async () => {
    const rep = await signup({ loginId: 'rep', password: 'correct-horse-battery', nickname: '대표' });
    const { orgId } = await createOrganization(rep.userId, 'Acme');
    const be = await signup({ loginId: 'be', password: 'correct-horse-battery', nickname: '백엔드' });
    const { token } = await createInvite(orgId, rep.userId);
    await acceptInvite(token, be.userId);
    const [repo] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/api' }] });
    await assignRootOwner(orgId, rep.userId, repo!.id, 'BACKEND');
    const { project } = await createProject(orgId, rep.userId, { name: 'P', autonomyPreset: 'L2', pmBudgetUsd: 10, repoIds: [repo!.id] });
    const agent = await connectAgent({ connectKey: be.connectKey, agentName: 'be-mbp', harness: 'claude-code', skills: [], maxConcurrent: 1 });

    // 파일 대신 메모리 저장소.
    let stored: Credentials = { baseUrl, accessToken: agent.accessToken, refreshToken: agent.refreshToken, agentId: agent.agentId };
    const calls = serverCalls({ read: () => stored, updateAccessToken: (t) => (stored = { ...stored, accessToken: t }) });

    let waits = 0;
    const self = await connect({
      server: baseUrl,
      agentName: 'be-mbp',
      readCredentials: () => stored,
      login: async () => {
        throw new Error('로그인할 일이 없어야 한다');
      },
      ...calls,
      // 첫 대기에서 대표가 배정한다.
      sleep: async () => {
        waits += 1;
        if (waits === 1) {
          await assignMember({ userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' }, project.id, agent.agentId, 'BACKEND');
        }
      },
      log: () => {},
    });

    expect(waits).toBe(1);
    expect(self).toMatchObject({ projectId: project.id, teamRole: 'BACKEND' });
  });

  it('없는 refresh token은 rejected — 다시 로그인할 일이다', async () => {
    const calls = serverCalls({ read: () => ({ ...CREDS, baseUrl }), updateAccessToken: () => {} });
    expect(await calls.refresh()).toBe('rejected');
  });
});

describe('레포 자동 클론', () => {
  let tmp: string;
  let origin: string;
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  const quiet = { git: (args: string[], cwd: string) => git(args, cwd) };

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'nomos-checkout-'));
    // 원격 흉내: 커밋 하나가 있는 레포.
    origin = path.join(tmp, 'origin');
    execFileSync('git', ['init', '-q', '-b', 'main', origin]);
    writeFileSync(path.join(origin, 'README.md'), 'v1\n');
    git(['add', '.'], origin);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'v1'], origin);
    return () => rmSync(tmp, { recursive: true, force: true });
  });

  it('없으면 ~/.nomos/repos/<조직>/<레포>에 받고, 다음에는 fetch해 origin/<기본 브랜치>에서 분기한다', () => {
    const root = path.join(tmp, 'repos');
    const first = ensureRepo({ fullName: 'acme/api', cloneUrl: origin }, { ...quiet, root, readMap: () => ({}) });
    expect(first).toMatchObject({ path: path.join(root, 'acme', 'api'), managed: true });
    expect(first.baseRef('main')).toBe('origin/main');

    // 원격에 새 커밋 → 다음 태스크는 그 위에서 시작해야 한다.
    writeFileSync(path.join(origin, 'README.md'), 'v2\n');
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'v2'], origin);
    ensureRepo({ fullName: 'acme/api', cloneUrl: origin }, { ...quiet, root, readMap: () => ({}) });
    const head = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: first.path, encoding: 'utf-8' }).trim();
    expect(head).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: origin, encoding: 'utf-8' }).trim());
  });

  it('repos.json에 적힌 경로가 있으면 받지 않고 그대로 쓴다', () => {
    const checkout = ensureRepo({ fullName: 'acme/api', cloneUrl: null }, { ...quiet, root: path.join(tmp, 'repos'), readMap: () => ({ 'acme/api': origin }) });
    expect(checkout).toMatchObject({ path: origin, managed: false });
    expect(checkout.baseRef('main')).toBe('main');
  });

  it('받지 못하면 무엇을 하라는 안내와 함께 실패한다', () => {
    expect(() =>
      ensureRepo({ fullName: 'acme/none', cloneUrl: path.join(tmp, 'missing') }, { ...quiet, root: path.join(tmp, 'repos'), readMap: () => ({}) }),
    ).toThrow(/gh auth login.*repos\.json/s);
  });

  it('서버가 준 clone 주소도 노트북에서 한 번 더 거른다', () => {
    expect(resolveCloneSource('acme/api', null)).toBe('https://github.com/acme/api.git');
    expect(resolveCloneSource('acme/api', 'https://github.com/acme/api')).toBe('https://github.com/acme/api');
    for (const bad of ['--upload-pack=touch /tmp/x', 'ext::sh -c id', 'http://github.com/a/b', 'git@github.com:a/b.git', 'https://u:p@github.com/a/b', 'relative/path']) {
      expect(() => resolveCloneSource('acme/api', bad), bad).toThrow();
    }
    expect(() => resolveCloneSource('../etc', null)).toThrow();
    expect(() => ensureRepo({ fullName: '../etc', cloneUrl: origin }, { ...quiet, root: path.join(tmp, 'repos'), readMap: () => ({}) })).toThrow();
  });
});
