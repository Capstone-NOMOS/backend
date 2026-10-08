// 실제 GitHub에서 "조직에 레포 만들기"를 서버와 같은 코드(domain/github/rep-api.ts)로 확인한다.
// 가짜 GitHub로 돈 테스트가 증명하지 못하는 것 — 빈 트리 커밋으로 기본 브랜치를 덮는 방식이 GitHub에서 실제로 통하는가 — 만 본다.
//
//   npx tsx scripts/check-github-repo-create.ts --org <GitHub 조직> [--invite <GitHub 아이디>] [--keep]
//
// 토큰: GITHUB_CHECK_TOKEN, 없으면 `gh auth token`. 대표 토큰과 같은 범위(repo read:org)면 된다.
// 끝나면 만든 레포를 지운다(--keep이면 남긴다). 삭제는 delete_repo 권한이 따로 필요하다 — 확인용 스크립트에만 있고 서버에는 없다(대표 결정).
//   gh auth refresh -h github.com -s delete_repo
// 서버 env를 읽지 않는다 — 서버 비밀값 없이 돈다.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGithubRepApi, EMPTY_TREE_SHA, INITIAL_COMMIT_MESSAGE } from '../src/domain/github/rep-api.js';

const API = 'https://api.github.com';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function out(line: string): void {
  process.stdout.write(`[check-github] ${line}\n`);
}

function token(): string {
  if (process.env.GITHUB_CHECK_TOKEN) return process.env.GITHUB_CHECK_TOKEN;
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

async function gh(tok: string, method: string, url: string): Promise<Response> {
  return fetch(`${API}${url}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'nomos-check' },
  });
}

async function main(): Promise<void> {
  const org = arg('org');
  if (!org) throw new Error('--org <GitHub 조직>이 필요합니다');
  const invitee = arg('invite');
  const keep = process.argv.includes('--keep');
  const tok = token();
  const api = createGithubRepApi();
  const name = `nomos-check-${Date.now()}`;
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    out(`${ok ? 'OK  ' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };

  const orgs = await api.listOrgs(tok);
  check(orgs.includes(org), `GitHub 조직 목록에 ${org}가 있다 (${orgs.join(', ') || '없음'})`);

  out(`레포 만들기: ${org}/${name}`);
  const created = await api.createOrgRepo(tok, { org, name, description: 'NOMOS 레포 만들기 확인용 — 곧 지운다' });
  out(`  → ${created.fullName} (id ${created.githubRepoId}, 기본 브랜치 ${created.defaultBranch})`);

  try {
    const repo = (await (await gh(tok, 'GET', `/repos/${created.fullName}`)).json()) as { private: boolean };
    check(repo.private === true, '비공개 레포다');

    const commits = (await (await gh(tok, 'GET', `/repos/${created.fullName}/commits?sha=${created.defaultBranch}`)).json()) as Array<{
      sha: string;
      commit: { message: string; tree: { sha: string } };
      parents: unknown[];
    }>;
    check(commits.length === 1, `기본 브랜치의 커밋이 하나다 (${commits.length}개)`);
    const head = commits[0];
    check(head?.commit.message === INITIAL_COMMIT_MESSAGE && head.parents.length === 0, `그 커밋이 부모 없는 "${INITIAL_COMMIT_MESSAGE}"이다`);

    // 빈 트리는 GitHub에 객체로 저장되지 않아 trees API로 읽으면 404다(실측). 커밋이 가리키는 트리 sha로 본다.
    check(head?.commit.tree.sha === EMPTY_TREE_SHA, `커밋의 트리가 빈 트리다 — README 없음 (${head?.commit.tree.sha ?? '?'})`);

    // Executor가 하는 것처럼 클론해서 origin/<기본 브랜치>에서 태스크 브랜치를 딴다(사용자의 git 자격 증명).
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nomos-check-'));
    try {
      execFileSync('git', ['clone', '--quiet', '--', `https://github.com/${created.fullName}`, dir], { stdio: 'pipe' });
      execFileSync('git', ['-C', dir, 'switch', '--quiet', '-c', 'task/check', `origin/${created.defaultBranch}`], { stdio: 'pipe' });
      const files = readdirSync(dir).filter((f) => f !== '.git');
      check(files.length === 0, `클론 → origin/${created.defaultBranch}에서 분기됨, 작업 트리에 파일 없음`);
    } catch (err) {
      check(false, `클론·분기 실패: ${(err as Error).message.split('\n')[0]}`);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }

    if (invitee) {
      const result = await api.inviteCollaborator(tok, created.fullName, invitee);
      check(result === 'invited' || result === 'already_collaborator', `협업자 초대 ${invitee} → ${result}`);
    }
  } finally {
    if (keep) {
      out(`--keep: 레포를 남김 — https://github.com/${created.fullName}`);
    } else {
      const del = await gh(tok, 'DELETE', `/repos/${created.fullName}`);
      if (del.status === 204) out(`레포 삭제함: ${created.fullName}`);
      else out(`레포를 지우지 못했습니다(${del.status}). delete_repo 권한: gh auth refresh -h github.com -s delete_repo, 또는 직접: gh repo delete ${created.fullName} --yes`);
    }
  }

  out(failures.length === 0 ? '전부 통과' : `실패 ${failures.length}개`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`[check-github] 오류: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
