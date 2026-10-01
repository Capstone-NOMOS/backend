// 수동 테스트용 시드. 실행할 때마다 **같은 상태**가 나오도록 기존 데이터를 비우고 시작한다.
//
// 태스크·프로젝트 생성 API가 아직 없어서 그 테이블만 직접 INSERT한다. 나머지는 전부 서비스 함수를
// 거친다 — 직접 넣으면 서비스가 지키는 불변식(agents.org_id = users.org_id 등)을 건너뛰고,
// 그렇게 만든 상태로 하는 수동 테스트는 실제 동작을 확인하지 못한다.
//
// stdout은 사람이 읽고 복사하는 용도다. 서버 로그(logger)와 섞이면 복사가 번거로우므로
// process.stdout.write로 직접 쓴다.
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildMcpConfig } from '../src/bridge/claude-args.js';
import { credentialsPath, writeCredentials } from '../src/bridge/credentials.js';
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { assertNotMarkedProduction, assertSeedTargetAllowed } from './lib/remote-db-guard.js';
import { connectAgent, refreshAgentToken } from '../src/domain/agent/service.js';
import { signup } from '../src/domain/auth/service.js';
import { acceptInvite, createInvite } from '../src/domain/invite/service.js';
import { createOrganization } from '../src/domain/org/service.js';
import { mirrorRoot } from '../src/domain/verification/commit-inspector.js';
import { assignMember, createProject, startProject } from '../src/domain/project/service.js';
import { connectRepos, updatePathOwnership } from '../src/domain/repo/service.js';
import { readRepoMap } from '../src/executor/workspace.js';

const PASSWORD = 'manual-test-1234';

// 시험지 코드를 줄 배열로 쓰고 합칠 때 쓴다.
const NL = String.fromCharCode(10);

// tests/test-db.ts의 truncateAll과 같은 목록이다. 테이블을 추가하면 양쪽을 함께 고칠 것.
const TRUNCATE = `
  TRUNCATE TABLE notes, artifacts, task_deps, tasks, plans, spec_tests, specs, project_policies,
    oauth_sessions, project_members, project_repos, projects,
    agent_tokens, agents, events, invites, repo_paths, repos, users, organizations
  RESTART IDENTITY CASCADE`;

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function table(headers: string[], rows: string[][]): void {
  out(`| ${headers.join(' | ')} |`);
  out(`|${headers.map(() => '---').join('|')}|`);
  for (const row of rows) out(`| ${row.join(' | ')} |`);
  out();
}

async function pathId(repoId: string, pattern: string): Promise<string> {
  const { rows } = await pool.query(`SELECT id FROM repo_paths WHERE repo_id = $1 AND path_pattern = $2`, [
    repoId,
    pattern,
  ]);
  return rows[0]!.id as string;
}

async function main(): Promise<void> {
  // 무엇보다 먼저 — TRUNCATE는 되돌릴 수 없다.
  const argv = process.argv.slice(2);
  const target = assertSeedTargetAllowed(env.DATABASE_URL, argv);
  // 호스트명은 로컬이어도 DB가 운영일 수 있다(포트 포워딩). DB에 남은 표시로 한 번 더 본다.
  const production = await assertNotMarkedProduction(pool, argv);
  if (!target.local || production) {
    process.stderr.write(`⚠️  원격·운영 DB(${target.host})를 비운다 (--allow-remote)\n`);
  }

  await pool.query(TRUNCATE);

  // V3가 쓰는 bare mirror는 디렉터리 이름이 repo_id다. TRUNCATE로 레포 행이 사라지면
  // 남은 mirror는 어떤 레포와도 이어지지 않는 고아이고, 다음 시드는 새 id로 새로 clone한다.
  // 지우는 자리가 여기인 이유는 mirror를 만드는 쪽이 서버이기 때문이다 —
  // executor clean은 팀원 노트북에서 도는 브릿지 명령이라 서버가 만든 것을 지울 자리가 아니다.
  rmSync(mirrorRoot(), { recursive: true, force: true });

  // ① 계정 3개. 연결 키 평문은 가입 응답에서 한 번만 나오므로 여기서 받아 출력한다.
  const rep = await signup({ loginId: 'rep', password: PASSWORD, nickname: '대표' });
  const fe = await signup({ loginId: 'fe', password: PASSWORD, nickname: '프론트' });
  const be = await signup({ loginId: 'be', password: PASSWORD, nickname: '백엔드' });

  // ② 조직 — 만든 사람이 대표가 된다.
  const { orgId } = await createOrganization(rep.userId, 'Acme Inc.');

  // ③ 초대로 합류시킨다. 직접 UPDATE하면 agents.org_id를 함께 채우는 경로를 건너뛴다.
  const feInvite = await createInvite(orgId, rep.userId, { teamRole: 'FRONTEND' });
  await acceptInvite(feInvite.token, fe.userId);
  const beInvite = await createInvite(orgId, rep.userId, { teamRole: 'BACKEND' });
  await acceptInvite(beInvite.token, be.userId);

  // ④ 레포 2개. 연결하면 기본 경로 규칙 15개가 자동으로 들어간다.
  const repos = await connectRepos({
    orgId,
    actorUserId: rep.userId,
    repos: [{ fullName: 'acme/study-api' }, { fullName: 'acme/study-web' }],
  });
  const api = repos.find((r) => r.fullName === 'acme/study-api')!;
  const web = repos.find((r) => r.fullName === 'acme/study-web')!;

  // V3가 커밋의 **실제** diff를 읽을 곳. 로컬 데모에서는 ~/.nomos/repos.json이 가리키는
  // 경로를 그대로 쓴다 — git은 로컬 경로도 clone/fetch할 수 있다.
  // 비어 있으면 V3는 PASS가 아니라 SKIPPED로 기록된다(사유와 함께).
  for (const [fullName, localPath] of Object.entries(readRepoMap())) {
    await pool.query(`UPDATE repos SET clone_url = $2 WHERE org_id = $1 AND full_name = $3`, [
      orgId,
      localPath,
      fullName,
    ]);
  }

  // ⑤ 온보딩의 핵심 산출물: '**' 행의 소유 역할 지정. 레포는 완전히 분리된다.
  await updatePathOwnership(orgId, rep.userId, api.id, await pathId(api.id, '**'), { ownerRole: 'BACKEND' });
  await updatePathOwnership(orgId, rep.userId, web.id, await pathId(web.id, '**'), { ownerRole: 'FRONTEND' });

  // ⑥ CLI 연결 — 에이전트 행과 토큰이 생긴다. 아직 프로젝트가 없어 토큰에 project_id가 없다.
  const feAgent = await connectAgent({
    connectKey: fe.connectKey,
    agentName: 'fe-laptop',
    harness: 'claude-code@2.1.263',
    skills: ['typescript'],
    maxConcurrent: 2,
  });
  const beAgent = await connectAgent({
    connectKey: be.connectKey,
    agentName: 'be-laptop',
    harness: 'claude-code@2.1.263',
    skills: ['typescript'],
    maxConcurrent: 2,
  });

  // ⑦ 프로젝트 — API와 같은 서비스를 쓴다. 레포 연결·정책 사본 17행·헌법 스냅샷·policy_hash가
  // 한 트랜잭션에서 함께 만들어지고 PROJECT_CREATED 이벤트도 남는다.
  const { project } = await createProject(orgId, rep.userId, {
    name: '스터디 관리 웹앱 v1',
    autonomyPreset: 'L2',
    pmBudgetUsd: 40,
    repoIds: [api.id, web.id],
  });
  const projectId = project.id;

  // 역할당 1명. 대표의 에이전트는 멤버가 될 수 없다.
  const actor = { userId: rep.userId, orgId, orgRole: 'REPRESENTATIVE' };
  await assignMember(actor, projectId, beAgent.agentId, 'BACKEND');
  await assignMember(actor, projectId, feAgent.agentId, 'FRONTEND');

  // ⑧ 명세 2개 + READY 태스크 4개 (FE 2 / BE 2).
  const specs = await pool.query(
    `INSERT INTO specs (project_id, feature_key, title, content) VALUES
       ($1, 'F-01', '스터디 목록 화면', 'WHEN 사용자가 목록을 열면 THEN 모집중 스터디를 보여준다'),
       ($1, 'F-03', '참여 신청 API', 'WHEN 정원이 찬 스터디에 신청하면 THEN 409를 반환한다')
     RETURNING id, feature_key`,
    [projectId],
  );
  const specOf = (key: string): string => specs.rows.find((r) => r.feature_key === key)!.id as string;

  // V2(PM 시험지). locked_at을 지금 박아 두는 것이 핵심이다 — 산출물보다 **먼저** 잠겨 있어야
  // 통과의 근거가 된다. 나중에 잠근 시험지는 서버가 보고를 받을 때 FAIL로 뒤집는다.
  // 작업공간에 vitest가 없으면 브릿지가 SKIPPED로 보고한다(사유가 함께 남는다).
  await pool.query(
    `INSERT INTO spec_tests (spec_id, criterion, test_code, locked_at) VALUES
       ($1, '정원이 찬 스터디 신청은 409다', $3, now()),
       ($2, '목록은 모집중 스터디만 보여준다', $4, now())`,
    [
      specOf('F-03'),
      specOf('F-01'),
      [
        "import { describe, expect, it } from 'vitest';",
        "import { existsSync } from 'node:fs';",
        '',
        "describe('F-03 참여 신청 API', () => {",
        "  it('작업공간에 소스가 있다', () => {",
        "    expect(existsSync('src')).toBe(true);",
        '  });',
        '});',
      ].join(NL),
      [
        "import { describe, expect, it } from 'vitest';",
        "import { existsSync } from 'node:fs';",
        '',
        "describe('F-01 스터디 목록 화면', () => {",
        "  it('작업공간에 소스가 있다', () => {",
        "    expect(existsSync('src')).toBe(true);",
        '  });',
        '});',
      ].join(NL),
    ],
  );

  const tasks = await pool.query(
    `INSERT INTO tasks (project_id, repo_id, spec_id, title, state, kind, team_role) VALUES
       ($1, $2, $3, 'T-001 참여 신청 API 구현',   'READY', 'IMPLEMENT', 'BACKEND'),
       ($1, $2, $3, 'T-002 정원 초과 409 처리',   'READY', 'IMPLEMENT', 'BACKEND'),
       ($1, $4, $5, 'T-003 스터디 목록 화면',     'READY', 'IMPLEMENT', 'FRONTEND'),
       ($1, $4, $5, 'T-004 신청 버튼 상태 처리',  'READY', 'IMPLEMENT', 'FRONTEND')
     RETURNING id, title, team_role`,
    [projectId, api.id, specOf('F-03'), web.id, specOf('F-01')],
  );

  // 프로젝트 시작(G1) — 시작해야 에이전트가 태스크를 가져간다(executor 데모가 바로 돈다).
  // 시작 흐름 자체를 손으로 보려면 --planning: 시작하지 않은 채 두고, POST /api/projects/:id/start를 직접 부른다.
  const keepPlanning = argv.includes('--planning');
  if (!keepPlanning) await startProject(actor, projectId);

  // ⑨ 프로젝트에 배정된 뒤 재발급해야 토큰에 project_id와 policy_hash가 담긴다.
  // 배정 전에 받은 토큰에는 project_id가 없어 태스크 API가 403이다.
  const feToken = await refreshAgentToken(feAgent.refreshToken);
  const beToken = await refreshAgentToken(beAgent.refreshToken);

  // 자격 증명은 ~/.nomos/credentials(0600)에 쓴다. 토큰은 이 시점에만 평문으로 손에 있고,
  // 사람이 옮겨 적게 하면 틀린다. MCP 설정에는 비밀값을 넣지 않는다.
  writeCredentials({
    baseUrl: env.API_BASE_URL,
    accessToken: beToken.accessToken,
    refreshToken: beAgent.refreshToken,
    agentId: beAgent.agentId,
  });
  const mcpConfigPath = path.resolve('.nomos-mcp.json');
  writeFileSync(mcpConfigPath, buildMcpConfig({ serverPath: path.resolve('dist/bridge/mcp-server.js') }));

  out();
  out('# 수동 테스트 시드 완료');
  out();
  out('## 계정 (사람 토큰은 POST /api/auth/login으로 받는다)');
  table(
    ['loginId', '비밀번호', '조직 역할', '팀 역할', '연결 키'],
    [
      ['rep', PASSWORD, 'REPRESENTATIVE', '—', rep.connectKey],
      ['be', PASSWORD, 'MEMBER', 'BACKEND', be.connectKey],
      ['fe', PASSWORD, 'MEMBER', 'FRONTEND', fe.connectKey],
    ],
  );

  out('## 에이전트 토큰 (access는 1시간. 만료되면 refresh로 재발급)');
  table(
    ['에이전트', 'agent_id', 'access token', 'refresh token'],
    [
      ['be-laptop', beAgent.agentId, beToken.accessToken, beAgent.refreshToken],
      ['fe-laptop', feAgent.agentId, feToken.accessToken, feAgent.refreshToken],
    ],
  );

  // 초대 수락 단계를 직접 밟아볼 수 있도록 미사용 초대를 하나 남긴다.
  const spareInvite = await createInvite(orgId, rep.userId, { teamRole: 'FRONTEND' });

  out('## 식별자');
  table(
    ['이름', '값'],
    [
      ['ORG_ID', orgId],
      ['PROJECT_ID', projectId],
      ['POLICY_HASH', project.policyHash],
      ['REPO_API (acme/study-api, BACKEND 소유)', api.id],
      ['REPO_WEB (acme/study-web, FRONTEND 소유)', web.id],
      ['SPEC_F01', specOf('F-01')],
      ['SPEC_F03', specOf('F-03')],
      ['INVITE_TOKEN (미사용, FRONTEND)', spareInvite.token],
    ],
  );

  out(keepPlanning
    ? '프로젝트: **planning**(시작 전) — POST /api/projects/:id/start로 시작해야 에이전트가 태스크를 가져간다'
    : '프로젝트: **active**(시작됨) — 멤버는 고정이다. 시작 흐름을 보려면 npm run seed -- --planning');
  out();
  out('## READY 태스크');
  table(
    ['task_id', '역할', '제목'],
    tasks.rows.map((r) => [r.id as string, r.team_role as string, r.title as string]),
  );

  out('## MCP (Claude Code에 붙이기)');
  out();
  out(`자격 증명: ${credentialsPath()}  (be-laptop 토큰. 0600)`);
  out(`MCP 설정:  ${mcpConfigPath}  (비밀값 없음)`);
  out('먼저 `npm run build` — 설정이 dist/bridge/mcp-server.js를 가리킨다.');
  out('실행:  claude --mcp-config .nomos-mcp.json --strict-mcp-config -p "사용 가능한 도구를 알려줘"');
  out();
  out('환경변수로 옮기려면 docs/manual-test.md의 "변수 설정" 절을 보라.');
}

main()
  .catch((err) => {
    process.stderr.write(`시드 실패: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
