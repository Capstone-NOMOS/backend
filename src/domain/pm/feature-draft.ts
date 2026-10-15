import { z } from 'zod';
import { hashObject } from '../../utils/canonical-json.js';
import type { AuthoringInput } from '../authoring/apply.js';
import { AUTHORING_LIMITS } from '../authoring/schema.js';

// PM이 내는 **기능 명세** 초안의 형식(022, 새 계획 흐름 1단계).
//
// 대표는 개발 지식이 없어 API 계약이 맞는지 판단할 수 없다 — 그래서 PM은 화면·동작·수용 기준을 개발 용어 없이 쓰고,
// 기능마다 "API가 필요한가, 필요하면 어떤 데이터가 오가야 하는가"만 사람 말로 적는다. 계약(경로·필드·상태 코드)은
// BE 에이전트가 BE 코드를 읽고 쓰고 BE 개발자가 확정한다(2단계). 태스크는 대표가 누르면 PM이 나눈다(3단계).
//
// 형식은 JSON 스키마로 강제하고, 세부 규칙(같은 키, needsApi ↔ apiNeeds, 이미 있는 명세)은 코드가 본다(P2).

export const FEATURE_DRAFT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'assumptions', 'features'],
  properties: {
    summary: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    features: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['featureKey', 'title', 'description', 'acceptance', 'needsApi', 'apiNeeds'],
        properties: {
          featureKey: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' } },
          needsApi: { type: 'boolean' },
          apiNeeds: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
    },
  },
};

export const featureDraftSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(20),
  features: z
    .array(
      z.object({
        featureKey: z.string().trim().min(1).max(32),
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().min(1).max(5000),
        acceptance: z.array(z.string().trim().min(1).max(500)).min(1).max(30),
        needsApi: z.boolean(),
        apiNeeds: z.string().trim().min(1).max(2000).nullable(),
      }),
    )
    .min(1)
    .max(AUTHORING_LIMITS.specs),
});

export type FeatureDraft = z.infer<typeof featureDraftSchema>;

// 명세 본문 — 사람이 읽는 기능 설명 + 수용 기준. 계약은 넣지 않는다(2단계에서 contracts로 붙는다).
export function featureContent(f: FeatureDraft['features'][number]): string {
  return [
    f.description,
    '',
    '## 수용 기준',
    ...f.acceptance.map((a) => `- ${a}`),
  ].join('\n');
}

// 초안 → 명세 작성 입력(태스크 없음). 확정은 저장된 초안을 그대로 넣는다.
export function featureDraftToAuthoring(
  draft: FeatureDraft,
  ctx: { projectId: string; actorUserId: string; planId: string },
): AuthoringInput {
  return {
    projectId: ctx.projectId,
    actorUserId: ctx.actorUserId,
    source: 'pm',
    planId: ctx.planId,
    specs: draft.features.map((f) => ({
      featureKey: f.featureKey,
      title: f.title,
      content: featureContent(f),
      tests: [],
      needsApi: f.needsApi,
      apiNeeds: f.needsApi ? f.apiNeeds : null,
    })),
    tasks: [],
  };
}

// 형식(zod)으로 표현하지 않은 PM 쪽 규칙 — 위반 목록으로 돌려 교정 1회에 싣는다.
export function featureOnlyProblems(draft: FeatureDraft): string[] {
  const problems: string[] = [];
  for (const f of draft.features) {
    if (f.needsApi && !f.apiNeeds) problems.push(`features[${f.featureKey}] API가 필요하면 apiNeeds에 어떤 데이터가 오가야 하는지 사람 말로 적는다`);
    if (!f.needsApi && f.apiNeeds) problems.push(`features[${f.featureKey}] API가 필요 없으면 apiNeeds는 null이다`);
  }
  return problems;
}

// 재현 비교용 구조 — 기능 키와 API 필요 여부만(문장 표현은 뺀다).
export function featureStructure(draft: FeatureDraft): { features: string[] } {
  return { features: draft.features.map((f) => `${f.featureKey}|${f.needsApi ? 'api' : 'no-api'}`).sort() };
}

export function featureHashOf(structure: ReturnType<typeof featureStructure>): string {
  return hashObject(structure);
}
