import type { PoolClient } from 'pg';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { appendEvent } from '../events/append.js';
import type { QuestionMode } from '../project/repository.js';
import type { TeamRole } from '../roles.js';
import { afterQuestionAsked } from './after-ask.js';
import { AppError } from '../../errors.js';
import { expirePendingQuestionsOf, insertQuestion, type AgentQuestion, type AskedQuestion, type PlanningSubject } from './repository.js';
import { routeQuestion, type RoutedResult } from './router-registry.js';
import { PM_TARGET, toRoutingSnapshot, type QuestionTarget, type RoutingInput, type RoutingStage } from './router.js';

// 기획 단계 질문(033) — PM이 기능 명세 초안을, BE 에이전트가 API 계약 초안을 쓰다가 혼자 정하면 안 되는 것을 질문으로 낸다.
// 통합 테스트에서 둘 다 정할 권한이 없는 것을 임의로 정했다. 구현 단계와 같은 라우터로 FE·BE·PM에게 보내고, 답이 다 오면 초안을 다시 쓴다.
//
// - 질문 하나 = agent_questions 한 행(질문마다 답할 사람이 다를 수 있어 따로 라우팅한다).
// - 라우팅은 트랜잭션 밖에서 하고(LLM이면 수 초) 결과를 들고 초안 저장 트랜잭션 안에서 INSERT한다 — 구현 단계 askQuestion과 같은 순서.
// - 형식 판정은 코드가 한다(P2): 문장이 비어 있지 않고, 선택지가 2개 이상이고(추천안이 맨 앞), 같은 질문이 두 번 없다.
// - 상한(일반 모드): 초안 하나당 PLANNING_QUESTIONS_MAX개, 답에 따른 재작성 PLANNING_QUESTION_ROUNDS회. 넘는 질문은 가정으로 옮긴다
//   (첫 선택지 = 추천안을 가정으로 적는다). 실험 모드는 질문 수 무제한, 회차는 EXPERIMENT_QUESTION_ROUNDS까지.
// - 실험 모드에서 같은 흐름(기능 명세 체인·같은 계약)에 이미 답이 정해진 질문과 같은 문장이 다시 나오면 라우팅하지 않는다(splitRepeated).

export const planningQuestionSchema = z.object({
  // 기능 명세 초안에서 어느 기능에 대한 질문인지(그 기능 명세가 라우터의 맥락이 된다). 계약 초안은 계약의 기능이라 쓰지 않는다.
  featureKey: z.string().trim().min(1).max(32).optional(),
  question: z.string().trim().min(1).max(500),
  header: z.string().trim().max(60).optional(),
  options: z.array(z.object({ label: z.string().trim().min(1).max(200), description: z.string().trim().max(500).optional() })).min(2).max(6),
  multiSelect: z.boolean().optional(),
});
export type PlanningQuestion = z.infer<typeof planningQuestionSchema>;

// 구조화 출력(JSON 스키마)용 — PM 초안·계약 초안 형식에 들어간다.
export const PLANNING_QUESTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'options'],
  properties: {
    featureKey: { type: 'string' },
    question: { type: 'string' },
    header: { type: 'string' },
    options: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['label'], properties: { label: { type: 'string' }, description: { type: 'string' } } },
    },
    multiSelect: { type: 'boolean' },
  },
};

// 지침 문장 — PM·Executor 프롬프트가 같은 말을 쓴다.
export function planningQuestionGuide(mode: QuestionMode): string {
  const cap =
    mode === 'experiment'
      ? '질문 수에 제한은 없다 — 확신하지 못하는 것은 전부 질문으로 낸다.'
      : `질문은 ${env.PLANNING_QUESTIONS_MAX}개까지만 — 그보다 많으면 덜 중요한 것은 가정으로 적는다.`;
  return [
    '대표·FE·BE가 정할 것을 혼자 정하지 말고 질문으로 내라. 확신할 수 있는 것만 쓰고, 추측한 것은 가정이 아니라 질문으로 낸다.',
    '질문마다 선택지를 2개 이상 주고 **추천안을 맨 앞에** 둔다(답이 없으면 맨 앞 선택지를 가정으로 본다). 같은 질문을 두 번 내지 않는다.',
    cap,
  ].join('\n');
}

// zod를 지난 뒤의 규칙 — 같은 질문 문장(답의 키가 겹친다).
export function planningQuestionProblems(questions: PlanningQuestion[], where = 'questions'): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  questions.forEach((q, i) => {
    if (seen.has(q.question)) problems.push(`${where}[${i}] 같은 질문이 두 번 있다`);
    seen.add(q.question);
    const labels = new Set(q.options.map((o) => o.label));
    if (labels.size !== q.options.length) problems.push(`${where}[${i}] 같은 선택지가 두 번 있다`);
  });
  return problems;
}

// 상한 적용 — kept는 라우팅하고, overflow는 가정으로 옮긴다.
export function limitPlanningQuestions(
  questions: PlanningQuestion[],
  input: { mode: QuestionMode; roundsUsed: number },
): { kept: PlanningQuestion[]; overflow: PlanningQuestion[] } {
  // 실험 모드: 한 초안의 질문 수는 무제한, 답에 따른 재작성만 EXPERIMENT_QUESTION_ROUNDS회까지(무인 실험이 끝나지 않는 재작성에 갇히지 않게).
  if (input.mode === 'experiment') {
    return input.roundsUsed >= env.EXPERIMENT_QUESTION_ROUNDS ? { kept: [], overflow: questions } : { kept: questions, overflow: [] };
  }
  if (input.roundsUsed >= env.PLANNING_QUESTION_ROUNDS) return { kept: [], overflow: questions };
  return { kept: questions.slice(0, env.PLANNING_QUESTIONS_MAX), overflow: questions.slice(env.PLANNING_QUESTIONS_MAX) };
}

// 실험 모드 — 같은 흐름에서 이미 답이 정해진 질문과 같은 문장(공백 정리 후 완전 일치)은 새 질문으로 세지 않는다.
// 라우팅·INSERT하지 않고 이미 받은 답을 가정 문장으로 남긴다(다음 재작성 입력에는 흐름 전체의 답이 들어간다).
// 재작성이 같은 질문을 되풀이하면 회차만 소모하고 끝나지 않았다 — 기본 모드는 사람이 보고 있어 거르지 않는다.
export function normalizeQuestionText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function splitRepeated(
  questions: PlanningQuestion[],
  answered: Map<string, string>,
): { fresh: PlanningQuestion[]; repeated: { question: PlanningQuestion; answer: string }[] } {
  const fresh: PlanningQuestion[] = [];
  const repeated: { question: PlanningQuestion; answer: string }[] = [];
  for (const q of questions) {
    const answer = answered.get(normalizeQuestionText(q.question));
    if (answer === undefined) fresh.push(q);
    else repeated.push({ question: q, answer });
  }
  return { fresh, repeated };
}

// 질문 행들에서 정해진 답(문장 → 답). 실험 모드의 되풀이 거르기와 재작성 입력이 같은 것을 본다.
export function answeredTexts(questions: AgentQuestion[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const q of questions) {
    for (const item of q.questions) {
      const answer = q.answers?.[item.question];
      if (answer !== undefined) map.set(normalizeQuestionText(item.question), answer);
    }
  }
  return map;
}

export function repeatedAssumption(item: { question: PlanningQuestion; answer: string }): string {
  return `가정(이미 답함): ${item.question.question} → ${item.answer}`;
}

// 가정으로 옮긴 질문의 문장 — 추천안(첫 선택지)을 가정한다.
export function assumptionOf(q: PlanningQuestion): string {
  return `가정: ${q.question} → ${q.options[0]?.label ?? '(선택지 없음)'}`;
}

export function toAskedQuestion(q: PlanningQuestion): AskedQuestion {
  return {
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    options: q.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    ...(q.multiSelect !== undefined ? { multiSelect: q.multiSelect } : {}),
  };
}

export type RoutedPlanningQuestion = { question: AskedQuestion; input: RoutingInput; routed: RoutedResult };

// 트랜잭션 밖에서 라우팅한다. 질문끼리 독립이라 함께 부른다.
// 차례로 라우팅한다. 한꺼번에 보내면 중계 모드에서 pm-worker 하나가 한 건씩 처리하는 동안 뒤의 질문이 라우터 시간 제한(30초)에 걸려
// 대표에게 보내는 대체 경로(fallback:representative)로 빠졌다(로컬 시범: 5개 중 3개) — 라우터가 판정하지 않은 행이 정확도 데이터에 섞인다.
export async function routePlanningQuestions(items: { question: AskedQuestion; input: RoutingInput }[]): Promise<RoutedPlanningQuestion[]> {
  const routed: RoutedPlanningQuestion[] = [];
  for (const item of items) routed.push({ ...item, routed: await routeQuestion(item.input) });
  return routed;
}

export type PlanningQuestionContext = {
  orgId: string;
  projectId: string;
  policyHash: string;
  stage: Exclude<RoutingStage, 'implementation'>;
  planId: string | null;
  contractId: string | null;
  askerRole: TeamRole | 'PM';
  askedByAgentId: string | null;
  onBehalfOf: string;
};

// 초안 저장 트랜잭션 안에서 부른다. PM이 묻는 쪽이면 SELF가 없다 — PM 소관은 대상 PM(대표가 확정, router.ts와 같은 규칙).
export async function insertPlanningQuestionsInTx(tx: PoolClient, ctx: PlanningQuestionContext, routed: RoutedPlanningQuestion[]): Promise<AgentQuestion[]> {
  const created: AgentQuestion[] = [];
  for (const item of routed) {
    const selfOwned = item.routed.target === 'SELF' && ctx.askerRole !== 'PM';
    const targetRole: QuestionTarget = item.routed.target === 'SELF' ? (ctx.askerRole === 'PM' ? PM_TARGET : ctx.askerRole) : item.routed.target;
    const question = await insertQuestion(tx, {
      projectId: ctx.projectId,
      stage: ctx.stage,
      taskId: null,
      planId: ctx.planId,
      contractId: ctx.contractId,
      askedByAgentId: ctx.askedByAgentId,
      askerRole: ctx.askerRole,
      targetRole,
      routedBy: item.routed.routedBy,
      routing: {
        confidence: item.routed.confidence,
        reason: item.routed.reason,
        latencyMs: item.routed.latencyMs,
        fallback: item.routed.fallback,
        costUsd: item.routed.costUsd ?? null,
      },
      status: selfOwned ? 'self_owned' : 'pending',
      questions: [item.question],
      timeoutMs: env.QUESTION_TIMEOUT_MS,
      routingInput: toRoutingSnapshot(item.input),
    });
    await appendEvent(tx, {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      type: 'QUESTION_ASKED',
      ...(ctx.askedByAgentId ? { actorAgentId: ctx.askedByAgentId } : {}),
      onBehalfOf: ctx.onBehalfOf,
      policyHash: ctx.policyHash,
      payload: {
        questionId: question.id,
        taskId: null,
        stage: ctx.stage,
        planId: ctx.planId,
        contractId: ctx.contractId,
        askerRole: ctx.askerRole,
        targetRole: selfOwned ? 'SELF' : targetRole,
        routedBy: item.routed.routedBy,
        confidence: item.routed.confidence,
        latencyMs: item.routed.latencyMs,
        fallback: item.routed.fallback,
        costUsd: item.routed.costUsd ?? null,
        questionCount: 1,
      },
    });
    created.push(question);
  }
  return created;
}

// 커밋 뒤 — 구현 단계 질문과 같은 뒤처리(라우팅 기록·상담 깨우기·PM 초안·실험 모드 자동 답).
export function planningQuestionsCommitted(
  created: AgentQuestion[],
  routed: RoutedPlanningQuestion[],
  project: { orgId: string; questionMode: QuestionMode },
): void {
  created.forEach((q, i) => afterQuestionAsked(q, routed[i]!.input, routed[i]!.routed, project));
}

// 답을 붙여 다시 쓸 때의 본문 — PM 재작성·계약 수정 회차가 같은 문장을 쓴다.
export function answersBlock(questions: AgentQuestion[]): string {
  const lines: string[] = [];
  for (const q of questions) {
    for (const item of q.questions) {
      const answer = q.answers?.[item.question];
      if (answer === undefined) continue;
      lines.push(`- ${item.question} → ${answer}`);
    }
  }
  return lines.join('\n');
}

// ── 기획 단계 초안의 확정(적용·계약 확정) ─────────────────────────────────

export function questionsPendingError(pending: AgentQuestion[]): AppError {
  return new AppError(
    'QUESTIONS_PENDING',
    `${pending.length} question(s) are still waiting for an answer; wait for the answers (the draft is rewritten with them) or confirm with acceptAssumptions`,
    pending.map((q) => ({ questionId: q.id, question: q.questions[0]?.question ?? '', targetRole: q.targetRole })),
  );
}

// "가정으로 확정" — 남은 대기 질문을 만료로 닫는다(이벤트에 사유). 기능 명세 적용(pm/service.ts)과 계약 확정(contract/service.ts)이 같은 함수를 쓴다.
export async function closeQuestionsAsAssumed(
  tx: PoolClient,
  ctx: { orgId: string; projectId: string; policyHash: string; onBehalfOf: string; auto?: true },
  pending: AgentQuestion[],
  subject: PlanningSubject,
): Promise<string[]> {
  const closed = new Set(await expirePendingQuestionsOf(tx, subject));
  for (const q of pending.filter((p) => closed.has(p.id))) {
    await appendEvent(tx, {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      type: 'QUESTION_EXPIRED',
      onBehalfOf: ctx.onBehalfOf,
      policyHash: ctx.policyHash,
      payload: {
        ...(ctx.auto ? { auto: true as const } : {}),
        questionId: q.id,
        taskId: null,
        stage: q.stage,
        planId: q.planId,
        contractId: q.contractId,
        targetRole: q.targetRole,
        escalated: false,
        reason: 'confirmed_with_assumptions',
      },
    });
  }
  return [...closed];
}

