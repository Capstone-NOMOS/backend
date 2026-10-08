import type { Queryable } from '../../config/db.js';
import { decryptSecret } from '../../utils/secret-box.js';
import { findRepresentativeGithubToken } from '../oauth/repository.js';

// 그 조직 대표의 GitHub 토큰(평문). 대표가 GitHub를 연결하지 않았으면 null — 호출부가 "확인 안 됨"으로 다룬다.
// 평문은 GitHub 호출에만 쓰고 로그·이벤트·오류 메시지에 넣지 않는다.
export async function representativeGithubToken(db: Queryable, orgId: string): Promise<string | null> {
  const sealed = await findRepresentativeGithubToken(db, orgId);
  return sealed === null ? null : decryptSecret(sealed);
}

// GitHub의 owner/repo 형식. 경로에 그대로 들어가므로 이 형식이 아니면 GitHub를 부르지 않는다.
export function isGithubFullName(fullName: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(fullName) && !fullName.endsWith('/.') && !fullName.endsWith('/..');
}
