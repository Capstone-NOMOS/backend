import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { login, signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { validateCloneUrl } from '../src/domain/repo/clone-url.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { CommitNotFoundError, gitMirrorInspector } from '../src/domain/verification/commit-inspector.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

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

// clone_url은 서버가 `git clone`에 그대로 넘긴다. 수정 가능하게 연 순간 이 검증이 보안 경계다.
describe('clone_url 검증', () => {
  it('mirror 모드(로컬)는 https(자격 증명 없이)와 로컬 절대 경로를 받는다', () => {
    for (const ok of [
      'https://github.com/acme/study-api.git',
      'https://gitlab.example.com/acme/study-api.git',
      'file:///srv/repos/study-api',
      '/home/me/work/study-api',
      'C:\\Users\\me\\work\\study-api',
      'C:/Users/me/work/study-api',
    ]) {
      expect(validateCloneUrl(ok, 'mirror')).toBe(ok);
    }
  });

  // 운영 서버에서 절대 경로를 받으면 서버 파일시스템의 다른 git 저장소(다른 조직의 mirror 포함)를 읽을 수 있다.
  it('github 모드(운영)는 https://github.com/owner/repo만 받는다', () => {
    for (const ok of ['https://github.com/acme/study-api.git', 'https://github.com/acme/study-api', 'https://GITHUB.com/acme/x']) {
      expect(validateCloneUrl(ok, 'github')).toBe(ok);
    }
    for (const [bad, why] of [
      ['/home/ec2-user/.nomos/server-mirrors/other-org.git', /로컬 경로/],
      ['C:/repos/x', /로컬 경로/],
      ['file:///srv/repos/x', /file:\/\//],
      ['https://gitlab.com/acme/x.git', /github\.com이 아니다/],
      ['https://github.com.evil.com/acme/x.git', /github\.com이 아니다/], // 접두어로는 통과하는 함정
      ['https://github.com:8443/acme/x.git', /github\.com이 아니다/],
      ['https://github.com/acme', /owner\/repo/],
      ['https://github.com/', /owner\/repo/],
    ] as const) {
      expect(() => validateCloneUrl(bad, 'github'), bad).toThrow(why);
    }
  });

  it('git 옵션 주입·원격 헬퍼·SSH·평문·자격 증명·상대 경로는 모드와 무관하게 거부한다', () => {
    for (const bad of [
      '--upload-pack=touch /tmp/pwned', // git이 옵션으로 읽어 서버에서 명령을 실행한다
      '-oProxyCommand=evil',
      'ext::sh -c touch% /tmp/pwned', // 원격 헬퍼가 명령을 실행한다
      'ssh://git@github.com/acme/x.git',
      'git@github.com:acme/x.git', // scp 형식
      'http://github.com/acme/x.git',
      'https://user:ghp_token@github.com/acme/x.git', // 자격 증명이 DB·이벤트에 남는다
      'relative/path/repo',
      'https://github.com/acme/x.git\n--upload-pack=x',
      '   ',
    ]) {
      for (const mode of ['github', 'mirror'] as const) {
        expect(() => validateCloneUrl(bad, mode), `${mode}: ${bad}`).toThrow(/clone_url/);
      }
    }
  });
});

describe('PATCH /api/repos/:repoId', () => {
  async function account(loginId: string): Promise<{ userId: string; token: string }> {
    const { userId } = await signup({ loginId, password: 'correct-horse-battery', nickname: loginId });
    const { accessToken } = await login({ loginId, password: 'correct-horse-battery' });
    return { userId, token: accessToken };
  }

  async function patch(repoId: string, token: string, body: unknown) {
    const res = await fetch(`${baseUrl}/api/repos/${repoId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, never> };
  }

  async function org() {
    const rep = await account('rep');
    const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');
    const [repo] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/study-api' }] });
    return { rep, orgId, repoId: repo!.id };
  }

  it('대표가 github_repo_id·clone_url을 채우고, 이전·이후 값이 이벤트로 남는다', async () => {
    const { rep, repoId } = await org();

    const res = await patch(repoId, rep.token, {
      githubRepoId: 987654321,
      cloneUrl: 'https://github.com/acme/study-api.git',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        repo: {
          id: repoId,
          fullName: 'acme/study-api',
          githubRepoId: 987654321,
          defaultBranch: 'main',
          devBranch: 'dev',
          cloneUrl: 'https://github.com/acme/study-api.git',
        },
      },
    });
    const { rows } = await pool.query(`SELECT payload, on_behalf_of FROM events WHERE type = 'REPO_UPDATED'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      on_behalf_of: rep.userId,
      payload: {
        repoId,
        before: { githubRepoId: null, cloneUrl: null },
        after: { githubRepoId: 987654321, cloneUrl: 'https://github.com/acme/study-api.git' },
      },
    });
  });

  it('넘긴 키만 바꾸고, null은 비운다', async () => {
    const { rep, repoId } = await org();
    await patch(repoId, rep.token, { githubRepoId: 111, cloneUrl: 'https://github.com/acme/a.git' });

    const res = await patch(repoId, rep.token, { cloneUrl: null });
    expect(res.body).toMatchObject({ data: { repo: { githubRepoId: 111, cloneUrl: null } } });
  });

  it('팀원은 403 — 서버가 무엇을 읽을지는 대표가 정한다', async () => {
    const { rep, orgId, repoId } = await org();
    const member = await account('member');
    const invite = await createInvite(orgId, rep.userId, { teamRole: 'BACKEND' });
    await acceptInvite(invite.token, member.userId);

    const res = await patch(repoId, member.token, { githubRepoId: 1 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'NOT_REPRESENTATIVE' } });
  });

  it('다른 조직의 레포는 403이다', async () => {
    const { repoId } = await org();
    const outsider = await account('outsider');
    await createOrganization(outsider.userId, 'Other Inc.');

    const res = await patch(repoId, outsider.token, { githubRepoId: 1 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'CROSS_ORG_ACCESS' } });
  });

  it('위험한 clone_url은 400이고 사유를 돌려주며, 아무것도 바뀌지 않는다', async () => {
    const { rep, repoId } = await org();

    const res = await patch(repoId, rep.token, { cloneUrl: '--upload-pack=touch /tmp/pwned' });
    expect(res.status).toBe(400);
    expect((res.body as unknown as { error: { message: string } }).error.message).toContain('-로 시작');

    const { rows } = await pool.query(`SELECT clone_url FROM repos WHERE id = $1`, [repoId]);
    expect(rows[0]!.clone_url).toBeNull();
    const events = await pool.query(`SELECT count(*)::int AS n FROM events WHERE type = 'REPO_UPDATED'`);
    expect(events.rows[0]!.n).toBe(0);
  });

  it('같은 조직의 다른 레포가 이미 가리키는 github_repo_id는 409다', async () => {
    const { rep, orgId, repoId } = await org();
    const [other] = await connectRepos({ orgId, actorUserId: rep.userId, repos: [{ fullName: 'acme/study-web' }] });
    await patch(other!.id, rep.token, { githubRepoId: 42 });

    const res = await patch(repoId, rep.token, { githubRepoId: 42 });
    expect(res.status).toBe(409);
    expect((res.body as unknown as { error: { message: string } }).error.message).toContain('acme/study-web');
  });

  it('운영(github 모드) 서버에서는 로컬 경로를 받지 않는다 — 서버가 도는 모드를 따른다', async () => {
    const { rep, repoId } = await org();
    const previous = env.COMMIT_INSPECTOR;
    env.COMMIT_INSPECTOR = 'github';
    try {
      const local = await patch(repoId, rep.token, { cloneUrl: '/home/ec2-user/.nomos/server-mirrors/other.git' });
      expect(local.status).toBe(400);
      expect((local.body as unknown as { error: { message: string } }).error.message).toContain('COMMIT_INSPECTOR=github');

      const ok = await patch(repoId, rep.token, { cloneUrl: 'https://github.com/acme/study-api.git' });
      expect(ok.status).toBe(200);
    } finally {
      env.COMMIT_INSPECTOR = previous;
    }
    // 같은 값이 로컬(mirror 모드)에서는 받아진다.
    expect((await patch(repoId, rep.token, { cloneUrl: '/home/me/work/study-api' })).status).toBe(200);
  });

  it('빈 바디는 400이다', async () => {
    const { rep, repoId } = await org();
    expect((await patch(repoId, rep.token, {})).status).toBe(400);
  });
});

// clone_url을 바꿀 수 있게 됐으므로, 이미 만들어진 mirror가 옛 주소를 붙들고 있으면 안 된다.
describe('mirror — clone_url이 바뀌면 새 원격을 본다', () => {
  const QUIET = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };

  function repoWithCommit(root: string, name: string): { dir: string; sha: string } {
    const dir = path.join(root, name);
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', dir], QUIET);
    writeFileSync(path.join(dir, `${name}.ts`), name);
    execFileSync('git', ['-C', dir, 'add', '.'], QUIET);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', name], QUIET);
    return { dir, sha: execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], QUIET).trim() };
  }

  it('같은 레포 id의 mirror가 새 clone_url에서 커밋을 찾는다', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nomos-mirror-'));
    const a = repoWithCommit(root, 'old-origin');
    const b = repoWithCommit(root, 'new-origin');
    const inspector = gitMirrorInspector(path.join(root, 'mirrors'));
    const input = { repoId: 'repo-1', orgId: 'org-1', githubRepoId: null };

    expect(await inspector.changedPaths({ ...input, cloneUrl: a.dir, commitSha: a.sha })).toEqual(['old-origin.ts']);
    // 옛 원격에는 b의 커밋이 없다 — mirror가 원격을 안 바꾸면 여기서도 못 찾는다.
    expect(await inspector.changedPaths({ ...input, cloneUrl: b.dir, commitSha: b.sha })).toEqual(['new-origin.ts']);
    // mirror의 원격이 새 주소로 바뀌어 있다. (옛 커밋은 --prune이 ref만 지우고 오브젝트는 남기므로 여전히 읽힐 수 있다 —
    // 확인할 것은 "새 원격에서 받아 오는가"다.)
    const origin = execFileSync('git', ['--git-dir', path.join(root, 'mirrors', 'repo-1.git'), 'remote', 'get-url', 'origin'], QUIET).trim();
    expect(origin).toBe(b.dir);
    // 없는 커밋은 여전히 FAIL 쪽 에러다.
    await expect(
      inspector.changedPaths({ ...input, cloneUrl: b.dir, commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
    ).rejects.toBeInstanceOf(CommitNotFoundError);
  });
});
