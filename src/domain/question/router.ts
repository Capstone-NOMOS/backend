import type { TeamRole } from '../roles.js';
import type { AskedQuestion } from './repository.js';

// 질문 라우터 — "이 질문은 누구 소관인가"를 정한다(실험 — exp/question-relay).
//
// 구현을 바꿔 끼우며 비교하려고 인터페이스로 둔다: 반대 역할 규칙(기본) · LLM · 결정 모델(Jev 등).
// 이 파일은 DB·설정·로거를 import하지 않는다 — 오프라인 평가 장치(데이터셋으로 라우터들을 비교)가 서버 없이 그대로 쓴다.
// LLM 계열 구현은 아래 buildRoutingPrompt·parseRoutingResponse를 함께 써서, 서버와 평가 장치가 같은 프롬프트를 본다.
//
// 결과 SELF: 묻는 쪽 자기 소관이다(실험: BE가 자기 에러 처리를 FE에게 물은 경우). 질문을 넘기지 않고 "스스로 정하라"로 돌려보낸다.

export type RoutingTarget = TeamRole | 'SELF';

export type RoutingInput = {
  askerRole: TeamRole;
  roles: readonly TeamRole[]; // 이 프로젝트에 있는 역할
  task: { title: string; kind: string };
  spec: { featureKey: string; title: string; content: string } | null;
  repo: { fullName: string } | null;
  questions: AskedQuestion[];
};

export type RoutingDecision = {
  target: RoutingTarget;
  // 0~1. 규칙처럼 확신도가 의미 없는 구현은 null.
  confidence: number | null;
  reason: string | null;
  // 어느 구현이 정했나(이름·버전). 질문 기록과 이벤트에 그대로 남는다 — 라우터별 지표를 이 값으로 가른다.
  routedBy: string;
};

export type QuestionRouter = {
  name: string;
  route(input: RoutingInput): Promise<RoutingDecision>;
};

function opposite(role: TeamRole): TeamRole {
  return role === 'FRONTEND' ? 'BACKEND' : 'FRONTEND';
}

// 기본: 질문 내용을 보지 않고 묻는 쪽의 반대 역할. 역할이 둘뿐이라 성립한다. 다른 구현이 실패할 때의 대체이기도 하다.
export const oppositeRoleRouter: QuestionRouter = {
  name: 'role_rule:opposite',
  async route(input) {
    return { target: opposite(input.askerRole), confidence: null, reason: null, routedBy: 'role_rule:opposite' };
  },
};

// LLM 계열 공통 프롬프트. 바꾸면 버전을 올린다(routedBy에 들어간다) — 다른 프롬프트의 결과를 같은 라우터로 세면 비교가 깨진다.
export const ROUTING_PROMPT_VERSION = 'v1';

export function buildRoutingPrompt(input: RoutingInput): string {
  return [
    '너는 소프트웨어 팀의 질문 라우터다. 개발 에이전트가 작업 중에 질문을 했다. 이 질문의 답을 정할 권한이 어느 역할에 있는지 고른다.',
    '',
    `역할: ${input.roles.join(', ')} (FRONTEND = 화면·사용자 경험·화면이 필요로 하는 것, BACKEND = API 계약·응답 형식·상태 코드·데이터·서버 동작)`,
    `질문한 에이전트의 역할: ${input.askerRole}`,
    `태스크: ${input.task.title} (${input.task.kind})`,
    input.repo ? `레포: ${input.repo.fullName}` : '',
    input.spec ? `명세 ${input.spec.featureKey} ${input.spec.title}:\n${input.spec.content}` : '명세: 없음',
    '',
    '질문:',
    ...input.questions.map((q, i) => `${i + 1}. ${q.question}${q.options?.length ? ` (선택지: ${q.options.map((o) => o.label).join(' / ')})` : ''}`),
    '',
    `규칙: 답을 정할 권한이 질문한 역할(${input.askerRole}) 자신에게 있으면 SELF다 — 남에게 물을 일이 아니다.`,
    '질문이 여러 개면 대부분을 정할 역할 하나를 고른다.',
    '',
    '마지막 응답은 JSON 하나만(설명·코드 블록 없이): {"target": "FRONTEND" | "BACKEND" | "SELF", "confidence": 0~1, "reason": "한 문장"}',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// 응답 해석. 형식이 틀리면 예외 — 호출부가 대체 라우터로 넘긴다(틀린 판정을 조용히 쓰지 않는다).
export function parseRoutingResponse(text: string, input: RoutingInput, routedBy: string): RoutingDecision {
  const json = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const parsed = JSON.parse(json) as { target?: unknown; confidence?: unknown; reason?: unknown };
  const allowed: readonly string[] = [...input.roles, 'SELF'];
  if (typeof parsed.target !== 'string' || !allowed.includes(parsed.target)) {
    throw new Error(`router returned an unknown target: ${String(parsed.target)}`);
  }
  // 자기 역할을 이름으로 고르면 SELF와 같다.
  const target = (parsed.target === input.askerRole ? 'SELF' : parsed.target) as RoutingTarget;
  const confidence = typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1 ? parsed.confidence : null;
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : null;
  return { target, confidence, reason, routedBy };
}
