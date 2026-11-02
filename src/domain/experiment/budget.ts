import { env } from '../../config/env.js';
import { maxCallCost } from '../pm/pricing.js';

// 실험 모드를 켤 때(034) PM 예산이 너무 작으면 경고만 한다(막지 않는다 — 예산은 대표가 정한다).
// 무인 실험에서 예산 소진은 사람 없이 풀리지 않는 멈춤이다(감독 스크립트가 멈추고 알린다) — 켜는 순간에 미리 보이게 한다.
// 어림: 요구사항 하나 = 기능 명세 초안 1 + 답에 따른 재작성 최대 EXPERIMENT_QUESTION_ROUNDS + 태스크 나누기 1, 호출마다 교정 1회까지, 최대 비용 기준.
const PROMPT_TOKENS_ESTIMATE = 8_000;

export function experimentRequirementMaxUsd(): number {
  const calls = (1 + env.EXPERIMENT_QUESTION_ROUNDS + 1) * 2;
  return calls * maxCallCost(env.PM_MODEL, PROMPT_TOKENS_ESTIMATE, env.PM_MAX_TOKENS);
}

export function experimentBudgetWarnings(pmBudgetUsd: number): string[] {
  const perRequirement = experimentRequirementMaxUsd();
  if (pmBudgetUsd >= perRequirement) return [];
  return [
    `PM 예산 $${pmBudgetUsd}가 실험 요구사항 하나의 최대 어림 $${perRequirement.toFixed(2)}보다 작다` +
      `(기능 명세 1 + 재작성 최대 ${env.EXPERIMENT_QUESTION_ROUNDS} + 태스크 나누기 1, 교정 포함). 예산이 다 떨어지면 무인 실험이 멈춘다 — 예산을 늘리는 것을 권한다`,
  ];
}
