import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/config/db.js';
import type { GithubDeviceApi } from '../src/domain/oauth/github-device.js';
import { completeGithubDeviceFlow } from '../src/domain/oauth/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { githubInspector } from '../src/domain/verification/github-inspector.js';
import { CommitNotFoundError, InspectionSkipped } from '../src/domain/verification/inspection.js';
import { githubBaseBuilder } from '../src/domain/task/task-base.js';
import { createTestOrg } from './fixtures.js';
import { resetSchema, testPool, truncateAll } from './test-db.js';

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

const TOKEN = 'gho_representative_token';
const REPO_ID = 987654321;
const SHA = 'a1b2c3d4e5f6';
const API = 'https://gh.test';

// 대표의 GitHub 연결은 실제 연결 서비스를 거친다 — 토큰이 암호화되어 저장되는 경로까지 함께 탄다.
function deviceApi(): GithubDeviceApi {
  return {
    requestDeviceCode: async () => ({ deviceCode: 'd', userCode: 'U', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    exchangeDeviceCode: async () => ({ status: 'ok', accessToken: TOKEN, scope: 'repo read:org' }),
    fetchViewer: async () => ({ githubId: 4242, githubLogin: 'rep-gh' }),
  };
}

async function setup(options: { connectGithub?: boolean; githubRepoId?: number | null } = {}) {
  const { userId, orgId } = await createTestOrg('rep');
  const githubRepoId = options.githubRepoId === undefined ? REPO_ID : options.githubRepoId;
  const [repo] = await connectRepos({
    orgId,
    actorUserId: userId,
    repos: [{ fullName: 'acme/study-api', ...(githubRepoId === null ? {} : { githubRepoId }) }],
  });
  if (options.connectGithub !== false) await completeGithubDeviceFlow(userId, 'd', deviceApi());
  // baseBranch null — 커밋 하나만 보는 경로. 태스크 브랜치 비교(compare)는 아래 따로 본다.
  return { orgId, input: { repoId: repo!.id, orgId, cloneUrl: null, githubRepoId, commitSha: SHA, baseBranch: null as string | null } };
}

type Route = { status: number; body?: unknown; headers?: Record<string, string> };
type Call = { url: string; auth: string | null };

// URL → 응답 표. 부른 순서와 헤더를 기록한다.
function fakeGithub(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, auth: new Headers(init?.headers).get('Authorization') });
    const route = routes[url];
    if (!route) return new Response('not routed', { status: 500 });
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status,
      headers: route.headers ?? {},
    });
  };
  return { calls, inspector: githubInspector({ db: pool, fetchImpl, apiBase: API }) };
}

const COMMIT_URL = `${API}/repositories/${REPO_ID}/commits/${SHA}`;

describe('githubInspector', () => {
  it('파일 목록을 페이지 끝까지 모으고, 이름 변경은 옛 경로도 포함한다', async () => {
    const { input } = await setup();
    const { calls, inspector } = fakeGithub({
      [COMMIT_URL]: {
        status: 200,
        body: {
          files: [
            { filename: 'src/api/join.ts', status: 'modified', patch: '@@ 코드 내용 @@' },
            { filename: 'src/api/apply.ts', status: 'renamed', previous_filename: 'src/api/old-apply.ts' },
          ],
        },
        headers: { link: `<${COMMIT_URL}?page=2>; rel="next"` },
      },
      [`${COMMIT_URL}?page=2`]: { status: 200, body: { files: [{ filename: 'tests/join.test.ts' }] } },
    });

    const paths = await inspector.changedPaths(input);

    expect(paths.sort()).toEqual(['src/api/apply.ts', 'src/api/join.ts', 'src/api/old-apply.ts', 'tests/join.test.ts']);
    // 레포는 이름이 아니라 id로 찾고, 대표의 토큰을 복호화해 쓴다.
    expect(calls.map((c) => c.url)).toEqual([COMMIT_URL, `${COMMIT_URL}?page=2`]);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('대표가 GitHub를 연결하지 않았으면 SKIPPED — 사유는 "GitHub 미연결"', async () => {
    const { input } = await setup({ connectGithub: false });
    const { calls, inspector } = fakeGithub({});

    await expect(inspector.changedPaths(input)).rejects.toSatisfy(
      (err) => err instanceof InspectionSkipped && err.reason.includes('GitHub 미연결'),
    );
    expect(calls).toHaveLength(0); // 토큰이 없으면 GitHub를 부르지도 않는다
  });

  it('github_repo_id가 없으면 SKIPPED', async () => {
    const { input } = await setup({ githubRepoId: null });
    const { inspector } = fakeGithub({});

    await expect(inspector.changedPaths(input)).rejects.toSatisfy(
      (err) => err instanceof InspectionSkipped && err.reason.includes('github_repo_id'),
    );
  });

  it('없는 커밋은 CommitNotFoundError(→ FAIL)다 — 422, 그리고 레포는 보이는데 404인 경우', async () => {
    const { input } = await setup();

    await expect(fakeGithub({ [COMMIT_URL]: { status: 422 } }).inspector.changedPaths(input)).rejects.toBeInstanceOf(
      CommitNotFoundError,
    );
    await expect(
      fakeGithub({
        [COMMIT_URL]: { status: 404 },
        [`${API}/repositories/${REPO_ID}`]: { status: 200, body: { id: REPO_ID } },
      }).inspector.changedPaths(input),
    ).rejects.toBeInstanceOf(CommitNotFoundError);
  });

  // 404는 "커밋이 없다"와 "토큰으로 레포가 안 보인다"가 섞여 있다. 후자를 FAIL로 적으면
  // 에이전트가 자기 잘못이 아닌 일로 재시도를 잃는다.
  it('토큰으로 레포가 안 보여서 난 404는 SKIPPED다', async () => {
    const { input } = await setup();
    const { inspector } = fakeGithub({
      [COMMIT_URL]: { status: 404 },
      [`${API}/repositories/${REPO_ID}`]: { status: 404 },
    });

    await expect(inspector.changedPaths(input)).rejects.toSatisfy(
      (err) => err instanceof InspectionSkipped && err.reason.includes('접근할 수 없다'),
    );
  });

  it('토큰 무효·한도 초과는 SKIPPED이고 사유에 토큰이 들어가지 않는다', async () => {
    const { input } = await setup();

    const invalid = await fakeGithub({ [COMMIT_URL]: { status: 401 } })
      .inspector.changedPaths(input)
      .catch((err: unknown) => err);
    expect(invalid).toBeInstanceOf(InspectionSkipped);
    expect((invalid as InspectionSkipped).reason).toContain('다시 연결');
    expect((invalid as InspectionSkipped).reason).not.toContain(TOKEN);

    const limited = await fakeGithub({
      [COMMIT_URL]: { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
    })
      .inspector.changedPaths(input)
      .catch((err: unknown) => err);
    expect((limited as InspectionSkipped).reason).toContain('한도');
  });

  it('파일이 GitHub 한도를 넘어 전체를 못 보면 PASS가 아니라 SKIPPED다', async () => {
    const { input } = await setup();
    // 매 페이지가 다음 페이지를 가리킨다 — 끝이 없다.
    const routes: Record<string, Route> = {};
    for (let page = 1; page <= 11; page += 1) {
      const url = page === 1 ? COMMIT_URL : `${COMMIT_URL}?page=${page}`;
      routes[url] = {
        status: 200,
        body: { files: [{ filename: `f${page}.ts` }] },
        headers: { link: `<${COMMIT_URL}?page=${page + 1}>; rel="next"` },
      };
    }

    await expect(fakeGithub(routes).inspector.changedPaths(input)).rejects.toSatisfy(
      (err) => err instanceof InspectionSkipped && err.reason.includes('전체 diff'),
    );
  });

  it('GitHub 5xx는 일반 에러로 던진다 — 호출부가 서버 쪽 사정(SKIPPED)으로 적는다', async () => {
    const { input } = await setup();

    await expect(fakeGithub({ [COMMIT_URL]: { status: 502 } }).inspector.changedPaths(input)).rejects.toThrow(
      /GitHub 응답 502/,
    );
  });
});

describe('githubInspector — 파일 내용(dep:add 판정용)', () => {
  it('부모 커밋과 그 커밋의 package.json을 raw로 읽고, 그 시점에 없던 파일은 null', async () => {
    const { input } = await setup();
    const urls: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      urls.push(url);
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
      if (url === COMMIT_URL) return new Response(JSON.stringify({ parents: [{ sha: 'parent0' }] }), { status: 200 });
      if (url === `${API}/repositories/${REPO_ID}/contents/apps/web/package.json?ref=parent0`) return new Response('', { status: 404 });
      if (url === `${API}/repositories/${REPO_ID}/contents/apps/web/package.json?ref=${SHA}`) return new Response('{"dependencies":{"react":"^19"}}', { status: 200 });
      return new Response('not routed', { status: 500 });
    };
    const inspector = githubInspector({ db: pool, fetchImpl, apiBase: API });
    await expect(inspector.fileVersions!(input, 'apps/web/package.json')).resolves.toEqual({ before: null, after: '{"dependencies":{"react":"^19"}}' });
    expect(urls).toHaveLength(3);
  });

  it('GitHub가 실패하면 던진다 — 호출부는 dep:add로 본다(fail closed)', async () => {
    const { input } = await setup();
    const inspector = githubInspector({ db: pool, fetchImpl: async () => new Response('', { status: 502 }), apiBase: API });
    await expect(inspector.fileVersions!(input, 'package.json')).rejects.toThrow('502');
  });
});

// 태스크 브랜치 전체(기본 브랜치와의 분기점 ... 커밋)를 본다 — 재시도·재개로 커밋이 여럿이면 마지막 커밋 하나로는 앞 커밋의 파일이 "과다 신고"가 됐다(통합 테스트).
describe('githubInspector — 태스크 브랜치 비교(baseBranch)', () => {
  const COMPARE_URL = `${API}/repositories/${REPO_ID}/compare/main...${SHA}`;

  it('기본 브랜치와 비교해 브랜치의 모든 파일을 모으고, 분기점이 package.json의 "직전"이 된다', async () => {
    const { input } = await setup();
    const withBase = { ...input, baseBranch: 'main' };
    const { calls, inspector } = fakeGithub({
      [COMPARE_URL]: {
        status: 200,
        body: {
          status: 'ahead',
          merge_base_commit: { sha: 'base0' },
          files: [{ filename: 'src/a.ts' }, { filename: 'src/b.ts', previous_filename: 'src/old-b.ts' }, { filename: 'package.json' }],
        },
      },
      [`${API}/repositories/${REPO_ID}/contents/package.json?ref=base0`]: { status: 200, body: { dependencies: {} } },
      [`${API}/repositories/${REPO_ID}/contents/package.json?ref=${SHA}`]: { status: 200, body: { dependencies: { zod: '^3' } } },
    });
    expect((await inspector.changedPaths(withBase)).sort()).toEqual(['package.json', 'src/a.ts', 'src/b.ts', 'src/old-b.ts']);
    expect(calls.map((c) => c.url)).toEqual([COMPARE_URL]); // 커밋 하나 조회는 하지 않는다

    const versions = await inspector.fileVersions!(withBase, 'package.json');
    expect(JSON.parse(versions.before!)).toEqual({ dependencies: {} });
    expect(JSON.parse(versions.after!)).toEqual({ dependencies: { zod: '^3' } });
  });

  it('비교가 안 되거나(404) 커밋이 이미 기본 브랜치에 있으면(behind) 커밋 하나로 본다', async () => {
    const { input } = await setup();
    const withBase = { ...input, baseBranch: 'main' };
    const single = { [COMMIT_URL]: { status: 200, body: { files: [{ filename: 'src/only.ts' }] } } };
    expect(await fakeGithub({ [COMPARE_URL]: { status: 404 }, ...single }).inspector.changedPaths(withBase)).toEqual(['src/only.ts']);
    expect(await fakeGithub({ [COMPARE_URL]: { status: 200, body: { status: 'behind', files: [] } }, ...single }).inspector.changedPaths(withBase)).toEqual(['src/only.ts']);
    // 비교가 안 되고 커밋도 없으면 여전히 없는 커밋(FAIL)이다.
    await expect(fakeGithub({ [COMPARE_URL]: { status: 404 }, [COMMIT_URL]: { status: 422 } }).inspector.changedPaths(withBase)).rejects.toBeInstanceOf(CommitNotFoundError);
  });

  it('비교 결과가 파일 한도(300)에 닿으면 SKIPPED다', async () => {
    const { input } = await setup();
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts` }));
    await expect(
      fakeGithub({ [COMPARE_URL]: { status: 200, body: { status: 'ahead', files } } }).inspector.changedPaths({ ...input, baseBranch: 'main' }),
    ).rejects.toBeInstanceOf(InspectionSkipped);
  });
});

// 선행 태스크 위에서 시작한 태스크(InspectInput.baseCommits) — 선행 커밋마다 compare해 교집합만 이 태스크의 변경이다.
describe('githubInspector — 선행 커밋 기준', () => {
  const A = 'aaaa1111aaaa';
  const B = 'bbbb2222bbbb';
  const cmp = (base: string) => `${API}/repositories/${REPO_ID}/compare/${base}...${SHA}`;

  it('선행 A·B 기준 비교의 교집합 — 선행이 만든 파일은 빠진다', async () => {
    const { input } = await setup();
    const { calls, inspector } = fakeGithub({
      [COMMIT_URL]: { status: 200, body: { files: [] } },
      [cmp(A)]: { status: 200, body: { status: 'ahead', files: [{ filename: 'route.py' }, { filename: 'repo.py' }] } },
      [cmp(B)]: { status: 200, body: { status: 'ahead', files: [{ filename: 'route.py' }, { filename: 'app.py' }] } },
    });
    expect(await inspector.changedPaths({ ...input, baseBranch: 'main', baseCommits: [A, B] })).toEqual(['route.py']);
    expect(calls.map((c) => c.url)).toEqual([COMMIT_URL, cmp(A), cmp(B)]);
  });

  it('제출 커밋이 없으면 FAIL(없는 커밋), 선행 커밋과 비교가 안 되면 SKIPPED', async () => {
    const { input } = await setup();
    const missing = fakeGithub({ [COMMIT_URL]: { status: 422 } });
    await expect(missing.inspector.changedPaths({ ...input, baseCommits: [A] })).rejects.toBeInstanceOf(CommitNotFoundError);
    const gone = fakeGithub({ [COMMIT_URL]: { status: 200, body: { files: [] } }, [cmp(A)]: { status: 404 } });
    await expect(gone.inspector.changedPaths({ ...input, baseCommits: [A] })).rejects.toSatisfy(
      (err) => err instanceof InspectionSkipped && err.reason.includes('선행 태스크의 커밋'),
    );
  });
});

// 시작 기준점(036)의 GitHub 구현 — 대표 토큰으로 nomos/base/<id>를 기본 브랜치 머리에 만들고 merges API로 선행을 합친다.
describe('githubBaseBuilder', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const MAIN = 'c'.repeat(40);
  const REPO = `${API}/repos/acme/study-api`;
  const pred = (taskId: string, commitSha: string) => ({ taskId, title: taskId, branchName: `task/${taskId}`, commitSha });

  function scripted(responses: { method: string; url: string; status: number; body?: unknown }[]) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const next = responses.shift();
      if (!next || next.method !== method || next.url !== url) return new Response(`unexpected ${method} ${url}`, { status: 500 });
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
    };
    return { calls, builder: githubBaseBuilder({ fetchImpl, apiBase: API }) };
  }

  it('기본 브랜치 머리에 브랜치를 만들고 선행을 차례로 합친다 — 이미 들어 있으면(204) 건너뛴다', async () => {
    const { orgId, input } = await setup();
    const { calls, builder } = scripted([
      { method: 'GET', url: `${REPO}/git/ref/heads/main`, status: 200, body: { object: { sha: MAIN } } },
      { method: 'POST', url: `${REPO}/git/refs`, status: 201 },
      { method: 'POST', url: `${REPO}/merges`, status: 201, body: { sha: A } },
      { method: 'POST', url: `${REPO}/merges`, status: 204 },
    ]);
    const built = await builder.build({ taskId: 't1', orgId, repoId: input.repoId, fullName: 'acme/study-api', cloneUrl: null, defaultBranch: 'main', predecessors: [pred('p1', A), pred('p2', B)] });
    expect(built).toEqual({ commitSha: A });
    expect(calls[1]!.body).toEqual({ ref: 'refs/heads/nomos/base/t1', sha: MAIN });
    expect(calls[2]!.body).toMatchObject({ base: 'nomos/base/t1', head: A });
  });

  it('브랜치가 이미 있으면 기본 브랜치 머리로 되돌리고, 충돌(409)이면 그 선행을 알린다', async () => {
    const { orgId, input } = await setup();
    const { calls, builder } = scripted([
      { method: 'GET', url: `${REPO}/git/ref/heads/main`, status: 200, body: { object: { sha: MAIN } } },
      { method: 'POST', url: `${REPO}/git/refs`, status: 422 },
      { method: 'PATCH', url: `${REPO}/git/refs/heads/nomos/base/t2`, status: 200 },
      { method: 'POST', url: `${REPO}/merges`, status: 409 },
    ]);
    const built = await builder.build({ taskId: 't2', orgId, repoId: input.repoId, fullName: 'acme/study-api', cloneUrl: null, defaultBranch: 'main', predecessors: [pred('p1', A)] });
    expect(built).toEqual({ conflict: pred('p1', A) });
    expect(calls[2]!.body).toEqual({ sha: MAIN, force: true });
  });
});
