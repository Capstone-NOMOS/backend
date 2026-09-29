// pg가 던지는 제약 위반을 도메인 에러로 바꾸기 위한 공용 판별기.
// org/repository.ts와 repo/repository.ts에 같은 목적의 비공개 헬퍼가 이미 있다 —
// 그쪽은 건드리지 않고 신규 코드만 이걸 쓴다.
export function violatedConstraint(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: unknown; constraint?: unknown };
  if (e.code !== '23505') return undefined;
  return typeof e.constraint === 'string' ? e.constraint : undefined;
}
