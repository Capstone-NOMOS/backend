import type { Queryable } from '../../config/db.js';
import { AppError } from '../../errors.js';
import { findProjectById, listProjectMembers } from './repository.js';

// 사람 토큰으로 프로젝트 안을 들여다보는 요청의 맥락.
// 에이전트의 AgentContext와 달리 토큰에 project_id가 없으므로 매 요청 멤버십을 확인한다.
export type UserContext = { userId: string; orgId: string; orgRole: string };

// "이 사람이 이 프로젝트를 볼 수 있는가"의 정의를 한 곳에 둔다.
// 태스크 목록·산출물 목록·인계 노트가 같은 질문을 하므로, 흩어지면 한 곳만 느슨해진다.
//
// 대표는 조직의 모든 프로젝트를, 팀원은 자기 에이전트가 배정된 프로젝트만 본다.
// 없음(404)과 남의 조직(403)을 구분하는 것은 repo/service.ts의 assertRepoInOrg와 같은 규칙이다.
export async function assertProjectVisibleToUser(
  db: Queryable,
  actor: UserContext,
  projectId: string,
): Promise<void> {
  const project = await findProjectById(db, projectId);
  if (!project) throw new AppError('PROJECT_NOT_FOUND', `project ${projectId} not found`);
  if (project.orgId !== actor.orgId) {
    throw new AppError('CROSS_ORG_ACCESS', 'cannot access another organization');
  }
  if (actor.orgRole === 'REPRESENTATIVE') return;

  const members = await listProjectMembers(db, projectId);
  if (!members.some((m) => m.userId === actor.userId)) {
    throw new AppError('NOT_PROJECT_MEMBER', 'you are not a member of this project');
  }
}
