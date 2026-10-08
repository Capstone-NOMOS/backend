import { AppError } from '../../errors.js';

// 대표의 GitHub 토큰(oauth_sessions)으로 부르는 쓰기 API — GitHub 조직에 레포 만들기, 협업자 초대.
// 읽기 전용인 client.ts(서버의 GITHUB_TOKEN)와 따로 둔다: 누구의 권한으로 무엇을 바꾸는지가 다르다.
// 토큰 값은 오류 메시지·로그에 절대 넣지 않는다.
const DEFAULT_API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;

// git의 빈 트리. 모든 저장소에 암묵적으로 있는 객체라 파일 없는 커밋을 만들 때 쓴다.
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type CreatedGithubRepo = { fullName: string; githubRepoId: number; defaultBranch: string };
export type InviteOutcome = 'invited' | 'already_collaborator';

export type GithubRepApi = {
  listOrgs(token: string): Promise<string[]>;
  createOrgRepo(token: string, input: { org: string; name: string; description?: string }): Promise<CreatedGithubRepo>;
  inviteCollaborator(token: string, fullName: string, githubLogin: string): Promise<InviteOutcome>;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function createGithubRepApi(options: { fetchImpl?: FetchLike; apiBase?: string } = {}): GithubRepApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const api = options.apiBase ?? DEFAULT_API;

  function call(token: string, method: string, path: string, body?: unknown): Promise<Response> {
    return fetchImpl(`${api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nomos-server',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  // GitHub가 돌려준 message만 옮긴다(요청 헤더·토큰은 들어 있지 않다).
  async function failure(res: Response, what: string): Promise<AppError> {
    let message = '';
    try {
      message = String(((await res.json()) as { message?: unknown }).message ?? '');
    } catch {
      // 본문이 JSON이 아니면 상태 코드만 쓴다.
    }
    if (res.status === 401) return new AppError('GITHUB_NOT_LINKED', 'GitHub 토큰이 유효하지 않습니다 — 대표가 GitHub를 다시 연결해야 합니다');
    if (res.status === 403 || res.status === 404) {
      return new AppError('GITHUB_FORBIDDEN', `${what}: GitHub가 거부했습니다(${res.status}${message ? `, ${message}` : ''})`);
    }
    return new AppError('GITHUB_UNAVAILABLE', `${what}: GitHub 요청 실패(${res.status}${message ? `, ${message}` : ''})`);
  }

  async function json<T>(res: Response): Promise<T> {
    return (await res.json()) as T;
  }

  return {
    async listOrgs(token) {
      const orgs: string[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const res = await call(token, 'GET', `/user/orgs?per_page=100&page=${page}`);
        if (!res.ok) throw await failure(res, 'GitHub 조직 목록');
        const body = await json<Array<{ login: string }>>(res);
        orgs.push(...body.map((o) => o.login));
        if (body.length < 100) break;
      }
      return orgs;
    },

    // 비공개 레포를 만들고, 기본 브랜치에 **파일 없는 커밋 하나**만 남긴다.
    // 커밋이 없으면 브랜치가 없어 Executor가 origin/<기본 브랜치>에서 분기하지 못한다. 그렇다고 README를 두지 않는다(대표 결정).
    // 빈 레포에는 Git 데이터 API가 동작하지 않으므로 auto_init으로 README 커밋을 먼저 만든 뒤,
    // 빈 트리를 가리키는 부모 없는 커밋으로 기본 브랜치를 덮는다 — README 커밋은 어디에도 이어지지 않아 기록에 남지 않는다.
    async createOrgRepo(token, input) {
      const created = await call(token, 'POST', `/orgs/${encodeURIComponent(input.org)}/repos`, {
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        private: true,
        auto_init: true,
      });
      if (created.status === 422) {
        throw new AppError('GITHUB_REPO_NAME_TAKEN', `GitHub 조직 ${input.org}에 ${input.name} 레포를 만들 수 없습니다(이미 있거나 이름이 올바르지 않음)`);
      }
      if (!created.ok) throw await failure(created, `GitHub 레포 생성(${input.org}/${input.name})`);
      const repo = await json<{ id: number; full_name: string; default_branch: string }>(created);
      const fullName = repo.full_name;
      const branch = repo.default_branch;

      const commit = await call(token, 'POST', `/repos/${fullName}/git/commits`, {
        message: 'init',
        tree: EMPTY_TREE_SHA,
        parents: [],
      });
      if (!commit.ok) throw await failure(commit, `빈 첫 커밋 만들기(${fullName}) — 레포는 만들어졌다`);
      const { sha } = await json<{ sha: string }>(commit);

      const ref = await call(token, 'PATCH', `/repos/${fullName}/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: true });
      if (!ref.ok) throw await failure(ref, `기본 브랜치를 빈 커밋으로 맞추기(${fullName}) — 레포는 만들어졌다`);

      return { fullName, githubRepoId: repo.id, defaultBranch: branch };
    },

    // 201 = 초대장을 보냈다(멤버가 GitHub에서 수락해야 효력), 204 = 이미 접근할 수 있다.
    async inviteCollaborator(token, fullName, githubLogin) {
      const res = await call(token, 'PUT', `/repos/${fullName}/collaborators/${encodeURIComponent(githubLogin)}`, { permission: 'push' });
      if (res.status === 201) return 'invited';
      if (res.status === 204) return 'already_collaborator';
      throw await failure(res, `협업자 초대(${fullName} ← ${githubLogin})`);
    },
  };
}

let current: GithubRepApi = createGithubRepApi();

export function githubRepApi(): GithubRepApi {
  return current;
}

// 테스트가 GitHub에 닿지 않게 바꿔 끼운다. 운영 코드에서는 부르지 않는다. 되돌릴 때 쓰도록 이전 값을 돌려준다.
export function setGithubRepApi(next: GithubRepApi): GithubRepApi {
  const previous = current;
  current = next;
  return previous;
}
