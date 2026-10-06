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

export function buildTaskPrompt(briefing: PromptBriefing, branch: string): string {
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
      // 실험(E6): 이 줄이 없으면 명세에 없는 BE 결정을 묻지 않고 스스로 정했다(0/4). 있으면 필요한 곳에서만 물었다(4/4, 대조군 0/2).
      '- 다른 역할(BACKEND 등)이 정해야 하는 결정(응답 형식·상태 코드·필드 이름 등)이 명세·인계 노트에 없으면 추측하지 말고 AskUserQuestion으로 물어본다. 명세에 있으면 묻지 않는다. 답은 그 역할의 사람이 한다 — 기다리는 동안 작업이 멈춰 있어도 된다.',
      '- 작업이 끝나면 커밋하고, submit_artifact에 **실제 커밋 sha와 실제로 바꾼 모든 경로**를 넣는다.',
      '  바꾸지 않은 경로를 적거나 sha를 지어내지 않는다 — 서버가 제출 시점에 다시 검증한다.',
      '- 제출이 NOTES_UNACKNOWLEDGED로 반려되면, 작업 중에 새로 올라온 인계 노트가 함께 온다. 읽고, 작업에 영향이 있으면 고쳐서 커밋한 뒤',
      '  submit_artifact를 다시 부르며 그 노트 id를 acknowledged_note_ids에 넣는다. 위 [인계 노트]의 노트는 따로 넣지 않아도 된다.',
      '- 다음 사람이 알아야 할 결정이나 함정이 있으면 publish_note로 남긴다. 다른 사람도 따라야 할 결정(계약·형식)은 DECIDED로 남긴다 — 프로젝트 전체에 전달된다.',
      '- 다른 에이전트의 잘못을 노트에 적지 않는다. 그건 raise_dispute의 몫이다.',
    ].join('\n'),
  );

  sections.push(`# 지금 할 일\n태스크 ${task.id}를 claim_task로 받고 위 규칙에 따라 진행하라.`);

  return sections.join('\n\n');
}
