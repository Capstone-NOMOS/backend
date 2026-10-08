import { pool, withTransaction, type Queryable } from '../../config/db.js';
import { AppError } from '../../errors.js';
import { hashObject } from '../../utils/canonical-json.js';
import { tasksChanged } from '../dispatch/tasks-changed.js';
import { appendEvent } from '../events/append.js';
import type { GithubInviteResult } from '../events/types.js';
import { githubRepApi } from '../github/rep-api.js';
import { findRepresentativeGithubToken } from '../oauth/repository.js';
import { decryptSecret } from '../../utils/secret-box.js';
import { violatedConstraint } from '../pg-errors.js';
import { recomputeProjectPolicyHash } from '../policy/policy-hash.js';
import type { TeamRole } from '../roles.js';
import {
  approveAppliedPlans,
  approveProjectSpecs,
  copyPoliciesFromCatalog,
  deleteProjectMember,
  findAgentOrg,
  findAgentOwnerGithub,
  findOtherActiveAssignment,
  findOrgConstitution,
  findProjectById,
  findReposByIds,
  findRepoUsage,
  findReposWithoutOwnership,
  insertProject,
  insertProjectMember,
  isProjectMember,
  linkProjectRepos,
  listLatestInvites,
  listProjectGithubRepos,
  listProjectMembers,
  listProjectRepos,
  listProjectsByOrg,
  markProjectStarted,
  summarizeProjectTasks,
  updateQuestionRelay,
  type AutonomyPreset,
  type Project,
  type MemberInviteStatus,
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
  // 질문 중계(018). 생략하면 켜짐.
  questionRelay?: boolean;
};

// 응답에 나가는 멤버 — 레포별 마지막 GitHub 초대 결과를 붙인다(초대한 적 없으면 빈 목록).
export type ProjectMemberView = ProjectMember & { githubInvites: MemberInviteStatus[] };

export type ProjectDetail = {
  project: Project;
  repos: RepoRow[];
  members: ProjectMemberView[];
};

async function membersWithInvites(db: Queryable, projectId: string, members?: ProjectMember[]): Promise<ProjectMemberView[]> {
  const list = members ?? (await listProjectMembers(db, projectId));
  const invites = await listLatestInvites(db, projectId);
  return list.map((m) => ({ ...m, githubInvites: invites.get(m.agentId) ?? [] }));
}

// 어휘 위반은 형식 오류(zod 400)와 구분해 422로 답한다 — 무엇이 허용되는지 함께 알려준다.
function assertPreset(value: string): AutonomyPreset {
  if (!PRESETS.includes(value as AutonomyPreset)) {
    throw new AppError('INVALID_AUTONOMY_PRESET', `autonomyPreset must be one of ${PRESETS.join(', ')}`);
  }
  return value as AutonomyPreset;
}

// 없음(404)과 남의 조직(403)을 구분한다 — repo/service.ts의 assertRepoInOrg와 같은 규칙.
async function assertProjectInOrg(
  db: Queryable,
  orgId: string,
  projectId: string,
  lock?: 'share' | 'update',
): Promise<Project> {
  const project = await findProjectById(db, projectId, lock === undefined ? {} : { lock });
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

    // 같은 레포를 두 진행 중 프로젝트가 쓰면 경로 소유권이 두 곳에 걸린다.
    // DB 제약으로는 표현할 수 없어(부분 유니크로도 status 조인이 안 된다) 여기서 막는다.
    // 겹치는 레포를 **전부** 알려준다(details) — 하나씩 고치고 다시 저장하게 하지 않는다. 판정은 레포 목록의 activeProjectId와 같은 함수다.
    const conflicts = await findRepoUsage(tx, repoIds);
    if (conflicts.length > 0) {
      throw new AppError(
        'REPO_IN_ACTIVE_PROJECT',
        `repositories already used by an in-progress project: ${conflicts.map((c) => `${c.fullName} (${c.projectName})`).join(', ')}`,
        conflicts.map((c) => ({ repoId: c.repoId, fullName: c.fullName, projectId: c.projectId, projectName: c.projectName })),
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
      questionRelay: input.questionRelay ?? true,
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
        questionRelay: project.questionRelay,
      },
    });

    return {
      project: { ...project, policyHash },
      repos: await listProjectRepos(tx, project.id),
      members: [],
    };
  });
}

// 프로젝트 설정 변경(대표 전용) — 지금은 질문 중계 스위치뿐. 시작(G1) 전에만 바꿀 수 있다:
// 실행 중에 바뀌면 같은 프로젝트 안에서 "중계 있음/없음" 실행이 섞여 대조 실험이 성립하지 않는다.
export async function updateProjectSettings(actor: Actor, projectId: string, input: { questionRelay: boolean }): Promise<Project> {
  if (actor.orgRole !== 'REPRESENTATIVE') throw new AppError('NOT_REPRESENTATIVE', 'only the representative can change project settings');
  return withTransaction(async (tx) => {
    const project = await assertProjectInOrg(tx, actor.orgId, projectId, 'update');
    if (project.startedAt !== null) throw new AppError('PROJECT_STARTED', 'project has started; settings are frozen');
    if (project.questionRelay === input.questionRelay) return project;
    const updated = await updateQuestionRelay(tx, projectId, input.questionRelay);
    await appendEvent(tx, {
      orgId: actor.orgId,
      projectId,
      type: 'PROJECT_SETTINGS_UPDATED',
      onBehalfOf: actor.userId,
      policyHash: project.policyHash,
      payload: { before: { questionRelay: project.questionRelay }, after: { questionRelay: updated.questionRelay } },
    });
    return updated;
  });
}

export async function assignMember(
  actor: Actor,
  projectId: string,
  agentId: string,
  teamRole: TeamRole,
): Promise<ProjectMemberView[]> {
  return withTransaction(async (tx) => {
    // 시작(G1)과 겹치지 않게 잠근다. 시작이 먼저 잡았으면 끝날 때까지 기다린 뒤 started_at을 본다.
    const project = await assertProjectInOrg(tx, actor.orgId, projectId, 'share');
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

    return membersWithInvites(tx, projectId);
  });
}

// 역할 배정 + 그 에이전트 주인을 프로젝트의 GitHub 레포에 협업자로 자동 초대.
// 배정은 먼저 커밋한다 — 초대는 GitHub 호출이라 트랜잭션에 넣을 수 없고, 초대가 실패해도 배정은 유효하다.
export async function assignMemberWithInvites(
  actor: Actor,
  projectId: string,
  agentId: string,
  teamRole: TeamRole,
): Promise<{ members: ProjectMemberView[]; githubInvites: GithubInviteResult[] }> {
  await assignMember(actor, projectId, agentId, teamRole);
  const githubInvites = await inviteToProjectGithubRepos(actor, projectId, agentId, 'assign');
  // 초대 결과(이벤트)가 남은 뒤에 읽어 멤버 정보에도 들어가게 한다.
  return { members: await membersWithInvites(pool, projectId), githubInvites };
}

// 초대를 다시 보낸다(대표 전용) — 배정 때 멤버가 GitHub를 연결하지 않았거나 GitHub가 실패한 경우.
// 시작(G1) 뒤에도 된다: 멤버 구성을 바꾸는 게 아니라 이미 정해진 멤버에게 접근을 주는 일이다.
export async function retryGithubInvites(actor: Actor, projectId: string, agentId: string): Promise<GithubInviteResult[]> {
  await assertProjectInOrg(pool, actor.orgId, projectId);
  if (!(await isProjectMember(pool, projectId, agentId))) {
    throw new AppError('MEMBER_NOT_FOUND', `agent ${agentId} is not a member of this project`);
  }
  return inviteToProjectGithubRepos(actor, projectId, agentId, 'retry');
}

// 에이전트 주인을 프로젝트의 GitHub 레포마다 협업자(push)로 초대한다. 대표의 GitHub 토큰을 쓴다.
// 실패는 던지지 않고 결과에 적는다 — GitHub 사정이 배정을 멈추면 안 된다. GitHub 레포가 없으면(로컬 데모) 아무것도 하지 않는다.
// 결과는 GITHUB_COLLABORATORS_INVITED 하나로 남긴다(레포마다 한 줄).
async function inviteToProjectGithubRepos(
  actor: Actor,
  projectId: string,
  agentId: string,
  trigger: 'assign' | 'retry',
): Promise<GithubInviteResult[]> {
  const repos = await listProjectGithubRepos(pool, projectId);
  if (repos.length === 0) return [];
  const owner = await findAgentOwnerGithub(pool, agentId);
  if (owner === null) return [];

  const skipAll = (reason: string): GithubInviteResult[] =>
    repos.map((r) => ({ repoId: r.id, fullName: r.fullName, status: 'skipped', reason }));

  let results: GithubInviteResult[];
  const sealed = await findRepresentativeGithubToken(pool, actor.orgId);
  if (owner.githubLogin === null) {
    results = skipAll('멤버가 GitHub를 연결하지 않았다 — 연결 뒤 재초대(POST .../github-invite)');
  } else if (sealed === null) {
    results = skipAll('대표가 GitHub를 연결하지 않았다');
  } else {
    const token = await decryptSecret(sealed);
    results = [];
    for (const repo of repos) {
      try {
        const status = await githubRepApi().inviteCollaborator(token, repo.fullName, owner.githubLogin);
        results.push({ repoId: repo.id, fullName: repo.fullName, status });
      } catch (err) {
        results.push({ repoId: repo.id, fullName: repo.fullName, status: 'failed', reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  await withTransaction(async (tx) => {
    await appendEvent(tx, {
      orgId: actor.orgId,
      projectId,
      type: 'GITHUB_COLLABORATORS_INVITED',
      actorAgentId: agentId,
      onBehalfOf: actor.userId,
      payload: { agentId, userId: owner.userId, githubLogin: owner.githubLogin, trigger, results },
    });
  });
  return results;
}

export async function unassignMember(
  actor: Actor,
  projectId: string,
  agentId: string,
): Promise<ProjectMemberView[]> {
  return withTransaction(async (tx) => {
    const project = await assertProjectInOrg(tx, actor.orgId, projectId, 'share');
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

    return membersWithInvites(tx, projectId);
  });
}

// 프로젝트 시작(G1). 이 순간부터 실행이 시작된다 — 에이전트는 시작 전에는 태스크를 가져갈 수 없고(PROJECT_NOT_STARTED),
// 시작하면 서버가 역할별 담당 에이전트에게 가져갈 수 있는 태스크를 보낸다(dispatch/tasks-changed → realtime/agent-stream).
//
// - 시작할 수 있는가: 태스크가 하나 이상, 끝나지 않은 태스크가 요구하는 역할마다 배정된 에이전트가 있어야 한다.
//   역할이 비면 그 태스크를 아무도 가져가지 않는다 — 시작 뒤에는 멤버를 바꿀 수 없으므로 여기서 막는다. 위반은 전부 모아 422.
// - 시작하면: planning → active, started_at. 시작 시점의 명세·적용된 계획에 approved_at(G1 승인 = 잠김). 멤버 고정(assertNotStarted).
// - 헌법은 프로젝트 생성 때 이미 사본을 떴다. 수정 경로가 생기면 "시작 뒤에는 고칠 수 없다"를 그쪽에 건다.
export async function startProject(actor: Actor, projectId: string): Promise<ProjectDetail> {
  const detail = await withTransaction(async (tx) => {
    const project = await assertProjectInOrg(tx, actor.orgId, projectId, 'update');
    if (project.startedAt !== null) {
      throw new AppError('PROJECT_ALREADY_STARTED', `project started at ${project.startedAt}`);
    }
    if (project.status !== 'planning') {
      throw new AppError('PROJECT_NOT_OPEN', `project is ${project.status}; only a planning project can start`);
    }

    const { total, openRoles } = await summarizeProjectTasks(tx, projectId);
    const members = await listProjectMembers(tx, projectId);
    const problems: { where: string; message: string }[] = [];
    if (total === 0) {
      problems.push({ where: 'tasks', message: '태스크가 없다 — PM 계획을 적용하거나 태스크를 만든 뒤 시작한다' });
    }
    const assigned = new Set(members.map((m) => m.teamRole));
    for (const role of openRoles.filter((r) => !assigned.has(r))) {
      problems.push({
        where: `members.${role}`,
        message: `${role} 역할의 태스크가 있는데 배정된 에이전트가 없다 — 시작하면 멤버를 바꿀 수 없으니 먼저 배정한다`,
      });
    }
    if (problems.length > 0) {
      throw new AppError('PROJECT_START_INVALID', `project cannot start: ${problems.length} problem(s)`, problems);
    }

    if (!(await markProjectStarted(tx, projectId))) {
      // 잠금을 잡고 봤으므로 여기 오면 안 된다. 오면 조용히 넘기지 않는다.
      throw new AppError('PROJECT_ALREADY_STARTED', 'project was started concurrently');
    }
    const approvedSpecCount = await approveProjectSpecs(tx, projectId);
    const approvedPlanIds = await approveAppliedPlans(tx, projectId);
    await appendEvent(tx, {
      orgId: actor.orgId,
      projectId,
      type: 'PROJECT_STARTED',
      onBehalfOf: actor.userId,
      policyHash: project.policyHash,
      payload: {
        members: members.map((m) => ({ agentId: m.agentId, teamRole: m.teamRole })),
        taskCount: total,
        approvedSpecCount,
        approvedPlanIds,
      },
    });

    return {
      project: (await findProjectById(tx, projectId))!,
      repos: await listProjectRepos(tx, projectId),
      members: await membersWithInvites(tx, projectId, members),
    };
  });
  // 커밋 뒤 — 가져갈 수 있는 태스크를 담당 에이전트에게 보낸다.
  tasksChanged(projectId);
  return detail;
}

export async function getProject(actor: Actor, projectId: string): Promise<ProjectDetail> {
  return withTransaction(async (tx) => {
    const project = await assertProjectInOrg(tx, actor.orgId, projectId);
    const members = await listProjectMembers(tx, projectId);

    // 대표이거나, 이 프로젝트에 배정된 에이전트의 주인이어야 본다.
    if (actor.orgRole !== 'REPRESENTATIVE' && !members.some((m) => m.userId === actor.userId)) {
      throw new AppError('NOT_PROJECT_MEMBER', 'you are not a member of this project');
    }

    return { project, repos: await listProjectRepos(tx, projectId), members: await membersWithInvites(tx, projectId, members) };
  });
}

// GET /api/orgs/:orgId/projects — 대표는 조직 전체, 팀원은 자기 에이전트가 배정된 프로젝트만.
// 팀원이 자기 프로젝트 id를 알 수 있는 유일한 경로다.
export async function listProjects(actor: Actor): Promise<Project[]> {
  return withTransaction(async (tx) =>
    listProjectsByOrg(tx, actor.orgId, actor.orgRole === 'REPRESENTATIVE' ? null : actor.userId),
  );
}
