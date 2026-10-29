import type { NotificationRow } from './repository.js';

// 받은 편지함 문장은 서버가 만든다(룸 피드 render.ts와 같은 이유 — 화면마다 다르게 만들지 않게).
// 질문 내용·답은 요약 한 줄만 싣는다. 전체는 화면이 questionId로 GET /projects/:id/questions(또는 /decisions)를 읽는다 —
// 여기에 다 실으면 "누가 이 질문을 볼 수 있나"의 판정이 두 벌이 된다.

export type NotificationType = 'task_done' | 'question_answered' | 'question_asked';

const ROLE_SHORT: Record<string, string> = { FRONTEND: 'FE', BACKEND: 'BE', PM: 'PM' };
const SUMMARY_MAX = 60;

export function roleShort(role: string | null): string {
  return role === null ? '' : (ROLE_SHORT[role] ?? role);
}

// 받침이 있으면 '이', 없으면 '가'(한글이 아니면 '이(가)').
export function subjectParticle(word: string): string {
  const last = word.charCodeAt(word.length - 1);
  if (Number.isNaN(last) || last < 0xac00 || last > 0xd7a3) return '이(가)';
  return (last - 0xac00) % 28 === 0 ? '가' : '이';
}

export function clip(text: string, max = SUMMARY_MAX): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

// 담당자를 부르는 말 — "BE 담당 민수".
function ownerName(role: string | null, nickname: string | null): string {
  const r = roleShort(role);
  return [r ? `${r} 담당` : '담당', nickname].filter(Boolean).join(' ');
}

function withSubject(name: string): string {
  return `${name}${subjectParticle(name)}`;
}

// 첫 질문(+ 외 N개).
export function firstQuestion(questions: { question: string }[] | null): string {
  const list = questions ?? [];
  const head = list[0] ? clip(list[0].question) : '';
  return list.length > 1 ? `${head} 외 ${list.length - 1}개` : head;
}

// 첫 질문 → 답(+ 외 N개).
function firstAnswer(questions: { question: string }[] | null, answers: Record<string, string> | null): string {
  const list = questions ?? [];
  const head = list[0];
  if (!head) return '';
  const answer = answers?.[head.question];
  const pair = answer === undefined ? clip(head.question) : `${clip(head.question, 40)} → ${clip(answer, 40)}`;
  return list.length > 1 ? `${pair} 외 ${list.length - 1}개` : pair;
}

export function notificationTypeOf(eventType: string): NotificationType {
  if (eventType === 'QUESTION_ASKED') return 'question_asked';
  if (eventType === 'QUESTION_ANSWERED' || eventType === 'QUESTION_DRAFTED') return 'question_answered';
  return 'task_done';
}

export function renderNotification(row: NotificationRow): string {
  const title = row.taskTitle ?? '태스크';
  switch (row.type) {
    case 'APPROVAL_RESULT':
      return `${title} — 대표가 승인해 완료됐습니다`;
    case 'VERIFICATION_COMPLETED':
      return `${title} — 검증을 통과해 완료됐습니다`;
    case 'TASK_COMPLETED_MANUALLY':
      return row.actorIsRepresentative
        ? `${title} — 대표가 직접 완료했습니다`
        : `${title} — ${withSubject(ownerName(row.role, row.actorNickname))} 직접 완료했습니다`;
    case 'QUESTION_ANSWERED': {
      const who = row.payload.answeredByRole === 'REPRESENTATIVE' ? '대표가' : withSubject(ownerName(row.targetRole, row.actorNickname));
      return `${who} 답했습니다 — ${firstAnswer(row.questions, row.answers)}`;
    }
    case 'QUESTION_DRAFTED':
      return `${roleShort(row.targetRole)} 에이전트가 코드에서 찾아 답했습니다 — ${firstAnswer(row.questions, row.answers)}`;
    case 'QUESTION_ASKED':
      return `${roleShort(row.askerRole)} 에이전트가 물었습니다 — ${firstQuestion(row.questions)}`;
    default:
      return title;
  }
}
