// GitHub API 공통 도구. 실제 호출은 조직 대표의 토큰으로 rep-api.ts가 한다 — 서버 공용 토큰(PAT)은 두지 않는다.

// Link 헤더에서 rel="next" URL을 추출한다. 없으면 null (마지막 페이지).
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return null;
}
