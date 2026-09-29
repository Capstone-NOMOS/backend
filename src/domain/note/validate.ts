import { NOTE_LIMITS } from './kinds.js';
import type { NoteKind } from './kinds.js';

// 위반은 자르지 않고 전부 되돌려준다. "몇 번째 항목이 몇 자인지"를 모르면
// 에이전트가 무엇을 줄여야 할지 알 수 없고, 결국 같은 요청을 반복한다.
export type NoteViolation = {
  field: 'headline' | 'keyPoints' | 'affects' | 'budget' | 'kind' | 'supersedes';
  index?: number;
  length?: number;
  limit?: number;
  message: string;
};

export type NoteShapeInput = {
  kind: NoteKind;
  headline: string;
  keyPoints: string[];
  affects: string[];
};

const NEWLINE = /[\n\r]/;
const HEADING = /^[ \t]*#/;

// 줄바꿈과 마크다운 머리표를 막는 이유는 같다. 둘 다 한 항목에 문단을 밀어넣는 수단이고,
// 그러면 길이 제한이 형식만 남는다.
function checkProse(value: string, field: NoteViolation['field'], index?: number): NoteViolation[] {
  const out: NoteViolation[] = [];
  if (NEWLINE.test(value)) {
    out.push({ field, index, message: '줄바꿈을 넣을 수 없습니다' });
  }
  if (HEADING.test(value)) {
    out.push({ field, index, message: '마크다운 머리표(#)로 시작할 수 없습니다' });
  }
  return out;
}

export function validateNoteShape(input: NoteShapeInput): NoteViolation[] {
  const violations: NoteViolation[] = [];

  if (input.headline.length > NOTE_LIMITS.headline) {
    violations.push({
      field: 'headline',
      length: input.headline.length,
      limit: NOTE_LIMITS.headline,
      message: `headline은 ${NOTE_LIMITS.headline}자 이하여야 합니다`,
    });
  }
  violations.push(...checkProse(input.headline, 'headline'));

  const { min, max } = NOTE_LIMITS.keyPointCount;
  if (input.keyPoints.length < min || input.keyPoints.length > max) {
    violations.push({
      field: 'keyPoints',
      length: input.keyPoints.length,
      limit: max,
      message: `key_points는 ${min}~${max}개여야 합니다`,
    });
  }
  input.keyPoints.forEach((point, index) => {
    if (point.length > NOTE_LIMITS.keyPoint) {
      violations.push({
        field: 'keyPoints',
        index,
        length: point.length,
        limit: NOTE_LIMITS.keyPoint,
        message: `key_points[${index}]은 ${NOTE_LIMITS.keyPoint}자 이하여야 합니다`,
      });
    }
    violations.push(...checkProse(point, 'keyPoints', index));
  });

  // 700자는 headline + key_points 합계다. affects는 별도로 세지 않는다 —
  // 영향 경로를 적는 걸 길이 예산과 경쟁시키면 보고를 줄이는 방향으로 압력이 생긴다.
  const budgetUsed = input.headline.length + input.keyPoints.reduce((sum, p) => sum + p.length, 0);
  if (budgetUsed > NOTE_LIMITS.budget) {
    violations.push({
      field: 'budget',
      length: budgetUsed,
      limit: NOTE_LIMITS.budget,
      message: `headline과 key_points 합계는 ${NOTE_LIMITS.budget}자 이하여야 합니다`,
    });
  }

  if (input.affects.length > NOTE_LIMITS.affectsCount) {
    violations.push({
      field: 'affects',
      length: input.affects.length,
      limit: NOTE_LIMITS.affectsCount,
      message: `affects는 ${NOTE_LIMITS.affectsCount}개 이하여야 합니다`,
    });
  }
  input.affects.forEach((entry, index) => {
    if (entry.length > NOTE_LIMITS.affects) {
      violations.push({
        field: 'affects',
        index,
        length: entry.length,
        limit: NOTE_LIMITS.affects,
        message: `affects[${index}]은 ${NOTE_LIMITS.affects}자 이하여야 합니다`,
      });
    }
  });

  // 명세를 벗어났다고 알리면서 어디가 영향받는지 안 적으면 받는 쪽이 할 수 있는 게 없다.
  if (input.kind === 'DEVIATION' && input.affects.length === 0) {
    violations.push({ field: 'kind', message: 'DEVIATION은 affects가 최소 1개 필요합니다' });
  }

  return violations;
}

// 과실 주장 판별. 자연어로 심사하지 않는다(P2) — 다른 에이전트의 이름이나 id 문자열이
// 들어 있는지만 본다. 구조로 막고, 판단이 필요한 건 raise_dispute로 보낸다.
export type MentionTarget = { field: NoteViolation['field']; index?: number; text: string };

export function findForeignAgentMentions(
  targets: MentionTarget[],
  others: { ids: string[]; names: string[] },
): NoteViolation[] {
  const needles = [...others.ids, ...others.names].filter((n) => n.length > 0);
  const violations: NoteViolation[] = [];

  for (const target of targets) {
    const hit = needles.find((needle) => target.text.includes(needle));
    if (hit !== undefined) {
      violations.push({
        field: target.field,
        ...(target.index === undefined ? {} : { index: target.index }),
        message:
          `다른 에이전트(${hit})를 지목할 수 없습니다. ` +
          '다른 에이전트의 작업에 대한 주장은 raise_dispute로 제기하세요',
      });
    }
  }

  return violations;
}
