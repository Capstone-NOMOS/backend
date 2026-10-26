// 질문 중계 점검용 명세·태스크(scripts/question-probe.ts). 기능 명세 → 계약 → 태스크 나누기를 건너뛰고
// "이 태스크를 잡은 에이전트가 반드시 AskUserQuestion을 띄우는" 상황만 만든다. 통합 테스트에서 질문이 서버·라우터·화면까지 가는지 본다.
//
// 시나리오마다 명세 하나 + 태스크 하나. 명세는 needsApi:false라 계약 단계 없이 시작할 수 있다.
// 명세 본문이 질문 문장·선택지·정할 역할을 못박는다 — 라우터 정확도가 아니라 "질문이 끝까지 가는가"를 보는 장치라서다.
import type { TeamRole } from '../../src/domain/roles.js';

export const PROBE_SCENARIOS = ['be', 'fe', 'pm'] as const;
export type ProbeScenario = (typeof PROBE_SCENARIOS)[number];

export type ProbeDefinition = {
  scenario: ProbeScenario;
  askerRole: TeamRole; // 태스크를 잡고 질문하는 쪽
  expectedTarget: TeamRole | 'PM'; // 라우터가 골라야 하는 대상
  question: string;
  options: string[];
  decidedBy: string; // 명세에 적는 "누가 정하나"
};

const DEFINITIONS: Record<ProbeScenario, ProbeDefinition> = {
  // FE 에이전트가 BE 소관(API 동작)을 묻는다 — 기본 경로.
  be: {
    scenario: 'be',
    askerRole: 'FRONTEND',
    expectedTarget: 'BACKEND',
    question: '스터디 목록 API는 한 페이지에 몇 개를 돌려주나요?',
    options: ['10개', '20개', '50개'],
    decidedBy: '이 값은 API를 만드는 BACKEND 담당이 정한다',
  },
  // BE 에이전트가 FE 소관(화면 표시)을 묻는다 — 반대 방향.
  fe: {
    scenario: 'fe',
    askerRole: 'BACKEND',
    expectedTarget: 'FRONTEND',
    question: '검색 결과가 없을 때 화면에는 어떤 문구를 보여 주나요?',
    options: ['검색 결과가 없습니다', '조건에 맞는 스터디가 없어요', '문구 없이 빈 목록만 보여 준다'],
    decidedBy: '화면에 보이는 문구는 FRONTEND 담당이 정한다',
  },
  // FE 에이전트가 제품 정책을 묻는다 — PM 초안 → 대표 확정 경로.
  pm: {
    scenario: 'pm',
    askerRole: 'FRONTEND',
    expectedTarget: 'PM',
    question: '탈퇴한 회원의 스터디 참여 기록은 얼마나 보관하나요?',
    options: ['즉시 삭제', '30일 보관', '1년 보관'],
    decidedBy: '이 값은 개발자가 아니라 제품 정책이라 PM(대표)이 정한다',
  },
};

export function probeDefinition(scenario: ProbeScenario): ProbeDefinition {
  return DEFINITIONS[scenario];
}

// 같은 제목·같은 기능 키는 거부되므로(재실행 방지 규칙) 실행마다 꼬리표를 붙인다.
export function probeStamp(now: Date = new Date()): string {
  return now.getTime().toString(36).slice(-6);
}

export type ProbeSpecInput = { featureKey: string; title: string; content: string; needsApi: false };
export type ProbeTaskFields = { title: string; teamRole: TeamRole; kind: 'IMPLEMENT' };

export function buildProbe(scenario: ProbeScenario, stamp: string): { spec: ProbeSpecInput; task: ProbeTaskFields; definition: ProbeDefinition } {
  const d = DEFINITIONS[scenario];
  const quotedOptions = d.options.map((o) => `"${o}"`).join(' / ');
  const content = [
    '질문 중계 점검용 태스크다(NOMOS 통합 테스트).',
    '코드를 읽거나 쓰기 전에 반드시 AskUserQuestion 도구로 아래 질문을 한 번 하라. 추측하거나 가정하고 넘어가지 말 것.',
    `질문: "${d.question}"`,
    `선택지: ${quotedOptions}`,
    `${d.decidedBy}.`,
    `답을 받으면 레포 루트의 README.md에 "${d.question} → <받은 답>" 한 줄만 추가하고(파일이 없으면 만든다) 커밋한 뒤 제출하라. 다른 파일은 건드리지 말 것.`,
  ].join('\n');
  return {
    definition: d,
    spec: { featureKey: `QP-${scenario.toUpperCase()}-${stamp}`, title: `질문 중계 점검 (${scenario}) ${stamp}`, content, needsApi: false },
    task: { title: `질문 중계 점검 (${scenario}) ${stamp}`, teamRole: d.askerRole, kind: 'IMPLEMENT' },
  };
}

export function parseScenarios(raw: string | undefined): ProbeScenario[] {
  if (!raw) return [...PROBE_SCENARIOS];
  const picked = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = picked.filter((s) => !(PROBE_SCENARIOS as readonly string[]).includes(s));
  if (unknown.length > 0) throw new Error(`모르는 시나리오: ${unknown.join(', ')} (가능: ${PROBE_SCENARIOS.join(', ')})`);
  return [...new Set(picked)] as ProbeScenario[];
}
