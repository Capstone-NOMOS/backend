// 헤드리스 Claude Code의 권한 도구(--permission-prompt-tool). 미리 정해지지 않은 행동마다 Claude Code가 여기에 "해도 되나"를 묻고,
// **여기서 돌려준 답대로 실행한다**(실험 E2: 전부 허용으로 답하면 curl·작업 폴더 밖 쓰기·WebFetch가 실제로 실행됐다).
//
// 그래서 판단은 허용 목록 하나다: AskUserQuestion만 처리하고 나머지는 전부 거부한다. 이 조건을 넓히지 말 것 —
// 넓히면 Bash 허용 목록·작업 폴더 경계가 이 도구를 통해 열린다. settings.json의 deny(.env·contracts 등)는 이 도구보다 먼저 이기지만,
// 그 밖의 경계는 이 함수가 지킨다. 예외·고장도 거부다(Claude Code도 응답이 깨지면 거부로 처리한다 — 실험 E2).

export const ASK_USER_QUESTION = 'AskUserQuestion';

export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export function isHandled(toolName: unknown): boolean {
  return toolName === ASK_USER_QUESTION;
}

export const DENY_OTHER: PermissionResult = {
  behavior: 'deny',
  message: 'NOMOS: this action is not allowed in a task run. Do not retry it or work around it with another tool.',
};

// 답이 없을 때의 문구. 지시가 없으면 모델이 BE 결정을 스스로 추측해 커밋했다(실험 E4) — 그래서 멈추라고 명시한다.
export function denyUnanswered(reason: string, questions: string[]): PermissionResult {
  return {
    behavior: 'deny',
    message:
      `NOMOS: ${reason} This decision belongs to another role and has not been made. Do NOT guess and do NOT commit. ` +
      `Stop work now, leave the working tree as is, and end your final message with one line per question: BLOCKED: <the question>.` +
      (questions.length > 0 ? ` Questions: ${questions.join(' / ')}` : ''),
  };
}

export type QuestionLike = { status: 'pending' | 'answered' | 'expired' | 'self_owned'; answers: Record<string, string> | null };

// 라우터가 "묻는 쪽 자기 소관"이라고 판정했다 — 남에게 넘기지 않고 스스로 정하게 한다. 정한 것은 다른 사람이 따라야 하므로 DECIDED로 남긴다.
export const DENY_SELF_OWNED: PermissionResult = {
  behavior: 'deny',
  message:
    'NOMOS: this decision belongs to your own role, so it was not sent to anyone. Decide it yourself based on the spec and existing code, ' +
    'continue the task, and record the decision with publish_note (kind DECIDED) so others follow it.',
};

export type WaitDeps = {
  ask: (questions: unknown[]) => Promise<{ id: string } & QuestionLike>;
  get: (questionId: string) => Promise<QuestionLike>;
  sleep: (ms: number) => Promise<void>;
  onWaiting?: (elapsedMs: number) => Promise<void> | void;
  pollMs?: number;
  // 서버 만료와 별개의 안전장치 — 서버가 응답하지 않아도 무한히 기다리지 않는다.
  maxWaitMs: number;
  now?: () => number;
};

// AskUserQuestion 하나를 처리한다: 서버에 올리고 답(또는 만료)까지 기다려 Claude Code에 돌려줄 결과를 만든다.
// 답은 원래 입력에 answers만 붙여 돌려준다 — 다른 필드는 손대지 않는다.
export async function handleAskUserQuestion(input: Record<string, unknown>, deps: WaitDeps): Promise<PermissionResult> {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const texts = questions.map((q) => (q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string' ? (q as { question: string }).question : '')).filter(Boolean);
  const now = deps.now ?? Date.now;
  const started = now();
  try {
    const asked = await deps.ask(questions);
    let state: QuestionLike = asked;
    while (state.status === 'pending') {
      if (now() - started >= deps.maxWaitMs) return denyUnanswered('No answer arrived in time.', texts);
      await deps.onWaiting?.(now() - started);
      await deps.sleep(deps.pollMs ?? 2_000);
      state = await deps.get(asked.id);
    }
    if (state.status === 'answered' && state.answers) return { behavior: 'allow', updatedInput: { ...input, answers: state.answers } };
    if (state.status === 'self_owned') return DENY_SELF_OWNED;
    return denyUnanswered('No answer arrived in time.', texts);
  } catch (err) {
    return denyUnanswered(`The question could not be delivered (${err instanceof Error ? err.message : String(err)}).`, texts);
  }
}
