// Executor가 Claude Code에 넘기는 프롬프트. 서버 브리핑을 그대로 옮긴다.
//
// 모델이 태스크 id를 추측하거나(제목으로 도구를 부르거나) 없는 도구를 제안하는 증상은
// 줄 정보가 없어서 생겼다. 그래서 id·명세·노트·수정 가능 경로를 전부 여기서 준다.
export type PromptBriefing = {
  task: { id: string; title: string; teamRole: string | null };
  repo: { fullName: string };
  spec: { featureKey: string; title: string; content: string } | null;
  notesBlock: string;
  lastRejection?: { reason: string; commitSha: string | null } | null;
  writablePaths: { pathPattern: string }[];
};

// 작업 환경(운영 테스트 4-4). 거부된 명령을 바꿔 가며 재시도하느라 턴을 쓰지 않게, 쓸 수 있는 것과 없는 것을 미리 말한다.
export type PromptEnvironment = {
  allowedCommands: readonly string[];
  setup: { command: string; ok: boolean }[];
};

export function buildTaskPrompt(briefing: PromptBriefing, branch: string, environment?: PromptEnvironment): string {
  const { task, repo, spec } = briefing;
  const sections: string[] = [];

  sections.push(
    [
      '# 태스크',
      `id: ${task.id}`,
      `제목: ${task.title}`,
      `역할: ${task.teamRole ?? '제한 없음'}`,
      `레포: ${repo.fullName}`,
      `브랜치: ${branch} (이미 이 워크트리에서 체크아웃돼 있다)`,
    ].join('\n'),
  );

  if (spec) {
    sections.push(`# 명세 ${spec.featureKey} — ${spec.title}\n${spec.content}`);
  }

  // 직전 제출이 반려됐다 — 같은 태스크 브랜치에 이전 작업이 남아 있으니 이어서 고친다.
  if (briefing.lastRejection) {
    sections.push(
      [
        '# 직전 제출이 대표에게 반려됐다',
        `사유: ${briefing.lastRejection.reason}`,
        `반려된 커밋: ${briefing.lastRejection.commitSha ?? '(알 수 없음)'} — 이 브랜치에 이전 작업이 남아 있다. 처음부터 다시 만들지 말고 사유에 맞게 고친 뒤 다시 제출한다.`,
      ].join('\n'),
    );
  }
  if (briefing.notesBlock) {
    sections.push(briefing.notesBlock);
  }

  sections.push(
    ['# 수정할 수 있는 경로', ...briefing.writablePaths.map((p) => `- ${p.pathPattern}`)].join('\n'),
  );

  sections.push(
    [
      '# 규칙',
      '- 작업을 시작하기 전에 claim_task를 부르고 성공을 확인한다. 실패하면 파일을 건드리지 않는다.',
      '- 위 목록 밖의 경로는 수정하지 않는다. 비밀 파일(.env, *.pem, *.key, secrets/)은 절대 건드리지 않는다.',
      '- 작업이 끝나면 커밋하고, submit_artifact에 **실제 커밋 sha와 실제로 바꾼 모든 경로**를 넣는다.',
      '  바꾸지 않은 경로를 적거나 sha를 지어내지 않는다 — 서버가 제출 시점에 다시 검증한다.',
      '- 제출이 NOTES_UNACKNOWLEDGED로 반려되면, 작업 중에 새로 올라온 인계 노트가 함께 온다. 읽고, 작업에 영향이 있으면 고쳐서 커밋한 뒤',
      '  submit_artifact를 다시 부르며 그 노트 id를 acknowledged_note_ids에 넣는다. 위 [인계 노트]의 노트는 따로 넣지 않아도 된다.',
      '- 다음 사람이 알아야 할 결정이나 함정이 있으면 publish_note로 남긴다. 다른 사람도 따라야 할 결정(계약·형식)은 DECIDED로 남긴다 — 프로젝트 전체에 전달된다.',
      '- 다른 에이전트의 잘못을 노트에 적지 않는다. 그건 raise_dispute의 몫이다.',
    ].join('\n'),
  );

  if (environment) {
    const installed = environment.setup.length === 0
      ? '- 설치할 의존성 파일(package.json·requirements.txt 등)이 없었다.'
      : environment.setup.map((s) => `- ${s.ok ? '설치됨' : '설치 실패'}: ${s.command}`).join('\n');
    sections.push(
      [
        '# 작업 환경',
        '- 쉘 명령은 Bash 도구로, 아래 접두사로 시작하는 것만 쓸 수 있다. 그 밖의 명령과 PowerShell은 승인할 사람이 없어 **자동으로 거부된다** — 바꿔 가며 다시 시도하지 않는다.',
        ...environment.allowedCommands.map((c) => `  - ${c}`),
        '- 명령은 한 번에 하나씩 쓴다. `&&`·`;`·`|`로 잇거나 리다이렉트하면 거부된다.',
        '- 파일을 보거나 찾을 때는 쉘(ls·cat·find) 대신 Read·Glob·Grep 도구를 쓴다. 작업 폴더 밖은 볼 수 없다.',
        '- 의존성은 NOMOS가 미리 설치해 두었다. 직접 설치(npm install·pip install)는 할 수 없다. 새 의존성이 필요하면 매니페스트(package.json·requirements.txt)만 고치고 GOTCHA 노트에 남긴다.',
        installed,
        '- 환경이 막혀 태스크를 끝낼 수 없으면 지어내거나 시험 없이 통과했다고 하지 않는다. 할 수 있는 만큼 하고, 막힌 이유를 마지막 메시지에 분명히 적고 끝낸다 — 그 문장이 대표에게 그대로 전달되고 대표가 해결한 뒤 다시 시작된다.',
      ].join('\n'),
    );
  }

  sections.push(`# 지금 할 일\n태스크 ${task.id}를 claim_task로 받고 위 규칙에 따라 진행하라.`);

  return sections.join('\n\n');
}
