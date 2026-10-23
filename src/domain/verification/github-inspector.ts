import type { Queryable } from '../../config/db.js';
import { decryptSecret } from '../../utils/secret-box.js';
import { parseNextLink } from '../github/client.js';
import { findRepresentativeGithubToken } from '../oauth/repository.js';
import { CommitNotFoundError, InspectionSkipped, MAX_MANIFEST_BYTES, type CommitInspector } from './inspection.js';

// GitHub 커밋 API로 "바뀐 파일 목록"만 읽는다. patch(코드 내용)는 응답에 오더라도 쓰지 않고 저장하지도 않는다.
//
// 레포는 이름이 아니라 github_repo_id로 찾는다(/repositories/{id}/...). 레포 이름이 바뀌면
// GitHub가 옛 이름 요청을 바로 이 경로로 리다이렉트하므로 id 경로가 정본이다.
//
// 토큰은 조직 대표의 것을 복호화해 쓴다(oauth_sessions). 대표가 GitHub를 연결하지 않았으면 V3는
// SKIPPED다 — FAIL로 적으면 에이전트 잘못이 아닌 일로 retry_count가 오른다.
const DEFAULT_API = 'https://api.github.com';
// GitHub는 커밋 하나에 파일 3000개까지만 준다(페이지당 300). 그걸 넘으면 전체를 확인할 수 없다.
const MAX_PAGES = 10;
const COMPARE_FILE_LIMIT = 300;
const TIMEOUT_MS = 10_000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type CommitFile = { filename: string; status?: string; previous_filename?: string };

export function githubInspector(options: { db: Queryable; fetchImpl?: FetchLike; apiBase?: string }): CommitInspector {
  const fetchImpl = options.fetchImpl ?? fetch;
  const api = options.apiBase ?? DEFAULT_API;

  function get(url: string, token: string): Promise<Response> {
    return fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        // GitHub API는 User-Agent가 없으면 거부한다.
        'User-Agent': 'nomos-server',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  // 한도 초과·권한 없음·토큰 무효는 전부 "서버 쪽 사정"이다. 토큰 값은 사유에 절대 넣지 않는다.
  function skipFor(res: Response): InspectionSkipped | null {
    if (res.status === 401) {
      return new InspectionSkipped('GitHub 토큰이 유효하지 않다 — 대표가 GitHub를 다시 연결해야 한다');
    }
    if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
      return new InspectionSkipped('GitHub 요청 한도 초과');
    }
    if (res.status === 403) return new InspectionSkipped('GitHub가 접근을 거부했다(403)');
    return null;
  }

  // 이름 변경은 옛 경로도 건드린 것이다(그 경로에서는 삭제). mirror 구현(--no-renames)도
  // 이름 변경을 삭제+추가로 보고하므로 두 구현의 결론을 맞춘다.
  function addFiles(paths: Set<string>, files: CommitFile[] | undefined): void {
    for (const file of files ?? []) {
      paths.add(file.filename);
      if (file.previous_filename) paths.add(file.previous_filename);
    }
  }

  async function tokenFor(orgId: string): Promise<string> {
    const sealed = await findRepresentativeGithubToken(options.db, orgId);
    if (sealed === null) {
      throw new InspectionSkipped('GitHub 미연결 — 대표가 GitHub 계정을 연결하지 않았다');
    }
    return decryptSecret(sealed);
  }

  // 기본 브랜치와 이 커밋의 비교(분기점 ... 커밋). 비교가 안 되면(기본 브랜치·커밋을 못 찾음) null — 호출부가 커밋 하나로 내려간다.
  // compare는 파일을 300개까지만 준다. 그만큼 오면 전체를 확인할 수 없다.
  async function compare(token: string, githubRepoId: number, baseBranch: string, commitSha: string): Promise<{ files: CommitFile[]; mergeBase: string | null } | null> {
    const base = baseBranch.split('/').map(encodeURIComponent).join('/');
    const res = await get(`${api}/repositories/${githubRepoId}/compare/${base}...${encodeURIComponent(commitSha)}`, token);
    if (res.status === 404 || res.status === 422) return null;
    const skipped = skipFor(res);
    if (skipped) throw skipped;
    if (!res.ok) throw new Error(`GitHub 응답 ${res.status}`);
    const body = (await res.json()) as { status?: string; files?: CommitFile[]; merge_base_commit?: { sha?: string } };
    // 커밋이 이미 기본 브랜치에 들어가 있으면(behind·identical) 비교가 비어 버린다 — 커밋 하나로 본다.
    if (body.status === 'behind' || body.status === 'identical') return null;
    if ((body.files?.length ?? 0) >= COMPARE_FILE_LIMIT) {
      throw new InspectionSkipped(`태스크 브랜치의 파일이 GitHub 비교 한도(${COMPARE_FILE_LIMIT}개)에 닿아 전체 diff를 확인할 수 없다`);
    }
    return { files: body.files ?? [], mergeBase: body.merge_base_commit?.sha ?? null };
  }

  return {
    kind: 'github',
    async changedPaths({ orgId, githubRepoId, commitSha, baseBranch }) {
      if (githubRepoId === null) {
        throw new InspectionSkipped('repos.github_repo_id 미설정 — GitHub에서 커밋을 찾을 수 없다');
      }
      const token = await tokenFor(orgId);

      const paths = new Set<string>();
      if (baseBranch !== null) {
        const compared = await compare(token, githubRepoId, baseBranch, commitSha);
        if (compared !== null) {
          addFiles(paths, compared.files);
          return [...paths];
        }
        // 비교가 안 됐다 — 아래 커밋 하나 조회가 "없는 커밋(FAIL)"과 "못 봄(SKIPPED)"을 가른다.
      }
      let url: string | null = `${api}/repositories/${githubRepoId}/commits/${encodeURIComponent(commitSha)}`;
      let pages = 0;

      while (url !== null) {
        if (pages === MAX_PAGES) {
          throw new InspectionSkipped(`커밋의 파일이 GitHub 한도(${MAX_PAGES * 300}개)를 넘어 전체 diff를 확인할 수 없다`);
        }
        const res = await get(url, token);
        pages += 1;

        if (res.status === 422) throw new CommitNotFoundError(commitSha); // "No commit found for SHA"
        if (res.status === 404) {
          // 404는 "커밋이 없다"와 "이 토큰으로는 레포가 안 보인다"가 섞여 있다. 레포를 한 번 더 봐서 가른다 —
          // 후자를 FAIL로 적으면 에이전트가 자기 잘못이 아닌 일로 재시도를 잃는다.
          const repo = await get(`${api}/repositories/${githubRepoId}`, token);
          if (repo.ok) throw new CommitNotFoundError(commitSha);
          throw skipFor(repo) ?? new InspectionSkipped(`GitHub 토큰으로 레포에 접근할 수 없다 (github_repo_id ${githubRepoId})`);
        }
        const skipped = skipFor(res);
        if (skipped) throw skipped;
        // 그 밖(5xx 등)은 일반 에러로 던진다. 호출부가 서버 쪽 사정으로 보고 SKIPPED로 적는다.
        if (!res.ok) throw new Error(`GitHub 응답 ${res.status}`);

        const body = (await res.json()) as { files?: CommitFile[] };
        addFiles(paths, body.files);
        url = parseNextLink(res.headers.get('link'));
      }

      return [...paths];
    },

    // 직전 시점은 분기점(compare의 merge_base_commit), 못 찾으면 부모(커밋 API). 내용은 contents API(raw)에서. 404면 그 시점에 파일이 없었다.
    async fileVersions({ orgId, githubRepoId, commitSha, baseBranch }, filePath) {
      if (githubRepoId === null) throw new InspectionSkipped('repos.github_repo_id 미설정');
      const token = await tokenFor(orgId);
      let parent: string | null = null;
      const compared = baseBranch === null ? null : await compare(token, githubRepoId, baseBranch, commitSha);
      if (compared?.mergeBase) {
        parent = compared.mergeBase;
      } else {
        const commit = await get(`${api}/repositories/${githubRepoId}/commits/${encodeURIComponent(commitSha)}`, token);
        if (!commit.ok) throw new Error(`GitHub 응답 ${commit.status}`);
        parent = ((await commit.json()) as { parents?: { sha: string }[] }).parents?.[0]?.sha ?? null;
      }
      const encoded = filePath.split('/').map(encodeURIComponent).join('/');
      const read = async (ref: string | null): Promise<string | null> => {
        if (ref === null) return null;
        const res = await fetchImpl(`${api}/repositories/${githubRepoId}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.raw+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'nomos-server',
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`GitHub 응답 ${res.status}`);
        const text = await res.text();
        if (text.length > MAX_MANIFEST_BYTES) throw new Error('manifest too large');
        return text;
      };
      return { before: await read(parent), after: await read(commitSha) };
    },
  };
}
