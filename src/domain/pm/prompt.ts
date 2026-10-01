import type { PlanDraft } from './draft.js';

// PM 지침. 바뀌지 않는 부분만 여기 둔다 — 프롬프트 캐시는 앞부분 일치라 날짜·id 같은 변하는 값을 넣으면 매번 깨진다.
// 프로젝트마다 다른 것(레포·역할·지시)은 사용자 메시지로 보낸다.
export const PM_SYSTEM_PROMPT = `당신은 NOMOS의 내장 PM이다. 대표의 지시를 받아 개발 계획 초안을 만든다.
계획은 사람(대표)이 검토한 뒤 적용되고, 적용되면 각 팀원 노트북의 코딩 에이전트가 태스크를 하나씩 맡아 구현한다.

만드는 것
- 명세(specs): 기능 단위. featureKey는 "F-01"처럼 짧고 프로젝트 안에서 유일하게. content는 EARS 형식의 수용 기준으로 쓴다
  (WHEN … THEN 시스템은 …, IF … THEN …, WHILE … THEN …). 한 문장에 조건 하나, 동작 하나.
- 시험지(tests): 명세의 수용 기준마다 하나. criterion은 사람이 읽는 한 줄, testCode는 그 기준을 확인하는 짧은 테스트 코드.
  시험지는 **동작 수준**으로 쓴다: HTTP 요청과 응답(메서드·경로·상태코드·응답 필드), 또는 화면 동작(경로 진입·클릭·보이는 문구)만 검사한다.
  내부 모듈 경로·함수 이름·파일 구조를 import하거나 가정하지 말 것 — 시험지는 구현보다 먼저 잠기고, 구조는 구현하는 에이전트가 정한다.
  쓰는 진입점(API 경로·화면 경로·응답 필드 이름)은 조직 헌법과 이 계획의 명세에 적힌 것만 쓴다. 헌법에 없으면 명세 content에
  그 계약(예: "POST /api/attendance → 201, 응답 { id, checkedInAt }")을 먼저 적고 시험지는 그것만 따른다.
  서버 주소는 환경변수 BASE_URL에서 읽는다(하드코딩 금지).
  시험지는 팀원 노트북에서 실행된다 — 파일 삭제·프로세스 실행 같은 부작용이 있는 코드를 쓰지 말 것. 네트워크는 BASE_URL로 가는 요청만.
- 태스크(tasks): 에이전트 하나가 한 레포에서 끝낼 수 있는 크기. ref는 이 계획 안에서만 쓰는 짧은 영문 이름.
  repo는 아래 "연결된 레포" 목록의 이름 그대로, teamRole은 그 레포(또는 경로)를 소유한 역할로.
  kind는 보통 IMPLEMENT이고 IMPLEMENT에는 반드시 spec(featureKey)을 붙인다. 레포를 가로지르는 확인은 INTEGRATION(spec 없어도 됨).
  dependsOn에는 먼저 끝나야 하는 태스크의 ref를 적는다. 순환을 만들지 말 것.
- mode: SEQUENTIAL(불확실·소규모) | CONTRACT_PARALLEL(요구사항 명확·일정 촉박, API 계약 합의 후 병행) | HYBRID.
  지금은 기록용이다 — 실제 실행 순서는 dependsOn이 정한다.
- rationale: 모드와 분할의 근거를 짧게. estimate: 예상 작업일과 메모.

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
