import { MAX_RETRIES } from '../task/retry.js';
import type { FeedRow } from './repository.js';

// 룸 피드의 한 줄. 문장은 서버가 만든다 — 같은 이벤트를 화면마다 다르게 풀면 룸마다 말이 달라진다.
// speaker: pm(서버가 지시·판정을 알림) · nomos(Executor가 보고한 실행 상태) · agent(에이전트가 쓴 도구).
export type RoomMessage = {
  id: string;
  ts: string;
  speaker: 'pm' | 'nomos' | 'agent';
  type: string;
  taskId: string | null;
  taskTitle: string | null;
  text: string;
};

const ACTIVITY_TEXT: Record<string, (target: string) => string> = {
  read: (t) => `${t} 읽는 중`,
  edit: (t) => `${t} 수정`,
  write: (t) => `${t} 작성`,
  run: (t) => `${t} 실행`,
  search: (t) => `${t} 검색`,
  other: (t) => t,
};

const STAGE_ORDER = ['V1A', 'V1B', 'V2', 'V3', 'V4'];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

// "V3 통과, V1A·V1B·V2 건너뜀" — 결과별로 묶는다.
function stagesText(stages: unknown): string {
  if (!Array.isArray(stages)) return '';
  const by: Record<string, string[]> = {};
  for (const s of stages as { stage?: unknown; result?: unknown }[]) {
    const result = str(s.result);
    (by[result] ??= []).push(str(s.stage));
  }
  const label: [string, string][] = [
    ['FAIL', '실패'],
    ['PASS', '통과'],
    ['SKIPPED', '건너뜀'],
  ];
  return label
    .filter(([r]) => by[r]?.length)
    .map(([r, l]) => `${by[r]!.sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b)).join('·')} ${l}`)
    .join(', ');
}

function eventText(row: FeedRow): { speaker: RoomMessage['speaker']; text: string } | null {
  const p = row.payload;
  const title = row.taskTitle ?? '태스크';
  switch (row.type) {
    case 'PROJECT_STARTED':
      return { speaker: 'pm', text: '프로젝트를 시작합니다' };
    case 'PLAN_APPLIED':
      return { speaker: 'pm', text: '계획을 적용했습니다' };
    case 'RELEASE_REQUESTED': {
      const checks = num(p.checkCount);
      return { speaker: 'pm', text: `모든 태스크가 완료되었습니다 → 대표의 통합 확인을 기다립니다${checks > 0 ? ` (확인 항목 ${checks}개)` : ''}` };
    }
    case 'RELEASE_DECIDED':
      return p.decision === 'APPROVE'
        ? { speaker: 'pm', text: '대표가 통합 확인을 마쳤습니다 → 프로젝트 완료' }
        : { speaker: 'pm', text: `대표가 통합 확인에서 반려했습니다${p.reason ? `: ${str(p.reason)}` : ''}` };
    case 'TASK_DISPATCHED': {
      const attempt = num(p.attempt);
      if (num(p.resumes) > 0 && attempt === 0) return { speaker: 'pm', text: `${title} 다시 실행해 주세요 (재개)` };
      return attempt === 0
        ? { speaker: 'pm', text: `${title} 실행해 주세요` }
        : { speaker: 'pm', text: `${title} 다시 실행해 주세요 (재시도 ${attempt}/${MAX_RETRIES})` };
    }
    // 실행 순서: Executor가 에이전트를 띄우고(AGENT_RUN_STARTED) → 에이전트가 실행 안에서 태스크를 잡는다(TASK_CLAIMED).
    case 'AGENT_RUN_STARTED':
      return { speaker: 'nomos', text: '에이전트를 실행합니다' };
    case 'TASK_CLAIMED':
      return { speaker: 'nomos', text: `태스크 수령 — ${title} · 구현을 시작합니다` };
    case 'AGENT_RUN_ENDED': {
      // 제출하지 않았으면 바로 뒤의 TASK_BLOCKED 줄이 사유를 말한다 — 여기서는 끝났다는 사실만.
      const seconds = Math.round(num(p.durationMs) / 1000);
      if (p.waitingQuestion === true) return { speaker: 'nomos', text: `실행을 멈췄습니다 (${seconds}초) — 질문의 답이 오면 다시 시작합니다` };
      return { speaker: 'nomos', text: p.submitted === true ? `실행을 마쳤습니다 (${seconds}초)` : `실행을 마쳤습니다 (${seconds}초, 제출 없음)` };
    }
    case 'ARTIFACT_SUBMITTED': {
      const sha = str(p.commitSha).slice(0, 7);
      const files = row.changedPathCount === null ? '' : `, 파일 ${row.changedPathCount}개`;
      return { speaker: 'nomos', text: `제출했습니다 (커밋 ${sha}${files})` };
    }
    case 'VERIFICATION_COMPLETED': {
      const stages = stagesText(p.stages);
      switch (str(p.taskState)) {
        case 'DONE':
          return { speaker: 'pm', text: `검증 완료 — ${stages} → 완료되었습니다` };
        case 'AWAITING_APPROVAL':
          return { speaker: 'pm', text: `검증 완료 — ${stages} → 대표 승인을 기다립니다` };
        case 'READY':
          return { speaker: 'pm', text: `검증 실패 — ${stages} → 다시 시도합니다 (${num(p.retryCount)}/${MAX_RETRIES})` };
        case 'ESCALATED':
          return { speaker: 'pm', text: `검증 실패 — ${stages} → 재시도 한도를 넘어 대표에게 넘깁니다` };
        default:
          // 아직 단계가 남았다(VERIFYING) — 단계 보고마다 줄이 생겨 시끄러웠다(실측). 결론이 난 줄만 보인다.
          return null;
      }
    }
    case 'TASK_BLOCKED': {
      const why: Record<string, string> = {
        not_submitted: '제출하지 않고 끝났습니다',
        timeout: '시간 제한을 넘겼습니다',
        failed: '비정상 종료했습니다',
        unresponsive: '에이전트 응답이 끊겼습니다',
      };
      const denied = Array.isArray(p.deniedCommands) && p.deniedCommands.length > 0 ? ` / 거부된 명령: ${(p.deniedCommands as unknown[]).map(str).join(', ')}` : '';
      const said = str(p.lastMessage) ? ` / 에이전트: "${str(p.lastMessage).slice(0, 200)}"` : '';
      return { speaker: 'pm', text: `멈췄습니다 — ${why[str(p.cause)] ?? '제출하지 않았습니다'}${said}${denied} → 대표 확인 후 재개가 필요합니다` };
    }
    case 'QUESTION_ASKED':
      return { speaker: 'agent', text: `${str(p.askerRole)} 에이전트가 ${str(p.targetRole)}에게 질문했습니다 (${num(p.questionCount)}개)` };
    case 'QUESTION_DRAFTED':
      return p.autoAnswered === true
        ? { speaker: 'agent', text: '답할 역할의 에이전트가 코드에서 찾아 답했습니다' }
        : { speaker: 'agent', text: `답 초안을 만들었습니다 — 정해진 것 ${num(p.decidedCount)}/${num(p.questionCount)}, 나머지는 담당자 확인이 필요합니다` };
    case 'QUESTION_ANSWERED':
      return { speaker: 'pm', text: `질문에 답이 왔습니다(${p.answeredByRole === 'REPRESENTATIVE' ? '대표' : '담당자'})${p.resumedTask === true ? ' → 다시 시작합니다' : ''}` };
    case 'TASK_BLOCKED_ON_QUESTION':
      return { speaker: 'pm', text: `${str(p.targetRole)}의 답을 기다리며 태스크를 잠시 내려놓았습니다 — 답이 오면 다시 시작합니다` };
    case 'QUESTION_EXPIRED':
      return { speaker: 'pm', text: `질문이 기한 안에 답을 받지 못했습니다${p.escalated === true ? ' → 대표에게 넘깁니다' : ''}` };
    case 'TASK_RESUMED':
      return { speaker: 'pm', text: `대표가 재개했습니다${p.note ? `: ${str(p.note)}` : ''}` };
    case 'APPROVAL_RESULT':
      return p.decision === 'APPROVE'
        ? { speaker: 'pm', text: '대표가 승인했습니다 → 완료되었습니다' }
        : { speaker: 'pm', text: `대표가 반려했습니다${p.reason ? `: ${str(p.reason)}` : ''}` };
    case 'NOTE_PUBLISHED':
      return { speaker: 'agent', text: `인계 노트를 남겼습니다 — ${str(p.title)}` };
    default:
      return null;
  }
}

export function renderFeedRow(row: FeedRow): RoomMessage | null {
  const base = { id: `${row.tsMicros}.${row.source}.${row.id}`, ts: row.ts, type: row.type, taskId: row.taskId, taskTitle: row.taskTitle };
  if (row.source === 'a') {
    const toText = ACTIVITY_TEXT[row.type] ?? ACTIVITY_TEXT.other!;
    return { ...base, type: `ACTIVITY_${row.type.toUpperCase()}`, speaker: 'agent', text: toText(str(row.payload.target)) };
  }
  const rendered = eventText(row);
  return rendered === null ? null : { ...base, ...rendered };
}

// 커서 문자열("<마이크로초>.<e|a>.<id>")을 되돌린다. 형식이 틀리면 null(→ 400).
export function parseCursor(raw: string): { tsMicros: string; source: 'e' | 'a'; id: string } | null {
  const m = /^(\d{1,20})\.([ea])\.(\d{1,20})$/.exec(raw);
  return m ? { tsMicros: m[1]!, source: m[2] as 'e' | 'a', id: m[3]! } : null;
}
