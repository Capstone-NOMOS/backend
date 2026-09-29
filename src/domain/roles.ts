// 팀 역할의 유일한 정의. zod 스키마·타입·CHECK 제약이 모두 이 목록을 따른다.
// QA는 전면 삭제되었다 — 여기에 다시 추가하지 말 것.
export const TEAM_ROLES = ['FRONTEND', 'BACKEND'] as const;

export type TeamRole = (typeof TEAM_ROLES)[number];

// 사람에게 보이는 이름. 인계 노트 제목을 서버가 조립할 때 쓴다.
export const TEAM_ROLE_LABEL: Record<TeamRole, string> = {
  FRONTEND: '프론트엔드',
  BACKEND: '백엔드',
};
