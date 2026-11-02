import { questionsChanged } from '../dispatch/questions-changed.js';
import type { QuestionMode } from '../project/repository.js';
import { scheduleAutoAnswer } from './auto-answer.js';
import { schedulePmDraft } from './pm-draft.js';
import type { AgentQuestion } from './repository.js';
import type { RoutedResult } from './router-registry.js';
import { PM_TARGET, type RoutingInput } from './router.js';
import { recordRouting } from './routing-eval.js';

// 질문이 커밋된 뒤 할 일 — 구현 단계(에이전트의 AskUserQuestion)와 기획 단계(기능 명세·계약 초안의 질문)가 한 벌을 쓴다.
//   ① 라우팅 평가 기록(실제로 보낸 판정 + 그림자 라우터) — 질문 흐름을 기다리게 하지 않는다.
//   ② 일반 모드: 대상 역할 Executor를 깨워 상담 실행을 맡기고(questionsChanged), PM 소관이면 PM 답 초안을 쓴다.
//      기능 명세 초안의 질문은 PM이 물은 것이라 PM 답 초안을 쓰지 않는다(묻는 쪽이 자기 질문에 답하게 된다) — 대표가 직접 답한다.
//   ③ 실험 모드(033): 상담·PM 초안을 만들지 않고, ①이 끝난 뒤 첫 번째 선택지로 자동 답한다.
export function afterQuestionAsked(question: AgentQuestion, input: RoutingInput, routed: RoutedResult, project: { orgId: string; questionMode: QuestionMode }): void {
  const recorded = recordRouting(question.id, input, routed);
  if (question.status !== 'pending') return;
  if (project.questionMode === 'experiment') {
    scheduleAutoAnswer(question.id, project.orgId, recorded);
    return;
  }
  questionsChanged(question.projectId, question.targetRole);
  if (question.targetRole === PM_TARGET && question.stage !== 'feature_spec') schedulePmDraft(question.id, project.orgId);
}
