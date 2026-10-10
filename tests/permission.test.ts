import { describe, expect, it } from 'vitest';
import { DENY_OTHER, handleAskUserQuestion, isHandled, QUESTION_POLL_MS, type QuestionLike, type WaitDeps } from '../src/bridge/permission.js';

// 권한 도구는 보안 경계다 — Claude Code는 여기서 돌려준 답대로 실행한다(실험 E2: 전부 허용으로 답하면 curl·작업 폴더 밖 쓰기가 실제로 실행됐다).
describe('권한 도구 — 판단', () => {
  it('AskUserQuestion만 처리하고, 이름이 조금이라도 다르면 처리하지 않는다', () => {
    expect(isHandled('AskUserQuestion')).toBe(true);
    for (const name of ['Bash', 'Write', 'Edit', 'WebFetch', 'PowerShell', 'mcp__nomos__claim_task', 'askuserquestion', 'AskUserQuestion ', '', undefined, null, 42]) {
      expect(isHandled(name), String(name)).toBe(false);
    }
  });

  it('처리하지 않는 요청은 거부이고, 우회하지 말라고 알린다', () => {
    expect(DENY_OTHER.behavior).toBe('deny');
    expect(DENY_OTHER).toMatchObject({ message: expect.stringContaining('Do not retry') });
  });
});

const QUESTION = { question: '응답 필드 이름 규칙은?', header: '필드', multiSelect: false, options: [{ label: 'camelCase' }, { label: 'snake_case' }] };

function deps(sequence: QuestionLike[], overrides: Partial<WaitDeps> = {}): WaitDeps & { asked: unknown[][] } {
  const asked: unknown[][] = [];
  let i = 0;
  return {
    asked,
    ask: async (questions) => {
      asked.push(questions);
      return { id: 'q-1', ...sequence[0]! };
    },
    get: async () => sequence[Math.min(++i, sequence.length - 1)]!,
    sleep: async () => undefined,
    maxWaitMs: 60_000,
    ...overrides,
  };
}

describe('권한 도구 — AskUserQuestion 중계', () => {
  it('답이 오면 원래 입력에 answers만 붙여 허용한다', async () => {
    const input = { questions: [QUESTION], extra: 'keep' };
    const d = deps([{ status: 'pending', answers: null }, { status: 'answered', answers: { [QUESTION.question]: 'camelCase' } }]);
    const result = await handleAskUserQuestion(input, d);
    expect(d.asked).toEqual([[QUESTION]]);
    expect(result).toEqual({ behavior: 'allow', updatedInput: { questions: [QUESTION], extra: 'keep', answers: { [QUESTION.question]: 'camelCase' } } });
  });

  it('만료되면 커밋하지 말고 멈추라는 거부로 돌려준다 — 지시가 없으면 모델이 추측해 커밋했다(실험 E4)', async () => {
    const result = await handleAskUserQuestion({ questions: [QUESTION] }, deps([{ status: 'pending', answers: null }, { status: 'expired', answers: null }]));
    expect(result.behavior).toBe('deny');
    expect(result).toMatchObject({ message: expect.stringContaining('do NOT commit') });
    expect(result).toMatchObject({ message: expect.stringContaining('BLOCKED:') });
    expect(result).toMatchObject({ message: expect.stringContaining(QUESTION.question) });
  });

  it('서버가 계속 대기 상태여도 최대 대기 시간이 지나면 멈춘다', async () => {
    let t = 0;
    const result = await handleAskUserQuestion(
      { questions: [QUESTION] },
      deps([{ status: 'pending', answers: null }], { maxWaitMs: 10_000, now: () => (t += 3_000) }),
    );
    expect(result.behavior).toBe('deny');
  });

  it('서버에 올리지 못하면(네트워크·권한 오류) 거부다 — 고장은 열리는 쪽이 아니다', async () => {
    const result = await handleAskUserQuestion({ questions: [QUESTION] }, {
      ...deps([{ status: 'pending', answers: null }]),
      ask: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(result).toMatchObject({ behavior: 'deny', message: expect.stringContaining('ECONNREFUSED') });
  });

  it('기다리는 동안 진행 콜백을 부른다 — 30분 무응답 한도를 넘기기 위한 진행 알림의 자리다', async () => {
    const waits: number[] = [];
    await handleAskUserQuestion(
      { questions: [QUESTION] },
      deps(
        [{ status: 'pending', answers: null }, { status: 'pending', answers: null }, { status: 'answered', answers: { [QUESTION.question]: 'x' } }],
        { onWaiting: (ms) => void waits.push(ms) },
      ),
    );
    expect(waits.length).toBe(2);
  });
});

describe('권한 도구 — 라우터가 자기 소관이라고 판정한 질문', () => {
  it('self_owned면 기다리지 않고 "스스로 정하고 DECIDED로 남겨라"로 돌려준다', async () => {
    let polled = 0;
    const result = await handleAskUserQuestion({ questions: [QUESTION] }, {
      ...deps([{ status: 'self_owned', answers: null }]),
      get: async () => {
        polled += 1;
        return { status: 'self_owned', answers: null };
      },
    });
    expect(polled).toBe(0);
    expect(result).toMatchObject({ behavior: 'deny', message: expect.stringContaining('your own role') });
    expect(result).toMatchObject({ message: expect.stringContaining('DECIDED') });
  });
});

describe('권한 도구 — C안: 실행 안에서 정한 시간만 기다린다', () => {
  it('답을 기다리는 동안 5초 간격으로 서버에 묻는다', async () => {
    const slept: number[] = [];
    await handleAskUserQuestion(
      { questions: [QUESTION] },
      deps([{ status: 'pending', answers: null }, { status: 'pending', answers: null }, { status: 'answered', answers: { [QUESTION.question]: 'x' } }], {
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
    );
    expect(QUESTION_POLL_MS).toBe(5_000);
    expect(slept).toEqual([5_000, 5_000]);
  });

  it('에이전트 답(agent_answered)도 바로 쓴다', async () => {
    const result = await handleAskUserQuestion({ questions: [QUESTION] }, deps([{ status: 'pending', answers: null }, { status: 'agent_answered', answers: { [QUESTION.question]: 'camelCase' } }]));
    expect(result).toMatchObject({ behavior: 'allow', updatedInput: { answers: { [QUESTION.question]: 'camelCase' } } });
  });

  it('시간이 지나면 내려놓고(detach) "멈춰라, 나중에 다시 시작된다"로 돌려준다', async () => {
    let t = 0;
    const detached: string[] = [];
    const result = await handleAskUserQuestion(
      { questions: [QUESTION] },
      deps([{ status: 'pending', answers: null }], {
        inlineWaitMs: 5_000,
        maxWaitMs: 60_000,
        now: () => (t += 2_000),
        detach: async (id) => {
          detached.push(id);
          return { status: 'pending', answers: null };
        },
      }),
    );
    expect(detached).toEqual(['q-1']);
    expect(result).toMatchObject({ behavior: 'deny', message: expect.stringContaining('paused') });
    expect(result).toMatchObject({ message: expect.stringContaining('do NOT commit') });
    expect(result).toMatchObject({ message: expect.stringContaining('BLOCKED:') });
  });

  it('내려놓는 순간 답이 와 있었으면 그 답을 쓴다', async () => {
    let t = 0;
    const result = await handleAskUserQuestion(
      { questions: [QUESTION] },
      deps([{ status: 'pending', answers: null }], {
        inlineWaitMs: 1_000,
        now: () => (t += 2_000),
        detach: async () => ({ status: 'answered', answers: { [QUESTION.question]: 'snake_case' } }),
      }),
    );
    expect(result).toMatchObject({ behavior: 'allow', updatedInput: { answers: { [QUESTION.question]: 'snake_case' } } });
  });
});
