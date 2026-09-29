// 노트 종류는 이 네 개로 고정이다. 늘리면 노트가 자유 서식 게시판이 된다.
export const NOTE_KINDS = ['IMPLEMENTED', 'DECIDED', 'GOTCHA', 'DEVIATION'] as const;

export type NoteKind = (typeof NOTE_KINDS)[number];

// 제목은 사람이 읽는다. 서버가 조립하므로 라벨도 서버가 가진다.
export const NOTE_KIND_LABEL: Record<NoteKind, string> = {
  IMPLEMENTED: '구현 완료',
  DECIDED: '결정 사항',
  GOTCHA: '주의 사항',
  DEVIATION: '명세 이탈',
};

// 노트 한 건의 크기 상한. DB CHECK와 앱 검증이 같은 숫자를 봐야 하므로 여기 한 곳에만 둔다.
export const NOTE_LIMITS = {
  headline: 60,
  keyPointCount: { min: 1, max: 5 },
  keyPoint: 120,
  // headline + key_points 합계. affects는 포함하지 않는다.
  budget: 700,
  affectsCount: 10,
  affects: 200,
} as const;
