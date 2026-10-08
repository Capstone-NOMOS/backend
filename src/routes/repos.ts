import { Router } from 'express';
import { z } from 'zod';
import { TEAM_ROLES } from '../domain/roles.js';
import { authenticate, orgIdOf, requireRepresentative, requireSameOrg } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { connectRepos, createGithubRepo, listGithubOrgs, listRepos, updateRepoSettings } from '../domain/repo/service.js';

export const reposRouter = Router();

const orgIdParamsSchema = z.object({ orgId: z.string().uuid() });

const connectReposBodySchema = z.object({
  repos: z
    .array(
      z.object({
        fullName: z.string().min(1),
        githubRepoId: z.number().int().optional(),
        defaultBranch: z.string().optional(),
        // 주면 '**' 행의 소유 역할까지 지정한다(대표 전용). 온보딩의 "레포 + 역할 선택"을 한 번에.
        ownerRole: z.enum(TEAM_ROLES).optional(),
      }),
    )
    .min(1),
});

// POST /api/orgs/:orgId/repos — 레포 연결(조직 멤버 누구나). 레포마다 기본 경로 규칙(seed-paths.ts)이 함께 생성된다.
//
// 대표 전용이 아닌 이유: repos 행은 그 자체로 아무 권한도 만들지 않는다. 판정에 쓰이는 경로 규칙은
// project_repos에 조인된 레포만 읽으므로(policy/repository.ts의 listProjectRepoPaths), 연결만 된 레포는
// 어떤 에이전트도 건드릴 수 없다. 실제 관문인 소유권 지정(PATCH .../paths/:pathId)과
// 프로젝트 투입(createProject의 repoIds)은 대표 전용으로 남는다 — 그 둘을 함께 열면 안 된다.
reposRouter.post(
  '/orgs/:orgId/repos',
  validate({ params: orgIdParamsSchema, body: connectReposBodySchema }),
  authenticate,
  requireSameOrg,
  async (req, res) => {
    const { orgId } = req.params as z.infer<typeof orgIdParamsSchema>;
    const repos = await connectRepos({
      orgId,
      actorUserId: req.user!.id,
      actorOrgRole: req.user!.orgRole,
      repos: req.body.repos,
    });
    res.status(201).json({ data: { repos } });
  },
);

// GitHub 이름 규칙: 조직은 영숫자·하이픈 39자, 레포는 영숫자·.·_·- 100자. 경로에 그대로 들어가므로 형식부터 막는다.
const createGithubRepoBodySchema = z.object({
  githubOrg: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'GitHub 조직 이름 형식이 아니다'),
  name: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}$/, 'GitHub 레포 이름은 영숫자와 . _ - 만 쓸 수 있다')
    .refine((n) => n !== '.' && n !== '..', 'GitHub 레포 이름으로 쓸 수 없다'),
  description: z.string().max(350).optional(),
  // 필수다 — 소유 역할이 없는 레포는 프로젝트에 넣을 수 없다(REPO_OWNERSHIP_NOT_SET).
  ownerRole: z.enum(TEAM_ROLES),
});

// POST /api/orgs/:orgId/github/repos — GitHub 조직에 비공개 레포를 만들고 바로 연결한다(대표 전용).
// 첫 커밋은 파일 없는 빈 커밋이고, github_repo_id·clone_url이 채워져 V3가 처음부터 돈다.
reposRouter.post(
  '/orgs/:orgId/github/repos',
  validate({ params: orgIdParamsSchema, body: createGithubRepoBodySchema }),
  authenticate,
  requireSameOrg,
  requireRepresentative,
  async (req, res) => {
    const { orgId } = req.params as z.infer<typeof orgIdParamsSchema>;
    const body = req.body as z.infer<typeof createGithubRepoBodySchema>;
    const repo = await createGithubRepo({ orgId, actorUserId: req.user!.id, ...body });
    res.status(201).json({ data: { repo } });
  },
);

// GET /api/orgs/:orgId/github/orgs — 대표가 레포를 만들 수 있는 GitHub 조직 목록(대표 전용, 대표 본인의 GitHub 토큰).
reposRouter.get(
  '/orgs/:orgId/github/orgs',
  validate({ params: orgIdParamsSchema }),
  authenticate,
  requireSameOrg,
  requireRepresentative,
  async (req, res) => {
    res.status(200).json({ data: { orgs: await listGithubOrgs(req.user!.id) } });
  },
);

// GET /api/orgs/:orgId/repos — 연결된 레포 목록. 경로 소유권 화면과 프로젝트 생성의 레포 선택이 여기서 id를 얻는다.
reposRouter.get(
  '/orgs/:orgId/repos',
  validate({ params: orgIdParamsSchema }),
  authenticate,
  requireSameOrg,
  async (req, res) => {
    const { orgId } = req.params as z.infer<typeof orgIdParamsSchema>;
    res.status(200).json({ data: { repos: await listRepos(orgId) } });
  },
);

const repoIdParamsSchema = z.object({ repoId: z.string().uuid() });

// 두 필드만 받는다. 형식(길이·정수)은 여기서, clone_url의 허용 스킴·주입 차단은 서비스(validateCloneUrl)가 본다 —
// 거부 사유를 메시지로 돌려주려면 zod가 아니라 서비스여야 한다(zod 상세는 응답에 실리지 않는다).
const updateRepoBodySchema = z
  .object({
    githubRepoId: z.number().int().positive().nullable().optional(),
    cloneUrl: z.string().max(2048).nullable().optional(),
  })
  .refine((b) => b.githubRepoId !== undefined || b.cloneUrl !== undefined, {
    message: 'githubRepoId 또는 cloneUrl 중 하나는 있어야 한다',
  });

// PATCH /api/repos/:repoId — V3가 커밋을 읽을 곳(github_repo_id·clone_url) 수정. 대표 전용.
// 연결은 팀원도 하지만, 서버가 무엇을 읽을지는 대표가 정한다(clone_url은 서버가 git clone에 넘긴다).
reposRouter.patch(
  '/repos/:repoId',
  validate({ params: repoIdParamsSchema, body: updateRepoBodySchema }),
  authenticate,
  requireRepresentative,
  async (req, res) => {
    const { repoId } = req.params as z.infer<typeof repoIdParamsSchema>;
    const body = req.body as z.infer<typeof updateRepoBodySchema>;
    const repo = await updateRepoSettings(orgIdOf(req), req.user!.id, repoId, {
      ...(body.githubRepoId === undefined ? {} : { githubRepoId: body.githubRepoId }),
      ...(body.cloneUrl === undefined ? {} : { cloneUrl: body.cloneUrl }),
    });
    res.status(200).json({ data: { repo } });
  },
);
