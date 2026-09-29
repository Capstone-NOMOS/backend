import type { Queryable } from '../../config/db.js';
import { decryptSecret } from '../../utils/secret-box.js';
import { parseNextLink } from '../github/client.js';
import { findRepresentativeGithubToken } from '../oauth/repository.js';
import { CommitNotFoundError, InspectionSkipped, type CommitInspector } from './inspection.js';

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

  return {
    kind: 'github',
    async changedPaths({ orgId, githubRepoId, commitSha }) {
      if (githubRepoId === null) {
        throw new InspectionSkipped('repos.github_repo_id 미설정 — GitHub에서 커밋을 찾을 수 없다');
      }
      const sealed = await findRepresentativeGithubToken(options.db, orgId);
      if (sealed === null) {
        throw new InspectionSkipped('GitHub 미연결 — 대표가 GitHub 계정을 연결하지 않았다');
      }
      const token = await decryptSecret(sealed);

      const paths = new Set<string>();
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
        for (const file of body.files ?? []) {
          paths.add(file.filename);
          // 이름 변경은 옛 경로도 건드린 것이다(그 경로에서는 삭제). mirror 구현(diff-tree --name-only)도
          // 이름 변경을 삭제+추가로 보고하므로 두 구현의 결론을 맞춘다.
          if (file.previous_filename) paths.add(file.previous_filename);
        }
        url = parseNextLink(res.headers.get('link'));
      }

      return [...paths];
    },
  };
}
