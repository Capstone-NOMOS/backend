import { TEAM_ROLE_LABEL, type TeamRole } from '../roles.js';
import { NOTE_KIND_LABEL, type NoteKind } from './kinds.js';

export type NoteTitleInput = {
  seq: number;
  teamRole: TeamRole;
  featureKey: string | null;
  kind: NoteKind;
  headline: string | null;
};

// 제목은 서버가 조립한다. 에이전트가 직접 쓰게 하면 곧 제목에 본문을 넣는다.
// 형식: #{seq} - {역할} {feature_key} {종류} — {headline}
// 구분자를 '—'로 둔 이유는 '·'가 key_points 사이 구분자로 이미 쓰여 눈에 덜 띄기 때문이다.
export function buildNoteTitle(input: NoteTitleInput): string {
  const head = [
    `#${input.seq}`,
    '-',
    TEAM_ROLE_LABEL[input.teamRole],
    // 명세에 매이지 않은 노트(통합 작업 등)는 feature_key가 없다.
    ...(input.featureKey ? [input.featureKey] : []),
    NOTE_KIND_LABEL[input.kind],
  ].join(' ');

  const headline = input.headline?.trim();
  return headline ? `${head} — ${headline}` : head;
}
