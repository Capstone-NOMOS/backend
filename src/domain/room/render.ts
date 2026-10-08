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
    case 'TASK_DISPATCHED': {
      const attempt = num(p.attempt);
      return attempt === 0
        ? { speaker: 'pm', text: `${title} 실행해 주세요` }
        : { speaker: 'pm', text: `${title} 다시 실행해 주세요 (재시도 ${attempt}/${MAX_RETRIES})` };
    }
    case 'TASK_CLAIMED':
      return { speaker: 'nomos', text: `태스크 수령 — ${title}` };
    case 'AGENT_RUN_STARTED':
      return { speaker: 'nomos', text: '구현을 시작합니다' };
    case 'AGENT_RUN_ENDED': {
      const seconds = Math.round(num(p.durationMs) / 1000);
      if (p.submitted === true) return { speaker: 'nomos', text: `실행을 마쳤습니다 (${seconds}초)` };
      switch (str(p.outcome)) {
        case 'timeout':
          return { speaker: 'nomos', text: `시간 제한을 넘겨 중단했습니다 (${seconds}초) — 제출하지 않았습니다` };
        case 'failed':
          return { speaker: 'nomos', text: `비정상 종료했습니다 (exit ${p.exitCode ?? '?'}) — 제출하지 않았습니다` };
        default:
          return {
            speaker: 'nomos',
            text: p.committed === true ? '실행이 끝났지만 제출하지 않았습니다' : '실행이 끝났지만 커밋이 없어 제출하지 않았습니다',
          };
      }
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
          return { speaker: 'pm', text: `검증 중 — ${stages}` };
      }
    }
    case 'APPROVAL_REQUESTED':
      return { speaker: 'pm', text: '대표 승인이 필요합니다' };
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
