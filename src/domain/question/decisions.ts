import type { Queryable } from '../../config/db.js';
import type { TeamRole } from '../roles.js';
import { listDecisionRows, type AnswerSource, type DecisionRow, type QuestionStatus } from './repository.js';
import type { QuestionTarget } from './router.js';

// 질문으로 정해진 결정 — AskUserQuestion의 답을 질문한 태스크 밖으로 꺼낸다.
//
// FE가 "목록 페이지 크기?"를 묻고 BE 담당이 코드에 없던 "20개"를 새로 정하면, 그 결정은 원래 질문한 태스크에만 갔다
// (같은 실행의 답 또는 재개 브리핑의 answeredQuestions). 그 API를 만드는 BE 구현 태스크는 몰랐다.
// 그래서 (1) 사람이 결정을 인계 노트처럼 보고(GET /projects/:id/decisions — 전부), (2) 그 결정이 필요한 다른 태스크에 인계 노트와 같은
// 두 겹으로 전달한다 — 시작할 때 브리핑(decisions), 제출할 때 확인(DECISIONS_UNACKNOWLEDGED). 실행 중인 모델에는 끼워 넣지 않는다.
// 전달 범위는 selectDecisionsForTask에 적었다(PM 대상은 전부, FE·BE 대상은 같은 명세만).
//
// 고르는 함수는 여기 한 벌(selectDecisions)이다. 조회 API·브리핑·제출 확인이 같은 함수를 쓴다 —
// 브리핑으로 준 결정과 제출 때 요구하는 결정이 같은 규칙에서 나와야 "받았다"가 성립한다(노트의 selectNotesForTask와 같은 이유).

// "확정된 결정" = 사람이 정한 답(answerSource human·agent_confirmed·human_override). 전달 대상은 이것뿐이다.
// agent_answered(상담 실행이 코드·명세에서 찾은 답)는 뺀다 — 이미 코드에 있는 것이라 전할 새 결정이 아니다(조회 API에는 나온다).
export const CONFIRMED_DECISION_STATUSES: readonly QuestionStatus[] = ['answered'];
// 조회 API의 기본 범위 — 답이 있는 것(사람이 정한 것 + 에이전트가 코드에서 찾은 것).
export const ANSWERED_DECISION_STATUSES: readonly QuestionStatus[] = ['answered', 'agent_answered'];
export const ALL_DECISION_STATUSES: readonly QuestionStatus[] = ['pending', 'agent_answered', 'answered', 'expired', 'self_owned'];

export type DecidedBy =
  | { kind: 'user'; userId: string; nickname: string | null; isRepresentative: boolean }
  | { kind: 'agent'; agentId: string; agentName: string | null };

// 한 줄 = 질문 문장 하나. 한 질문 행에 질문이 여러 개면 여러 줄로 펼친다.
export type QuestionDecision = {
  // "<questionId>:<질문 인덱스>" — 제출 확인(acknowledgedDecisionIds)의 단위.
  id: string;
  questionId: string;
  taskId: string;
  taskTitle: string;
  askedAt: string;
  askerRole: TeamRole;
  askedByAgentName: string;
  targetRole: QuestionTarget;
  routedBy: string;
  question: string;
  header: string | null;
  options: string[];
  multiSelect: boolean;
  answer: string | null;
  answerSource: AnswerSource | null;
  decidedBy: DecidedBy | null;
  draftAnswer: string | null;
  answeredAt: string | null;
  status: QuestionStatus;
  summary: string;
};

export function decisionId(questionId: string, index: number): string {
  return `${questionId}:${index}`;
}

const ROLE_SHORT: Record<QuestionTarget, string> = { FRONTEND: 'FE', BACKEND: 'BE', PM: 'PM' };

const SUMMARY_PART_MAX = 80;
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_PART_MAX ? `${flat.slice(0, SUMMARY_PART_MAX - 1)}…` : flat;
}

// 한 줄 요약은 서버가 조립한다(인계 노트 제목과 같은 이유 — 화면마다 다르게 만들면 같은 결정이 다르게 읽힌다).
// 예: "FE가 물음 · BE 담당 홍길동이 정함 — 스터디 목록 페이지 크기 → 20개"
export function buildDecisionSummary(d: Omit<QuestionDecision, 'summary'>): string {
  const asker = `${ROLE_SHORT[d.askerRole]}가 물음`;
  const target = ROLE_SHORT[d.targetRole];
  let who: string;
  if (d.decidedBy?.kind === 'user') {
    const name = d.decidedBy.nickname ?? '(이름 없음)';
    const person = d.decidedBy.isRepresentative ? `대표 ${name}` : `${target} 담당 ${name}`;
    who =
      d.answerSource === 'agent_confirmed'
        ? `${person}이 확인함`
        : d.answerSource === 'human_override'
          ? `${person}이 정함(에이전트 답을 바꿈)`
          : `${person}이 정함`;
  } else if (d.decidedBy?.kind === 'agent') {
    who = `${target} 에이전트 ${d.decidedBy.agentName ?? '(이름 없음)'}가 코드에서 찾음`;
  } else if (d.status === 'pending') {
    who = `${target} 답 대기`;
  } else if (d.status === 'expired') {
    who = `${target} 답 없이 만료`;
  } else {
    who = '스스로 정하도록 돌려보냄';
  }
  const topic = oneLine(d.header ?? d.question);
  return `${asker} · ${who} — ${topic}${d.answer === null ? '' : ` → ${oneLine(d.answer)}`}`;
}

function expand(row: DecisionRow): QuestionDecision[] {
  const q = row.question;
  const decidedBy: DecidedBy | null =
    q.status === 'answered' && q.answeredBy
      ? { kind: 'user', userId: q.answeredBy, nickname: row.answeredByNickname, isRepresentative: row.answeredByIsRepresentative }
      : q.status === 'agent_answered' && q.draftedByAgentId
        ? { kind: 'agent', agentId: q.draftedByAgentId, agentName: row.draftedByAgentName }
        : null;
  return q.questions.map((asked, index) => {
    const base = {
      id: decisionId(q.id, index),
      questionId: q.id,
      taskId: q.taskId,
      taskTitle: row.taskTitle,
      askedAt: q.createdAt,
      askerRole: q.askerRole,
      askedByAgentName: row.askedByAgentName,
      targetRole: q.targetRole,
      routedBy: q.routedBy,
      question: asked.question,
      header: asked.header ?? null,
      options: asked.options.map((o) => o.label),
      multiSelect: asked.multiSelect ?? false,
      answer: q.answers?.[asked.question] ?? null,
      answerSource: q.answerSource,
      decidedBy,
      draftAnswer: q.draft?.answers[asked.question] ?? null,
      answeredAt: q.answeredAt,
      status: q.status,
    };
    return { ...base, summary: buildDecisionSummary(base) };
  });
}

export type DecisionFilter = {
  statuses: readonly QuestionStatus[];
  role?: QuestionTarget | null;
  taskId?: string | null;
  // 이 태스크에 전달할 범위로 좁힌다(selectDecisionsForTask). 없으면 프로젝트 전부(조회 API).
  deliverToTaskId?: string | null;
  order: 'oldest' | 'newest';
  // 결정(줄) 개수 상한. null이면 전부.
  limit: number | null;
};

// 유일한 선택 함수. 정렬 기준은 답한 시각(없으면 질문 시각)이고, 한 질문 행 안에서는 질문 순서를 지킨다.
export async function selectDecisions(db: Queryable, projectId: string, filter: DecisionFilter): Promise<QuestionDecision[]> {
  const rows = await listDecisionRows(db, {
    projectId,
    statuses: filter.statuses,
    role: filter.role ?? null,
    taskId: filter.taskId ?? null,
    deliverToTaskId: filter.deliverToTaskId ?? null,
    order: filter.order,
    // 한 행이 적어도 한 줄이므로 행을 limit개까지만 읽어도 줄이 모자라지 않는다.
    limit: filter.limit,
  });
  const decisions = rows.flatMap(expand);
  return filter.limit === null ? decisions : decisions.slice(0, filter.limit);
}

// 이 태스크에 전달할 결정(오래된 것부터). 브리핑(decisions)과 제출 확인(DECISIONS_UNACKNOWLEDGED)이 둘 다 이 함수를 쓴다.
// 범위는 질문 대상으로 나눈다(조건은 repository의 SQL 한 곳 — 브리핑과 제출 확인이 갈리지 않게):
//   - targetRole = PM → 프로젝트의 모든 태스크(명세 없는 태스크 포함). 제품 정책·요구사항은 기능을 가리지 않는다.
//   - targetRole = FRONTEND·BACKEND → 질문한 태스크와 spec_id가 같은 태스크만(둘 다 있을 때만). 명세 없는 태스크가 물은 FE·BE 결정은 전달하지 않는다.
//   - 어느 쪽이든 질문한 태스크 자신은 뺀다(이미 answeredQuestions로 받는다).
// 왜 전부가 아닌가: 전부 전달하면 결정 하나마다 실행 중인 모든 태스크가 제출 때 409 왕복을 겪는다 — 질문을 일부러 많이 만드는
// 실험에서 비용이 크다. FE·BE 구현 결정이 필요한 쪽은 같은 기능의 상대 태스크다(인계 노트의 "같은 명세" 기준).
// PM 결정은 정책이라 전부가 알아야 하고, 대표가 확정하는 것이라 드물어 전체 전달의 왕복 비용이 작다.
export async function selectDecisionsForTask(db: Queryable, projectId: string, taskId: string): Promise<QuestionDecision[]> {
  return selectDecisions(db, projectId, { statuses: CONFIRMED_DECISION_STATUSES, deliverToTaskId: taskId, order: 'oldest', limit: null });
}
