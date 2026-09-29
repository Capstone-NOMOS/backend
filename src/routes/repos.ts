import { Router } from 'express';
import { z } from 'zod';
import { authenticate, orgIdOf, requireRepresentative, requireSameOrg } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { connectRepos, listRepos, updateRepoSettings } from '../domain/repo/service.js';

export const reposRouter = Router();

const orgIdParamsSchema = z.object({ orgId: z.string().uuid() });

const connectReposBodySchema = z.object({
  repos: z
    .array(
      z.object({
        fullName: z.string().min(1),
        githubRepoId: z.number().int().optional(),
        defaultBranch: z.string().optional(),
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
      repos: req.body.repos,
    });
    res.status(201).json({ data: { repos } });
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
