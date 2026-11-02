// 무인 실험(034)의 명의 — 실험 모드에서 서버가 사람 대신 한 일은 전부 이 명의와 payload auto: true로 남긴다(사람 지표에서 뺀다).
// DB 행의 사람 칸(approved_by·decided_by·requested_by)은 users FK라 조직 대표(실험을 켠 사람)를 적는다 — 명의의 정본은 events다.

export const EXPERIMENT_ACTOR = 'system:experiment';

export type Attribution = { onBehalfOf: string; auto: true };

export const EXPERIMENT_ATTRIBUTION: Attribution = { onBehalfOf: EXPERIMENT_ACTOR, auto: true };

// 이벤트 payload에 펼친다.
export function autoMark(attribution: Attribution | undefined): { auto?: true } {
  return attribution ? { auto: true } : {};
}
