import type { AttemptUsage } from './pricing.js';

// PM 모델 인터페이스 타입. 서버 설정(env)을 import하지 않는다 — 오프라인 평가 스크립트(scripts/lib/question-routers.ts)도 쓴다.

export type PmModelRequest = {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens: number;
  // 바뀌지 않는 지침. 앞에 두고 캐시한다(프롬프트 캐시는 앞부분 일치다).
  system: string;
  // 프로젝트 맥락·지시·(교정이면) 위반 목록. 매번 새 단발 호출이다 — 대화를 이어 붙이지 않는다.
  user: string;
  jsonSchema: Record<string, unknown>;
  signal: AbortSignal;
  // 어느 조직·무슨 호출인가. 중계 모드는 이걸로 작업을 그 조직의 pm-worker에게만 넘긴다.
  // route = 질문 라우팅, question_draft = PM 소관 질문의 답 초안(025) — 계획이 아니라 planId가 없다.
  context?: { orgId: string; planId: string | null; purpose: RelayPurpose };
};

export type RelayPurpose = 'draft' | 'repair' | 'route' | 'question_draft';

export type PmModelResponse = {
  // 해석하기 전에 반드시 먼저 본다. refusal·max_tokens면 JSON이 스키마와 맞지 않을 수 있다.
  stopReason: string | null;
  servedModel: string | null;
  text: string;
  // 시도마다의 사용량(대체 모델이 돌면 둘 이상). 비용은 항목마다 그 모델 가격으로 더한다.
  attempts: AttemptUsage[];
  // 모델 API 호출에 걸린 시간(ms) — 질문 라우팅의 "판정 시간"(035). API 모드는 서버가 잰 호출 시간,
  // 중계 모드는 노트북의 Claude Code가 보고한 duration_api_ms(CLI 0.1.19+, 옛 CLI는 없음 → null).
  modelLatencyMs?: number | null;
};

export type PmModel = {
  kind: string;
  generate(request: PmModelRequest): Promise<PmModelResponse>;
};
