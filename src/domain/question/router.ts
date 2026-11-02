import type { TeamRole } from '../roles.js';
import type { AskedQuestion } from './repository.js';

// 질문 라우터 — "이 질문은 누구 소관인가"를 정한다(실험 — exp/question-relay).
//
// 구현을 바꿔 끼우며 비교하려고 인터페이스로 둔다: 반대 역할 규칙(기본) · LLM · 결정 모델(Jev 등).
// 이 파일은 DB·설정·로거를 import하지 않는다 — 오프라인 평가 장치(데이터셋으로 라우터들을 비교)가 서버 없이 그대로 쓴다.
// LLM 계열 구현은 아래 buildRoutingPrompt·parseRoutingResponse를 함께 써서, 서버와 평가 장치가 같은 프롬프트를 본다.
//
// 결과 SELF: 묻는 쪽 자기 소관이다(실험: BE가 자기 에러 처리를 FE에게 물은 경우). 질문을 넘기지 않고 "스스로 정하라"로 돌려보낸다.

// 답을 정할 권한이 있는 쪽. PM = 대표가 운용하는 PM 에이전트 — 요구사항·정책·제품 결정. 답은 대표가 확정한다(025).
export type QuestionTarget = TeamRole | 'PM';
export const PM_TARGET = 'PM' as const;
export type RoutingTarget = QuestionTarget | 'SELF';

// 질문이 나온 단계. 지금은 implementation(태스크를 구현하다 묻는다)만 실제로 이 경로를 탄다 —
// feature_spec(PM이 기능 명세 초안을 쓰다 묻는다)·contract(BE가 API 계약 초안을 쓰다 묻는다)는 같은 라우터로 보내려고 입력 모양을 먼저 맞춰 둔다.
export const ROUTING_STAGES = ['implementation', 'feature_spec', 'contract'] as const;
export type RoutingStage = (typeof ROUTING_STAGES)[number];
// 묻는 쪽. 기능 명세 초안의 질문은 PM 에이전트가 묻는다.
export type RoutingAsker = TeamRole | 'PM';

export type RoutingInput = {
  stage: RoutingStage;
  askerRole: RoutingAsker;
  roles: readonly TeamRole[]; // 이 프로젝트에 있는 역할
  // 기획 단계(feature_spec·contract)에는 태스크가 없다.
  task: { title: string; kind: string } | null;
  // implementation·contract = 확정한 기능 명세, feature_spec = 쓰고 있는 초안.
  spec: { featureKey: string; title: string; content: string } | null;
  repo: { fullName: string } | null;
  questions: AskedQuestion[];
  // 그 기능의 확정한 API 계약 요약(023) — implementation에서만. 계약이 정한 것은 BE에 물을 일이 아니다. contract 단계는 쓰고 있는 중이라 null.
  contract?: { featureKey: string; summary: string | null } | null;
  // 서버에서만 — 어느 조직의 모델 호출인가(중계 모드는 그 조직 대표 노트북이 돈다). 평가 장치는 넣지 않는다.
  context?: { orgId: string };
};

// 저장·재사용용 — 서버 전용 context를 뺀 라우팅 입력(032 agent_questions.routing_input). 서버·오프라인 평가·내보내기가 이 타입 하나를 쓴다:
// 운영에서 라우팅할 때 본 입력을 그대로 남기고, 오프라인 평가는 그 입력을 다시 조립하지 않고 그대로 라우터에 넣는다.
export type RoutingInputSnapshot = Omit<RoutingInput, 'context'>;

export function toRoutingSnapshot(input: RoutingInput): RoutingInputSnapshot {
  const { context: _context, ...snapshot } = input;
  return snapshot;
}

export type RoutingDecision = {
  target: RoutingTarget;
  // 0~1. 규칙처럼 확신도가 의미 없는 구현은 null.
  confidence: number | null;
  reason: string | null;
  // 어느 구현이 정했나(이름·버전). 질문 기록과 이벤트에 그대로 남는다 — 라우터별 지표를 이 값으로 가른다.
  routedBy: string;
  // 이 판정의 모델 비용(USD). 규칙처럼 비용이 없거나 모르면 null — 발표 지표 "요청당 비용".
  costUsd?: number | null;
};

export type QuestionRouter = {
  name: string;
  route(input: RoutingInput): Promise<RoutingDecision>;
};

// PM이 물으면 반대 역할이 없다 — 제품 결정은 대표(PM)에게.
function opposite(role: RoutingAsker): QuestionTarget {
  if (role === 'PM') return PM_TARGET;
  return role === 'FRONTEND' ? 'BACKEND' : 'FRONTEND';
}

// 반대 역할 규칙 — 질문 내용을 보지 않는다. **서비스에서는 고를 수 없다**(대표 결정 2026-10-24: 비교·대체 모두에서 뺐다).
// 테스트의 결정적 기본 라우터(tests/setup-invariants.ts)와 오프라인 평가의 기준선으로만 남긴다.
export const oppositeRoleRouter: QuestionRouter = {
  name: 'role_rule:opposite',
  async route(input) {
    return { target: opposite(input.askerRole), confidence: null, reason: null, routedBy: 'role_rule:opposite' };
  },
};

// LLM 계열 공통 프롬프트. 바꾸면 버전을 올린다(routedBy에 들어간다) — 다른 프롬프트의 결과를 같은 라우터로 세면 비교가 깨진다.
// v3: 단계(stage)·묻는 쪽(PM 포함)을 설명하고, PM이 물으면 SELF를 쓰지 않는다.
export const ROUTING_PROMPT_VERSION = 'v3';

// LLM 계열이 구조화 출력으로 쓰는 형식. target 값의 허용 범위는 parseRoutingResponse가 본다.
export const ROUTING_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'confidence', 'reason'],
  properties: {
    target: { type: 'string' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
};

// 단계마다 "누가 무엇을 하다가 물었나"와 명세 줄의 이름이 다르다.
function situation(input: RoutingInput): string {
  switch (input.stage) {
    case 'feature_spec':
      return 'PM 에이전트가 대표의 요구로 기능 명세 초안을 쓰다가 물었다. 기능 명세는 화면·동작·정책을 사람 말로 정하는 단계다(API·구현은 아직 정하지 않는다).';
    case 'contract':
      return `${input.askerRole} 에이전트가 확정한 기능 명세를 보고 API 계약 초안(OpenAPI)을 쓰다가 물었다.`;
    default:
      return `${input.askerRole} 개발 에이전트가 태스크를 구현하다가 물었다.`;
  }
}

function specLabel(stage: RoutingStage): string {
  return stage === 'feature_spec' ? '쓰고 있는 기능 명세 초안' : '확정한 기능 명세';
}

// PM이 묻는 쪽이면 SELF가 없다 — PM 에이전트는 제품 결정을 스스로 확정하지 않고 대표가 확정한다(025). PM 소관이면 PM(=대표에게)을 고른다.
function selfAllowed(input: RoutingInput): boolean {
  return input.askerRole !== 'PM';
}

export function buildRoutingPrompt(input: RoutingInput): string {
  const targets = ['FRONTEND', 'BACKEND', 'PM', ...(selfAllowed(input) ? ['SELF'] : [])].map((t) => `"${t}"`).join(' | ');
  return [
    '너는 소프트웨어 팀의 질문 라우터다. 이 질문의 답을 정할 권한이 어느 역할에 있는지 고른다.',
    situation(input),
    '',
    `후보: ${[...input.roles, PM_TARGET].join(', ')}`,
    '- FRONTEND = 화면·사용자 경험·화면이 필요로 하는 것',
    '- BACKEND = API 계약·응답 형식·상태 코드·데이터·서버 동작',
    '- PM = 요구사항·서비스 정책·기능 범위·우선순위 같은 제품 결정(대표가 정한다). 기술 구현 방식은 PM이 아니다',
    `질문한 쪽: ${input.askerRole}`,
    input.task ? `태스크: ${input.task.title} (${input.task.kind})` : '',
    input.repo ? `레포: ${input.repo.fullName}` : '',
    input.spec ? `${specLabel(input.stage)} ${input.spec.featureKey} ${input.spec.title}:\n${input.spec.content}` : `${specLabel(input.stage)}: 없음`,
    input.stage === 'implementation' && input.contract ? `확정한 API 계약(${input.contract.featureKey}) 요약: ${input.contract.summary ?? ''}` : '',
    '',
    '질문:',
    ...input.questions.map((q, i) => `${i + 1}. ${q.question}${q.options?.length ? ` (선택지: ${q.options.map((o) => o.label).join(' / ')})` : ''}`),
    '',
    selfAllowed(input)
      ? `규칙: 답을 정할 권한이 질문한 역할(${input.askerRole}) 자신에게 있으면 SELF다 — 남에게 물을 일이 아니다.`
      : '규칙: PM 에이전트는 제품 결정을 스스로 확정하지 않는다 — 요구사항·정책이면 PM(대표가 확정)을 고른다. SELF는 없다.',
    '질문이 여러 개면 대부분을 정할 역할 하나를 고른다.',
    '',
    `마지막 응답은 JSON 하나만(설명·코드 블록 없이): {"target": ${targets}, "confidence": 0~1, "reason": "한 문장"}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// 응답 해석. 형식이 틀리면 예외 — 호출부가 대체 라우터로 넘긴다(틀린 판정을 조용히 쓰지 않는다).
export function parseRoutingResponse(text: string, input: RoutingInput, routedBy: string): RoutingDecision {
  const json = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const parsed = JSON.parse(json) as { target?: unknown; confidence?: unknown; reason?: unknown };
  const allowed: readonly string[] = [...input.roles, PM_TARGET, 'SELF'];
  if (typeof parsed.target !== 'string' || !allowed.includes(parsed.target)) {
    throw new Error(`router returned an unknown target: ${String(parsed.target)}`);
  }
  // 자기 역할을 이름으로 고르면 SELF와 같다. PM이 물었으면 반대다 — PM 소관(SELF로 답해도)은 대상 PM(대표가 확정)이다.
  const target = (
    input.askerRole === 'PM' ? (parsed.target === 'SELF' ? PM_TARGET : parsed.target) : parsed.target === input.askerRole ? 'SELF' : parsed.target
  ) as RoutingTarget;
  const confidence = typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1 ? parsed.confidence : null;
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : null;
  return { target, confidence, reason, routedBy };
}
