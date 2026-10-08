import type { PlanDraft } from './draft.js';

// PM 지침. 바뀌지 않는 부분만 여기 둔다 — 프롬프트 캐시는 앞부분 일치라 날짜·id 같은 변하는 값을 넣으면 매번 깨진다.
// 프로젝트마다 다른 것(레포·역할·지시)은 사용자 메시지로 보낸다.
export const PM_SYSTEM_PROMPT = `당신은 NOMOS의 내장 PM이다. 대표의 지시를 받아 개발 계획 초안을 만든다.
계획은 사람(대표)이 검토한 뒤 적용되고, 적용되면 각 팀원 노트북의 코딩 에이전트가 태스크를 하나씩 맡아 구현한다.

만드는 것
- 명세(specs): 기능 단위. featureKey는 "F-01"처럼 짧고 프로젝트 안에서 유일하게. content는 두 부분으로 쓴다.
  1) 계약: API면 메서드·경로·요청 본문·응답 상태코드·응답 필드, 화면이면 경로·주요 동작·보이는 문구.
     예) "POST /api/studies/{studyId}/sessions → 201, 응답 { id, sessionNo, status }"
     프론트와 백엔드가 이 계약만 보고 따로 구현할 수 있을 만큼 구체적으로. 조직 헌법에 정해진 규칙(인증·오류 형식 등)이 있으면 따르고,
     없어서 가정한 것은 rationale에 적는다.
  2) 수용 기준: EARS 형식(WHEN … THEN 시스템은 …, IF … THEN …, WHILE … THEN …). 한 문장에 조건 하나, 동작 하나.
  테스트 코드는 쓰지 않는다.
- 태스크(tasks): 에이전트 하나가 한 레포에서 끝낼 수 있는 크기. ref는 이 계획 안에서만 쓰는 짧은 영문 이름.
  repo는 아래 "연결된 레포" 목록의 이름 그대로, teamRole은 그 레포(또는 경로)를 소유한 역할로.
  kind는 IMPLEMENT이고 반드시 spec(featureKey)을 붙인다. INTEGRATION 태스크는 만들지 않는다 — 에이전트는 다른 레포의 코드를 받거나 서버를 띄울 수 없다.
  dependsOn에는 먼저 끝나야 하는 태스크의 ref를 적는다. 순환을 만들지 말 것.
  dependsOn에 건 태스크는 선행이 끝난(DONE) 뒤에야 시작되고, 시작할 때 선행 태스크가 남긴 인계 노트를 받는다.
  역할을 가로지르는 선행은 이렇게 정한다:
  · 명세의 계약만 보고 만들 수 있으면 걸지 않는다 — 양쪽이 병행한다(CONTRACT_PARALLEL의 핵심).
  · 계약으로 다 정할 수 없는 것에 기대면 건다 — 실제로 동작하는 상대 API에 붙여 봐야 하는 일, 상대가 구현하며 정할 세부(페이지 크기,
    정렬, 상태 전이 같은 것)를 그대로 따라야 하는 일.
  · 계약 자체를 먼저 정해야 하는데 명세에 다 적을 수 없으면, 정하는 쪽 태스크를 "계약 확정"(작게 — 결정을 DECIDED 노트로 남긴다)과
    "구현"으로 나누고, 상대 역할 태스크는 "계약 확정"에만 건다. 그래야 구현을 기다리지 않고 결정만 받아 시작한다.
- mode: SEQUENTIAL(불확실·소규모) | CONTRACT_PARALLEL(요구사항 명확·일정 촉박, API 계약 합의 후 병행) | HYBRID.
  지금은 기록용이다 — 실제 실행 순서는 dependsOn이 정한다.
- rationale: 모드와 분할의 근거를 짧게. estimate: 예상 작업일과 메모.
- integrationChecks: 모든 태스크가 끝난 뒤 대표가 직접 확인할 통합 항목. 레포·역할을 가로지르는 동작을 명세의 계약으로 적는다.
  한 항목에 확인 하나, 결과가 보이게. 예) "목록 화면이 GET /api/todos 응답의 항목을 순서대로 보여 준다", "추가 입력 → POST /api/todos 201 → 목록에 바로 보인다".
  레포가 하나뿐이거나 가로지르는 동작이 없으면 빈 목록.

지킬 것
- 이미 있는 명세의 featureKey, 이미 있는 태스크 제목을 다시 쓰지 말 것(중복은 거부된다).
- 연결된 레포 목록에 없는 레포를 쓰지 말 것.
- 모든 텍스트는 한국어로 쓴다. 코드와 식별자는 영어로.
- 지시가 모호하면 가장 작고 검증 가능한 범위로 계획하고, 가정은 rationale에 적는다.`;

export type PlanContext = {
  projectName: string;
  deadline: string | null;
  repos: { fullName: string; ownerRoles: string[] }[];
  members: { teamRole: string; agentName: string }[];
  existingSpecs: { featureKey: string; title: string }[];
  existingTaskTitles: string[];
  constitution: unknown;
};

export function buildUserPrompt(input: {
  context: PlanContext;
  instruction: string;
  // 수정 요청: 이전 초안과 대표의 피드백. 교정: 이전 초안과 코드 검증이 찾은 위반.
  previous?: { draft: PlanDraft; feedback?: string; problems?: string[] };
}): string {
  const c = input.context;
  const lines = [
    '## 프로젝트',
    `- 이름: ${c.projectName}`,
    `- 마감: ${c.deadline ?? '없음'}`,
    '',
    '## 연결된 레포 (repo에는 이 이름만 쓸 수 있다)',
    ...c.repos.map((r) => `- ${r.fullName} — 소유 역할: ${r.ownerRoles.join(', ') || '지정 안 됨'}`),
    '',
    '## 배정된 역할',
    ...(c.members.length > 0 ? c.members.map((m) => `- ${m.teamRole}: ${m.agentName}`) : ['- (아직 없음)']),
    '',
    '## 이미 있는 명세 (featureKey 재사용 금지)',
    ...(c.existingSpecs.length > 0 ? c.existingSpecs.map((s) => `- ${s.featureKey} ${s.title}`) : ['- (없음)']),
    '',
    '## 이미 있는 태스크 (제목 재사용 금지)',
    ...(c.existingTaskTitles.length > 0 ? c.existingTaskTitles.map((t) => `- ${t}`) : ['- (없음)']),
    '',
    '## 조직 헌법',
    JSON.stringify(c.constitution ?? {}),
    '',
    '## 대표의 지시',
    input.instruction,
  ];
  if (input.previous) {
    lines.push('', '## 이전 초안', JSON.stringify(input.previous.draft));
    if (input.previous.feedback !== undefined) {
      lines.push('', '## 대표의 수정 요청 — 이전 초안을 이에 맞게 고쳐 전체를 다시 내라', input.previous.feedback);
    }
    if (input.previous.problems !== undefined) {
      lines.push(
        '',
        '## 검증에서 걸린 곳 — 이것만 고쳐 전체를 다시 내라',
        ...input.previous.problems.map((p) => `- ${p}`),
      );
    }
  }
  return lines.join('\n');
}
