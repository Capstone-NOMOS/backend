import { z } from 'zod';
import { hashObject } from '../../utils/canonical-json.js';
import type { AuthoringInput } from '../authoring/apply.js';
import { AUTHORING_LIMITS, TASK_KINDS } from '../authoring/schema.js';
import { TEAM_ROLES } from '../roles.js';

// PM이 내는 계획 초안의 형식.
//
// 모델에는 JSON 스키마로 형식만 강제한다(structured outputs). 스키마를 복잡하게 만들면 문법 컴파일 제한에 걸리므로
// 세부 규칙(레포가 이 프로젝트 것인가, 선행이 순환하는가, IMPLEMENT에 명세가 있는가 …)은 전부 코드 검증에 맡긴다 —
// 명세·태스크 생성과 같은 한 벌(domain/authoring)을 dry-run으로 돌린다. 판정자는 LLM이 아니다(P2).

export const PLAN_MODES = ['SEQUENTIAL', 'CONTRACT_PARALLEL', 'HYBRID'] as const;

// 모델에 넘기는 JSON 스키마. 모든 객체는 additionalProperties: false + 전 필드 required(structured outputs 요건).
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
export const PLAN_DRAFT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'rationale', 'estimate', 'specs', 'tasks', 'integrationChecks'],
  properties: {
    mode: { type: 'string', enum: [...PLAN_MODES] },
    rationale: { type: 'string' },
    estimate: {
      type: 'object',
      additionalProperties: false,
      required: ['workingDays', 'notes'],
      properties: { workingDays: { type: 'number' }, notes: { type: 'string' } },
    },
    specs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['featureKey', 'title', 'content'],
        properties: {
          featureKey: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'title', 'repo', 'teamRole', 'kind', 'spec', 'dependsOn'],
        properties: {
          ref: { type: 'string' },
          title: { type: 'string' },
          repo: { type: 'string' },
          teamRole: nullable({ type: 'string', enum: [...TEAM_ROLES] }),
          kind: { type: 'string', enum: [...TASK_KINDS] },
          spec: nullable({ type: 'string' }),
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    // 통합 확인 항목 — 모든 태스크가 끝난 뒤 대표가 G3(통합 확인·완료 승인)에서 하나씩 확인한다. 에이전트에게 통합 태스크를 맡기지 않는다.
    integrationChecks: { type: 'array', items: { type: 'string' } },
  },
};

// 받은 JSON을 한 번 더 확인한다. structured outputs가 형식을 지켜도, 길이 상한은 스키마에 싣지 않았다.
export const planDraftSchema = z.object({
  mode: z.enum(PLAN_MODES),
  rationale: z.string().max(4000),
  estimate: z.object({ workingDays: z.number().nonnegative(), notes: z.string().max(2000) }),
  specs: z
    .array(
      z.object({
        featureKey: z.string().trim().min(1).max(32),
        title: z.string().trim().min(1).max(200),
        content: z.string().trim().min(1).max(20_000),
      }),
    )
    .max(AUTHORING_LIMITS.specs),
  tasks: z
    .array(
      z.object({
        ref: z.string().trim().min(1).max(64),
        title: z.string().trim().min(1).max(200),
        repo: z.string().trim().min(1),
        teamRole: z.enum(TEAM_ROLES).nullable(),
        kind: z.enum(TASK_KINDS),
        spec: z.string().trim().min(1).nullable(),
        dependsOn: z.array(z.string().trim().min(1)).max(50),
      }),
    )
    .min(1)
    .max(AUTHORING_LIMITS.tasks),
  // 옛 초안(이 필드 이전에 저장된 것)에는 없다 — 없으면 빈 목록.
  integrationChecks: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
});

// PM은 INTEGRATION 태스크를 만들지 않는다(운영 테스트 4-3: 통합 태스크는 선행 코드·상대 레포·실행 수단이 없어 늘 멈췄다).
// 통합 확인은 integrationChecks로 적고, 대표가 G3에서 확인한다. 형식(zod)이 아니라 위반으로 돌려줘 교정 1회에 싣는다.
export function pmOnlyProblems(draft: PlanDraft): string[] {
  return draft.tasks
    .filter((t) => t.kind === 'INTEGRATION')
    .map((t) => `tasks[${t.ref}] INTEGRATION 태스크를 만들지 않는다 — 통합 확인은 integrationChecks에 확인 항목으로 적는다(대표가 모든 태스크가 끝난 뒤 확인한다)`);
}

export type PlanDraft = z.infer<typeof planDraftSchema>;

// 초안 → 명세·태스크 생성 입력. 적용은 저장된 초안을 **그대로** 넣는다(다시 생성하거나 서버가 고치지 않는다).
// PM은 시험지(spec_tests)를 쓰지 않는다 — 시험을 돌릴 하네스(서버 기동·시험 데이터·인증)가 정해지기 전에는 추측으로 채운 코드가 되고,
// 그 코드가 팀원 노트북에서 실행된다. 시험지가 없으면 V2는 SKIPPED로 남는다(통과로 세지 않는다).
export function draftToAuthoring(
  draft: PlanDraft,
  ctx: { projectId: string; actorUserId: string; planId: string },
): AuthoringInput {
  return {
    projectId: ctx.projectId,
    actorUserId: ctx.actorUserId,
    source: 'pm',
    planId: ctx.planId,
    specs: draft.specs.map((s) => ({
      featureKey: s.featureKey,
      title: s.title,
      content: s.content,
      tests: [],
    })),
    tasks: draft.tasks.map((t) => ({
      ref: t.ref,
      title: t.title,
      teamRole: t.teamRole,
      kind: t.kind,
      repo: { fullName: t.repo },
      spec: t.spec === null ? null : { featureKey: t.spec },
      dependsOn: t.dependsOn.map((ref) => ({ ref })),
    })),
  };
}

// M6a(같은 지시 → 계획이 얼마나 같은가)용 구조. 근거 문장·제목 표현·임시 키(ref) 이름은 뺀다 — 넣으면 항상 0%가 된다.
// 태스크는 (레포, 역할, 종류, 명세 키)로, 선행 관계는 그 튜플의 쌍으로 나타내고 정렬한다.
export function planStructure(draft: PlanDraft): {
  mode: string;
  specKeys: string[];
  tasks: string[];
  edges: string[];
} {
  const key = (t: PlanDraft['tasks'][number]) => [t.repo, t.teamRole ?? '-', t.kind, t.spec ?? '-'].join('|');
  const byRef = new Map(draft.tasks.map((t) => [t.ref, key(t)]));
  return {
    mode: draft.mode,
    specKeys: draft.specs.map((s) => s.featureKey).sort(),
    tasks: draft.tasks.map(key).sort(),
    edges: draft.tasks
      .flatMap((t) => t.dependsOn.map((d) => `${byRef.get(d) ?? `?${d}`} -> ${key(t)}`))
      .sort(),
  };
}

export function dagHashOf(structure: ReturnType<typeof planStructure>): string {
  return hashObject(structure);
}
