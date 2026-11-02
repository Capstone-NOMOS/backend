import { logger } from '../../config/logger.js';

// "실험 모드 프로젝트의 상태가 바뀌었을 수 있다 — 자동으로 통과시킬 것이 있는지 다시 봐라"는 신호(034, domain/experiment/autopilot.ts가 받는다).
// tasks-changed와 같은 모양이다: 도메인 서비스는 자동 경로를 모르고 여기에 알리기만 한다(순환 import 없이). **커밋한 뒤에** 부른다.
// 무엇이 바뀌었는지는 싣지 않는다 — 받는 쪽이 프로젝트 상태를 다시 읽어 판정하므로 놓치거나 겹쳐도 결과가 같다(놓친 것은 주기 정리가 메운다).
// 기본 모드 프로젝트에 불려도 받는 쪽이 question_mode를 보고 아무것도 하지 않는다.

type Listener = (projectId: string) => void;

const listeners = new Set<Listener>();

export function onExperimentNudge(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function experimentNudge(projectId: string): void {
  for (const listener of listeners) {
    try {
      listener(projectId);
    } catch (err) {
      logger.warn('experiment nudge listener failed', { projectId, error: String(err) });
    }
  }
}
