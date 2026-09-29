import type { Queryable } from '../../config/db.js';
import { loadPolicySnapshot, policyHashOf, type PolicySnapshot } from './policy-hash.js';

// policy_hash를 캐시 키로 쓴다. 정책이 바뀌면 해시가 바뀌므로 키가 통째로 달라진다 —
// 무효화 로직을 따로 짤 필요가 없고, 옛 키로 옛 스냅샷이 살아나는 사고도 구조적으로 막힌다.
const cache = new Map<string, PolicySnapshot>();
const MAX_ENTRIES = 64;

export async function getPolicySnapshot(
  db: Queryable,
  projectId: string,
  policyHash: string,
): Promise<PolicySnapshot> {
  const key = `${projectId}:${policyHash}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const snapshot = await loadPolicySnapshot(db, projectId);
  // 읽어온 내용이 정말 그 해시인지 확인한다. 다르면 누군가 policy_hash 갱신을 빠뜨린 것이므로
  // 캐시에 넣지 않는다 — 틀린 스냅샷을 해시 키로 굳히면 이후 모든 판정이 조용히 어긋난다.
  if (policyHashOf(snapshot) !== policyHash) return snapshot;

  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, snapshot);
  return snapshot;
}

export function clearPolicyCache(): void {
  cache.clear();
}
