import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/config/db.js';
import type { GithubDeviceApi } from '../src/domain/oauth/github-device.js';
import { completeGithubDeviceFlow } from '../src/domain/oauth/service.js';
import { connectRepos } from '../src/domain/repo/service.js';
import { githubInspector } from '../src/domain/verification/github-inspector.js';
import { CommitNotFoundError, InspectionSkipped } from '../src/domain/verification/inspection.js';
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
  return { orgId, input: { repoId: repo!.id, orgId, cloneUrl: null, githubRepoId, commitSha: SHA } };
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
