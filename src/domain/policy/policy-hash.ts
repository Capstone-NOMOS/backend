import type { Queryable } from '../../config/db.js';
import { hashObject } from '../../utils/canonical-json.js';
import type { RepoPath } from '../repo/types.js';
import {
  findConstitutionHash,
  listProjectIdsByRepo,
  listProjectPolicies,
  listProjectRepoPaths,
  updateProjectPolicyHash,
  type PolicyRow,
} from './repository.js';

// 판정에 실제로 쓰이는 값만 담는다. id·created_at은 뺀다 — 같은 규칙을 지웠다 다시 만들어도
// 판정이 같다면 해시도 같아야 하고, 반대로 규칙 내용이 바뀌면 반드시 달라져야 한다.
export type PolicySnapshot = {
  repoPaths: RepoPath[];
  policies: PolicyRow[];
  constitutionHash: string | null;
};

export function policyHashOf(snapshot: PolicySnapshot): string {
  return hashObject({
    repoPaths: snapshot.repoPaths.map((p) => ({
      repoId: p.repoId,
      pathPattern: p.pathPattern,
      ownerRole: p.ownerRole,
      access: p.access,
      actionKey: p.actionKey,
      priority: p.priority,
    })),
    policies: snapshot.policies.map((p) => ({ actionKey: p.actionKey, mode: p.mode, lockKey: p.lockKey })),
    constitutionHash: snapshot.constitutionHash,
  });
}

export async function loadPolicySnapshot(db: Queryable, projectId: string): Promise<PolicySnapshot> {
  // 순차 실행이어야 한다. db가 트랜잭션 클라이언트일 때 Promise.all로 동시에 던지면
  // 같은 커넥션에서 쿼리가 겹친다 (pg는 다중화를 지원하지 않는다).
  const repoPaths = await listProjectRepoPaths(db, projectId);
  const policies = await listProjectPolicies(db, projectId);
  const constitutionHash = await findConstitutionHash(db, projectId);
  return { repoPaths, policies, constitutionHash };
}

export async function computePolicyHash(db: Queryable, projectId: string): Promise<string> {
  return policyHashOf(await loadPolicySnapshot(db, projectId));
}

// 경로 규칙·정책·헌법이 바뀌면 반드시 호출한다. 이걸 빠뜨리면 옛 토큰이 계속 통과하고,
// policy_hash 대조라는 방어선 자체가 무의미해진다.
export async function recomputeProjectPolicyHash(db: Queryable, projectId: string): Promise<string> {
  const hash = await computePolicyHash(db, projectId);
  await updateProjectPolicyHash(db, projectId, hash);
  return hash;
}

// 레포 경로 규칙이 바뀐 뒤 그 레포를 쓰는 모든 프로젝트의 해시를 갱신한다.
export async function recomputePolicyHashesForRepo(db: Queryable, repoId: string): Promise<string[]> {
  const projectIds = await listProjectIdsByRepo(db, repoId);
  for (const projectId of projectIds) {
    await recomputeProjectPolicyHash(db, projectId);
  }
  return projectIds;
}
