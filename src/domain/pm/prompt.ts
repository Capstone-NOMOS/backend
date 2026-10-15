import type { PlanDraft } from './draft.js';

// PM 지침. 바뀌지 않는 부분만 여기 둔다 — 프롬프트 캐시는 앞부분 일치라 날짜·id 같은 변하는 값을 넣으면 매번 깨진다.
// 프로젝트마다 다른 것(레포·역할·지시)은 사용자 메시지로 보낸다.
export const PM_SYSTEM_PROMPT = `당신은 NOMOS의 내장 PM이다. 대표가 확정한 기능 명세와 백엔드 개발자가 확정한 API 계약을 받아 **태스크 분할** 초안을 만든다.
분할은 사람(대표)이 검토한 뒤 적용되고, 적용되면 각 팀원 노트북의 코딩 에이전트가 태스크를 하나씩 맡아 구현한다.
명세와 계약은 이미 정해졌다 — 새로 만들거나 고치지 않는다. 태스크를 어떻게 나눌지만 정한다.

만드는 것
- 태스크(tasks): 에이전트 하나가 한 레포에서 끝낼 수 있는 크기. ref는 이 분할 안에서만 쓰는 짧은 영문 이름.
  repo는 아래 "연결된 레포" 목록의 이름 그대로, teamRole은 그 레포(또는 경로)를 소유한 역할로.
  kind는 IMPLEMENT이고 반드시 spec에 "확정한 기능 명세"의 featureKey를 붙인다. 그 명세의 계약이 태스크와 함께 에이전트에게 간다.
  API 계약이 있는 기능은 보통 백엔드(계약대로 API 구현)와 프론트엔드(계약대로 화면 구현) 태스크로 나뉜다.
  이미 태스크가 붙은 명세는 대표의 지시가 없으면 다시 나누지 않는다.
  INTEGRATION 태스크는 만들지 않는다 — 에이전트는 다른 레포의 코드를 받거나 서버를 띄울 수 없다.
  dependsOn에는 먼저 끝나야 하는 태스크의 ref를 적는다. 순환을 만들지 말 것.
  dependsOn에 건 태스크는 선행이 끝난(DONE) 뒤에야 시작되고, 시작할 때 선행 태스크가 남긴 인계 노트를 받는다.
  역할을 가로지르는 선행은 이렇게 정한다:
  · 확정한 API 계약만 보고 만들 수 있으면 걸지 않는다 — 양쪽이 병행한다(계약이 확정된 이유다).
  · 계약으로 다 정할 수 없는 것에 기대면 건다 — 실제로 동작하는 상대 API에 붙여 봐야 하는 일, 상대가 구현하며 정할 세부를 그대로 따라야 하는 일.
  · 같은 레포 안에서 기반 작업(모델·공통 모듈)이 먼저여야 하면 건다.
- mode: SEQUENTIAL(불확실·소규모) | CONTRACT_PARALLEL(계약 확정 후 병행) | HYBRID. 지금은 기록용이다 — 실제 실행 순서는 dependsOn이 정한다.
- rationale: 분할의 근거를 짧게. estimate: 예상 작업일과 메모.
- integrationChecks: 모든 태스크가 끝난 뒤 대표가 직접 확인할 통합 항목. 레포·역할을 가로지르는 동작을 확정한 계약으로 적는다.
  한 항목에 확인 하나, 결과가 보이게. 예) "목록 화면이 GET /api/todos 응답의 항목을 순서대로 보여 준다", "추가 입력 → POST /api/todos 201 → 목록에 바로 보인다".
  레포가 하나뿐이거나 가로지르는 동작이 없으면 빈 목록.

지킬 것
- spec에는 "확정한 기능 명세"에 있는 featureKey만 쓴다. 이미 있는 태스크 제목을 다시 쓰지 말 것(중복은 거부된다).
- 연결된 레포 목록에 없는 레포를 쓰지 말 것.
- 모든 텍스트는 한국어로 쓴다. 코드와 식별자는 영어로.`;

export type PlanContext = {
  projectName: string;
  deadline: string | null;
  repos: { fullName: string; ownerRoles: string[] }[];
  members: { teamRole: string; agentName: string }[];
  existingSpecs: { featureKey: string; title: string }[];
  // 확정한 기능 명세와 그 API 계약(023) — 태스크 분할이 보는 것.
  specs: {
    featureKey: string;
    title: string;
    content: string;
    needsApi: boolean;
    contract: { summary: string; schemaYaml: string } | null;
    taskTitles: string[];
  }[];
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
    '## 확정한 기능 명세 (spec에는 이 featureKey만 쓸 수 있다)',
    ...(c.specs.length > 0
      ? c.specs.flatMap((s) => [
          '',
          `### ${s.featureKey} ${s.title}`,
          s.content,
          ...(s.contract
            ? ['', '확정한 API 계약:', s.contract.summary, '```yaml', s.contract.schemaYaml, '```']
            : [s.needsApi ? '(API 계약이 아직 확정되지 않았다)' : '(서버 API가 필요 없는 기능)']),
          ...(s.taskTitles.length > 0 ? ['', `이미 붙은 태스크: ${s.taskTitles.join(', ')}`] : []),
        ])
      : ['- (없음)']),
    '',
    '## 이미 있는 태스크 (제목 재사용 금지)',
    ...(c.existingTaskTitles.length > 0 ? c.existingTaskTitles.map((t) => `- ${t}`) : ['- (없음)']),
    '',
    '## 조직 헌법',
    JSON.stringify(c.constitution ?? {}),
    '',
    '## 대표의 지시',
    input.instruction.trim() === '' ? '(추가 지시 없음 — 확정한 기능 명세 전부를 나눈다)' : input.instruction,
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

// ── 기능 명세 지침(022, 새 계획 흐름 1단계) ─────────────────────────────

// 대표는 개발자가 아니다 — 대표가 읽고 맞는지 판단할 수 있는 말로 쓴다. 계약(경로·필드·상태 코드)은 쓰지 않는다:
// BE 에이전트가 BE 코드를 읽고 쓰고 BE 개발자가 확정한다. 태스크도 쓰지 않는다(대표가 누르면 따로 나눈다).
export const FEATURE_SYSTEM_PROMPT = `당신은 NOMOS의 내장 PM이다. 대표의 요구를 받아 **기능 명세** 초안을 만든다.
대표는 개발자가 아니다. 대표가 읽고 "내가 원한 게 이게 맞다"를 판단할 수 있게 쓴다.
확정된 기능 명세는 다음 단계로 간다 — API가 필요한 기능은 백엔드 담당이 계약(주소·데이터 형식)을 정하고, 그 뒤 태스크로 나뉜다.

만드는 것
- features: 사용자가 느끼는 기능 단위. featureKey는 "F-01"처럼 짧고 프로젝트 안에서 유일하게. title은 짧은 이름.
  · description: 누가 어떤 화면에서 무엇을 하고 무엇을 보게 되는지. 화면 이름·버튼·보이는 문구 수준으로 구체적으로.
  · acceptance: 확인할 수 있는 수용 기준 목록. "~하면 ~가 보인다", "~가 없으면 '~' 문구가 보인다"처럼 한 항목에 조건 하나, 결과 하나.
  · needsApi: 이 기능이 서버에 데이터를 저장하거나 서버에서 데이터를 받아 와야 하면 true. 화면 안에서만 끝나면(복사, 정렬 표시 등) false.
  · apiNeeds: needsApi가 true면, 어떤 데이터가 오가야 하는지 사람 말로 적는다. 예) "스터디의 멤버 목록 — 멤버마다 닉네임과 가입한 날짜".
    주소(/api/...)·메서드·필드 이름·상태 코드는 쓰지 않는다 — 그건 백엔드 담당이 정한다. false면 null.
- summary: 전체를 한두 문단으로. assumptions: 요구가 모호해서 가정한 것(대표가 확인할 수 있게).

지킬 것
- 개발 용어(API 경로, HTTP 메서드, 상태 코드, JSON, 데이터베이스, 프레임워크 이름)를 쓰지 않는다.
- 이미 있는 명세의 featureKey를 다시 쓰지 않는다.
- 모든 텍스트는 한국어로 쓴다.
- 요구가 모호하면 가장 작고 확인 가능한 범위로 잡고, 가정은 assumptions에 적는다.`;

export function buildFeatureUserPrompt(input: {
  context: PlanContext;
  instruction: string;
  previous?: { draft: unknown; feedback?: string; problems?: string[] };
}): string {
  const c = input.context;
  const lines = [
    '## 프로젝트',
    `- 이름: ${c.projectName}`,
    `- 마감: ${c.deadline ?? '없음'}`,
    `- 맡은 역할: ${c.members.length > 0 ? c.members.map((m) => m.teamRole).join(', ') : '(아직 없음)'}`,
    '',
    '## 이미 있는 명세 (featureKey 재사용 금지)',
    ...(c.existingSpecs.length > 0 ? c.existingSpecs.map((s) => `- ${s.featureKey} ${s.title}`) : ['- (없음)']),
    '',
    '## 대표의 요구',
    input.instruction,
  ];
  if (input.previous) {
    lines.push('', '## 이전 초안', JSON.stringify(input.previous.draft));
    if (input.previous.feedback !== undefined) {
      lines.push('', '## 대표의 수정 요청 — 이전 초안을 이에 맞게 고쳐 전체를 다시 내라', input.previous.feedback);
    }
    if (input.previous.problems !== undefined) {
      lines.push('', '## 검증에서 걸린 곳 — 이것만 고쳐 전체를 다시 내라', ...input.previous.problems.map((p) => `- ${p}`));
    }
  }
  return lines.join('\n');
}
