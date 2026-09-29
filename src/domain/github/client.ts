import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../errors.js';

const GITHUB_API_BASE = 'https://api.github.com';

// GITHUB_TOKEN이 설정되어 있는지 여부. 호출부가 "확인 안 됨"과 "false"를 구분하는 데 쓴다.
export function hasGithubToken(): boolean {
  return Boolean(env.GITHUB_TOKEN);
}

export type GithubRepo = {
  fullName: string;
  githubRepoId: number;
  defaultBranch: string;
};

function githubHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// Link 헤더에서 rel="next" URL을 추출한다. 없으면 null (마지막 페이지).
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

// 대표가 접근 가능한 GitHub 레포 목록을 페이지네이션을 따라가며 전부 가져온다.
// 토큰이 없으면 500을 던지지 않고 빈 배열 + 경고 로그를 반환한다 (수동 등록 경로가 항상 열려 있어야 함).
export async function listUserRepos(): Promise<GithubRepo[]> {
  if (!env.GITHUB_TOKEN) {
    logger.warn('GITHUB_TOKEN not set; returning empty repo list');
    return [];
  }

  const repos: GithubRepo[] = [];
  let url: string | null = `${GITHUB_API_BASE}/user/repos?per_page=100&sort=updated`;

  while (url) {
    const res = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) {
      throw new AppError('GITHUB_UNAVAILABLE', `GitHub repo list request failed with status ${res.status}`);
    }
    const body = (await res.json()) as Array<{ full_name: string; id: number; default_branch: string }>;
    for (const r of body) {
      repos.push({ fullName: r.full_name, githubRepoId: r.id, defaultBranch: r.default_branch });
    }
    url = parseNextLink(res.headers.get('link'));
  }

  return repos;
}

// fullName(owner/repo) 레포에서 githubLogin 사용자가 collaborator인지 확인한다.
// GitHub는 collaborator면 204, 아니면 404를 반환한다. 토큰이 없거나 호출이 실패하면
// GITHUB_UNAVAILABLE을 던진다 — 호출부(members 조회)가 try/catch로 감싸고 필드를 생략해야 한다.
export async function checkCollaborator(fullName: string, githubLogin: string): Promise<boolean> {
  if (!env.GITHUB_TOKEN) {
    throw new AppError('GITHUB_UNAVAILABLE', 'GITHUB_TOKEN not set');
  }

  const res = await fetch(`${GITHUB_API_BASE}/repos/${fullName}/collaborators/${githubLogin}`, {
    headers: githubHeaders(),
  });

  if (res.status === 204) return true;
  if (res.status === 404) return false;
  throw new AppError('GITHUB_UNAVAILABLE', `GitHub collaborator check failed with status ${res.status}`);
}
