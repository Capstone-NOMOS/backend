import { randomUUID } from 'node:crypto';
import { pool } from '../src/config/db.js';
import { insertUser } from '../src/domain/org/repository.js';
import { createOrganization } from '../src/domain/org/service.js';
import { getRepoPaths, updatePathOwnership } from '../src/domain/repo/service.js';

// scrypt를 거치지 않는 빠른 사용자. 인증 자체를 검증하는 테스트는 signup()을 쓴다.
export async function createTestUser(loginId: string): Promise<string> {
  const id = randomUUID();
  await insertUser(pool, { id, loginId, nickname: loginId });
  return id;
}

// connectAgent를 거치지 않고 agents 행만 만든다 (토큰·연결 키가 필요 없는 테스트용).
export async function createTestAgent(userId: string, name = 'laptop'): Promise<string> {
  const { rows } = await pool.query(
    // org_id는 사용자 것을 따른다 — 불변식: agents.org_id = users.org_id
    `INSERT INTO agents (user_id, org_id, name, harness)
     SELECT id, org_id, $2, 'claude-code@test' FROM users WHERE id = $1 RETURNING id`,
    [userId, name],
  );
  return rows[0]!.id as string;
}

// 프로젝트 생성 서비스는 Phase 2에 있으므로, 스키마 테스트용으로 행만 직접 만든다.
// policy_hash는 계산하지 않되 프로젝트마다 다른 값을 넣는다 — 같은 값을 쓰면
// policy_hash를 키로 쓰는 스냅샷 캐시에서 서로 다른 프로젝트가 같은 칸을 물린다.
// started: 시작(G1)한 프로젝트로 만든다 — 시작 전에는 태스크를 가져갈 수 없다(PROJECT_NOT_STARTED).
// 수령·제출을 다루는 테스트용이다. 시작 자체(검사·이벤트)는 startProject로 따로 검증한다(tests/project-start.test.ts).
export async function createTestProject(input: {
  orgId: string;
  userId: string;
  name?: string;
  started?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO projects (id, org_id, name, autonomy_preset, policy_hash, pm_budget_usd, created_by, status, started_at)
     VALUES ($1, $2, $3, 'L2', $4, 40, $5, $6, $7)`,
    [
      id,
      input.orgId,
      input.name ?? '스터디 관리 웹앱 v1',
      `test-policy-${id}`,
      input.userId,
      input.started ? 'active' : 'planning',
      input.started ? new Date() : null,
    ],
  );
  return id;
}

// 온보딩의 핵심 단계 — '**' 행의 소유 역할 지정. 소유 역할은 상속되므로(tests/**·migrations/** 등 owner가
// NULL인 행은 '**'를 따른다) 이걸 안 하면 기본 거부(B-2)로 그 레포에는 아무도 쓸 수 없다.
// 서비스 함수를 거친다 — policy_hash 재계산이 함께 돈다.
export async function assignRootOwner(
  orgId: string,
  userId: string,
  repoId: string,
  role: 'BACKEND' | 'FRONTEND',
): Promise<void> {
  const root = (await getRepoPaths(orgId, repoId)).find((p) => p.pathPattern === '**');
  if (!root) throw new Error(`repo ${repoId} has no '**' rule`);
  await updatePathOwnership(orgId, userId, repoId, root.id, { ownerRole: role });
}

export async function createTestOrg(
  loginId: string,
  name = 'Acme Inc.',
): Promise<{ userId: string; orgId: string }> {
  const userId = await createTestUser(loginId);
  const { orgId } = await createOrganization(userId, name);
  return { userId, orgId };
}
