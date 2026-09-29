import { withTransaction, type Queryable } from '../../config/db.js';
import { AppError } from '../../errors.js';
import { hashObject } from '../../utils/canonical-json.js';
import { appendEvent } from '../events/append.js';
import { violatedConstraint } from '../pg-errors.js';
import { recomputeProjectPolicyHash } from '../policy/policy-hash.js';
import type { TeamRole } from '../roles.js';
import {
  copyPoliciesFromCatalog,
  deleteProjectMember,
  findAgentOrg,
  findOtherActiveAssignment,
  findOrgConstitution,
  findProjectById,
  findReposByIds,
  findReposInActiveProjects,
  findReposWithoutOwnership,
  insertProject,
  insertProjectMember,
  linkProjectRepos,
  listProjectMembers,
  listProjectRepos,
  listProjectsByOrg,
  type AutonomyPreset,
  type Project,
  type ProjectMember,
  type RepoRow,
} from './repository.js';

const PRESETS: readonly AutonomyPreset[] = ['L1', 'L2', 'L3', 'L4'];

export type Actor = { userId: string; orgId: string; orgRole: string };

export type CreateProjectInput = {
  name: string;
  autonomyPreset: string;
  pmBudgetUsd: number;
  budgetUsd?: number;
  deadline?: string;
  repoIds: string[];
};

export type ProjectDetail = {
  project: Project;
  repos: RepoRow[];
  members: ProjectMember[];
};

// 어휘 위반은 형식 오류(zod 400)와 구분해 422로 답한다 — 무엇이 허용되는지 함께 알려준다.
function assertPreset(value: string): AutonomyPreset {
  if (!PRESETS.includes(value as AutonomyPreset)) {
    throw new AppError('INVALID_AUTONOMY_PRESET', `autonomyPreset must be one of ${PRESETS.join(', ')}`);
  }
  return value as AutonomyPreset;
}

// 없음(404)과 남의 조직(403)을 구분한다 — repo/service.ts의 assertRepoInOrg와 같은 규칙.
async function assertProjectInOrg(db: Queryable, orgId: string, projectId: string): Promise<Project> {
  const project = await findProjectById(db, projectId);
  if (!project) throw new AppError('PROJECT_NOT_FOUND', `project ${projectId} not found`);
  if (project.orgId !== orgId) throw new AppError('CROSS_ORG_ACCESS', 'cannot access another organization');
  return project;
}

// G1(started_at) 이후에는 멤버 구성을 바꿀 수 없다. 도중에 바뀌면 실험 통제가 흔들린다.
function assertNotStarted(project: Project): void {
  if (project.startedAt !== null) {
    throw new AppError('PROJECT_STARTED', 'project has started; members are frozen');
  }
}

export async function createProject(
  orgId: string,
  actorUserId: string,
  input: CreateProjectInput,
): Promise<ProjectDetail> {
  const preset = assertPreset(input.autonomyPreset);
  const repoIds = [...new Set(input.repoIds)];

  return withTransaction(async (tx) => {
    // 레포가 전부 이 조직 것인지 먼저 본다.
    const repos = await findReposByIds(tx, repoIds);
    const found = new Set(repos.map((r) => r.id));
    const missing = repoIds.find((id) => !found.has(id));
    if (missing !== undefined) throw new AppError('REPO_NOT_FOUND', `repository ${missing} not found`);
    if (repos.some((r) => r.orgId !== orgId)) {
      throw new AppError('CROSS_ORG_ACCESS', 'cannot access another organization');
    }

    // 같은 레포를 두 활성 프로젝트가 쓰면 경로 소유권이 두 곳에 걸린다.
    // DB 제약으로는 표현할 수 없어(부분 유니크로도 status 조인이 안 된다) 여기서 막는다.
    const conflicts = await findReposInActiveProjects(tx, repoIds);
    const clash = conflicts[0];
    if (clash) {
      throw new AppError(
        'REPO_IN_ACTIVE_PROJECT',
        `repository ${clash.repoId} is already used by project ${clash.projectId}`,
      );
    }

    // 소유 역할이 하나도 지정되지 않은 레포는 받지 않는다. 소유 역할은 상속되고 상속할 게 없으면 기본 거부(B-2)이므로,
    // 그대로 투입하면 그 레포에는 아무도 쓸 수 없다 — 태스크를 잡아도 제출이 전부 막히고, 원인은 제출 시점에야 드러난다.
    // 프로젝트를 만드는 시점에 무엇을 먼저 해야 하는지 알려준다(레포 연결은 팀원도 할 수 있으므로 흔히 빠진다).
    // 막힌 레포를 전부 알려준다 — 하나씩 고치고 다시 부르게 만들지 않는다.
    const unowned = await findReposWithoutOwnership(tx, repoIds);
    if (unowned.length > 0) {
      const where = unowned.map((id) => `PATCH /api/repos/${id}/paths/:pathId`).join(', ');
      throw new AppError('REPO_OWNERSHIP_NOT_SET', `레포의 경로 소유권을 먼저 지정하세요. ${where}`);
    }

    // 조직 헌법을 이 시점 사본으로 고정한다. org 쪽이 나중에 바뀌어도 과거 판정 근거는 남아야 한다.
    const constitution = await findOrgConstitution(tx, orgId);
    const constitutionHash = hashObject(constitution);

    const project = await insertProject(tx, {
      orgId,
      name: input.name,
      autonomyPreset: preset,
      pmBudgetUsd: input.pmBudgetUsd,
      budgetUsd: input.budgetUsd ?? null,
      deadline: input.deadline ?? null,
      constitution,
      constitutionHash,
      createdBy: actorUserId,
    });

    await linkProjectRepos(tx, project.id, repoIds);
    await copyPoliciesFromCatalog(tx, project.id, preset);

    // 경로 규칙·정책 사본·헌법이 모두 자리잡은 뒤에야 해시가 의미를 가진다.
    const policyHash = await recomputeProjectPolicyHash(tx, project.id);

    await appendEvent(tx, {
      orgId,
      projectId: project.id,
      type: 'PROJECT_CREATED',
      onBehalfOf: actorUserId,
      policyHash,
      payload: {
        name: project.name,
        autonomyPreset: preset,
        pmBudgetUsd: project.pmBudgetUsd,
        repoIds,
        policyHash,
        constitutionHash,
      },
    });

    return {
      project: { ...project, policyHash },
      repos: await listProjectRepos(tx, project.id),
      members: [],
    };
  });
}

export async function assignMember(
  actor: Actor,
  projectId: string,
  agentId: string,
  teamRole: TeamRole,
): Promise<ProjectMember[]> {
  return withTransaction(async (tx) => {
    const project = await assertProjectInOrg(tx, actor.orgId, projectId);
    assertNotStarted(project);

    // 에이전트도 같은 조직이어야 한다. 없는 id도 여기서 걸린다.
    const agentOrg = await findAgentOrg(tx, agentId);
    if (agentOrg !== actor.orgId) {
      throw new AppError('AGENT_NOT_IN_ORG', `agent ${agentId} does not belong to this organization`);
    }

    // 에이전트 토큰은 project_id를 하나만 담는다(findAgentMembership이 가장 최근 것을 고른다).
    // 두 진행 중 프로젝트에 배정되면 먼저 배정된 쪽은 조용히 쓸 수 없게 되므로 여기서 막는다.
    const other = await findOtherActiveAssignment(tx, agentId, projectId);
    if (other !== null) {
      throw new AppError(
        'AGENT_IN_ANOTHER_PROJECT',
        `agent ${agentId} is already assigned to active project ${other}; unassign it there first`,
      );
    }

    try {
      await insertProjectMember(tx, projectId, agentId, teamRole);
    } catch (err) {
      const constraint = violatedConstraint(err);
      if (constraint === 'uq_project_members_role') {
        throw new AppError('ROLE_ALREADY_ASSIGNED', `${teamRole} is already assigned in this project`);
      }
      if (constraint === 'project_members_pkey') {
        throw new AppError('AGENT_ALREADY_ASSIGNED', 'this agent is already a member of the project');
      }
      throw err;
    }

    await appendEvent(tx, {
      orgId: actor.orgId,
      projectId,
      type: 'MEMBER_ASSIGNED',
      actorAgentId: agentId,
      onBehalfOf: actor.userId,
      policyHash: project.policyHash,
      payload: { agentId, teamRole },
    });

    return listProjectMembers(tx, projectId);
  });
}

export async function unassignMember(
  actor: Actor,
  projectId: string,
  agentId: string,
): Promise<ProjectMember[]> {
  return withTransaction(async (tx) => {
    const project = await assertProjectInOrg(tx, actor.orgId, projectId);
    assertNotStarted(project);

    // 역할 교체는 삭제 후 재배정으로 한다 — UPDATE 경로를 두면 한 역할에 둘이 잠깐 겹칠 수 있다.
    const teamRole = await deleteProjectMember(tx, projectId, agentId);
    if (teamRole === null) {
      throw new AppError('MEMBER_NOT_FOUND', `agent ${agentId} is not a member of this project`);
    }

    await appendEvent(tx, {
      orgId: actor.orgId,
      projectId,
      type: 'MEMBER_UNASSIGNED',
      actorAgentId: agentId,
      onBehalfOf: actor.userId,
      policyHash: project.policyHash,
      payload: { agentId, teamRole },
    });

    return listProjectMembers(tx, projectId);
  });
}

export async function getProject(actor: Actor, projectId: string): Promise<ProjectDetail> {
  return withTransaction(async (tx) => {
    const project = await assertProjectInOrg(tx, actor.orgId, projectId);
    const members = await listProjectMembers(tx, projectId);

    // 대표이거나, 이 프로젝트에 배정된 에이전트의 주인이어야 본다.
    if (actor.orgRole !== 'REPRESENTATIVE' && !members.some((m) => m.userId === actor.userId)) {
      throw new AppError('NOT_PROJECT_MEMBER', 'you are not a member of this project');
    }

    return { project, repos: await listProjectRepos(tx, projectId), members };
  });
}

// GET /api/orgs/:orgId/projects — 대표는 조직 전체, 팀원은 자기 에이전트가 배정된 프로젝트만.
// 팀원이 자기 프로젝트 id를 알 수 있는 유일한 경로다.
export async function listProjects(actor: Actor): Promise<Project[]> {
  return withTransaction(async (tx) =>
    listProjectsByOrg(tx, actor.orgId, actor.orgRole === 'REPRESENTATIVE' ? null : actor.userId),
  );
}
