import type { Queryable } from '../../config/db.js';

// 토큰은 암호화된 문자열로만 들어온다. 평문이 이 레이어를 넘어오지 않게 컬럼 이름도 _enc다.
export async function insertOauthSession(
  db: Queryable,
  input: { userId: string; githubTokenEnc: string; scope: string; expiresAt: Date | null },
): Promise<void> {
  await db.query(
    `INSERT INTO oauth_sessions (user_id, github_token_enc, scope, expires_at) VALUES ($1, $2, $3, $4)`,
    [input.userId, input.githubTokenEnc, input.scope, input.expiresAt],
  );
}

export async function findLatestOauthSession(
  db: Queryable,
  userId: string,
): Promise<{ githubTokenEnc: string; scope: string | null } | null> {
  const { rows } = await db.query(
    `SELECT github_token_enc, scope FROM oauth_sessions
      WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  return row ? { githubTokenEnc: row.github_token_enc, scope: row.scope } : null;
}

// 조직 대표의 가장 최근 GitHub 토큰(암호문). V3가 GitHub에서 커밋을 읽을 때 쓴다.
// 대표 것만 보는 이유: 레포를 조직에 연결한 책임자이고, 팀원 토큰을 쓰면 그 팀원이 레포 접근을
// 잃는 순간 조직 전체의 검증이 조용히 멈춘다. 대표는 조직당 한 명이다(uq_representative).
export async function findRepresentativeGithubToken(db: Queryable, orgId: string): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT s.github_token_enc FROM oauth_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE u.org_id = $1 AND u.org_role = 'REPRESENTATIVE'
        AND (s.expires_at IS NULL OR s.expires_at > now())
      ORDER BY s.created_at DESC LIMIT 1`,
    [orgId],
  );
  return rows[0] ? (rows[0].github_token_enc as string) : null;
}

// 로컬 계정에 GitHub 신원을 붙인다. 조직 안에서 같은 GitHub 계정이 둘일 수 없다
// (uq_users_org_github 부분 유니크 인덱스).
export async function linkGithubAccount(
  db: Queryable,
  userId: string,
  githubId: number,
  githubLogin: string,
): Promise<void> {
  await db.query(`UPDATE users SET github_id = $2, github_login = $3 WHERE id = $1`, [
    userId,
    githubId,
    githubLogin,
  ]);
}
