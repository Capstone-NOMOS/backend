// worktree에 실제로 깔린 .claude/settings.json이 서버 판정과 같은 결론을 내는지 대조한다.
//
// path-golden.test.ts는 **생성기의 출력**을 검사한다. 이 스크립트는 **디스크에 깔린 파일**을 검사한다.
// 둘은 다른 질문이다 — 생성기가 맞아도 Executor가 엉뚱한 내용을 쓰거나 옛 파일이 남아 있을 수 있다.
//
//   npm run verify:settings                 가장 최근 작업공간
//   npm run verify:settings -- <작업공간 경로>
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pool } from '../src/config/db.js';
import { buildClaudePermissions, type ClaudePermissions } from '../src/domain/repo/claude-settings.js';
import { resolveRule } from '../src/domain/repo/glob.js';
import { listRepoPaths } from '../src/domain/repo/repository.js';
import type { PathAccess } from '../src/domain/repo/seed-paths.js';
import { findTaskById } from '../src/domain/task/repository.js';
import { judgeWithClaudeSettings } from '../tests/claude-permission-model.js';
import { JUDGMENTS, UNIVERSE } from '../tests/path-fixtures.js';

const STRICTNESS: Record<PathAccess, number> = { write: 0, read: 1, denied: 2 };

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function newestWorkspace(): string {
  const root = path.join(os.homedir(), '.nomos', 'workspaces');
  if (!existsSync(root)) throw new Error(`${root}가 없습니다. executor once를 먼저 돌리세요`);
  const candidates: { dir: string; mtime: number }[] = [];
  for (const project of readdirSync(root)) {
    const projectDir = path.join(root, project);
    if (!statSync(projectDir).isDirectory()) continue;
    for (const task of readdirSync(projectDir)) {
      const dir = path.join(projectDir, task);
      if (existsSync(path.join(dir, '.claude', 'settings.json'))) {
        candidates.push({ dir, mtime: statSync(dir).mtimeMs });
      }
    }
  }
  const newest = candidates.sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) throw new Error('settings.json이 있는 작업공간을 찾지 못했습니다');
  return newest.dir;
}

async function main(): Promise<void> {
  const workspace = process.argv[2] ?? newestWorkspace();
  out(`작업공간: ${workspace}`);

  const settings = JSON.parse(
    readFileSync(path.join(workspace, '.claude', 'settings.json'), 'utf-8'),
  ) as ClaudePermissions;
  const policy = JSON.parse(
    readFileSync(path.join(workspace, '.claude', '.nomos-policy.json'), 'utf-8'),
  ) as { policyHash: string; taskId: string };
  out(`태스크: ${policy.taskId} / 생성 당시 policy_hash: ${policy.policyHash.slice(0, 16)}…`);
  out(`deny 규칙 ${settings.permissions.deny.length}개`);
  out();

  const task = await findTaskById(pool, policy.taskId);
  if (!task) throw new Error(`태스크 ${policy.taskId}를 DB에서 찾지 못했습니다`);
  const rules = await listRepoPaths(pool, task.repoId);

  // ① 디스크의 파일이 현재 규칙으로 다시 만든 것과 같은가 (옛 파일이 남아 있지 않은가)
  const regenerated = buildClaudePermissions(rules);
  const drifted = JSON.stringify(regenerated) !== JSON.stringify(settings);
  out(`① 현재 규칙으로 재생성한 것과 동일한가: ${drifted ? '아니오 — 파일이 낡았다' : '예'}`);

  // ② 골든 fixture의 기대 판정을 디스크 파일이 그대로 내는가
  const serverJudge = (p: string): PathAccess => resolveRule(rules, p)?.access ?? 'write';
  const fileJudge = (p: string): PathAccess => judgeWithClaudeSettings(settings, p);

  const fixtureMismatch = JUDGMENTS.filter(([p, expected]) => fileJudge(p) !== expected).map(
    ([p, expected]) => ({ path: p, expected, file: fileJudge(p) }),
  );
  out(`② 골든 fixture ${JUDGMENTS.length}개 중 불일치: ${fixtureMismatch.length}`);
  for (const m of fixtureMismatch) out(`   ${m.path}: 기대 ${m.expected} / 파일 ${m.file}`);

  // ③ 경로 전수에서 파일이 서버보다 느슨한 경우 — 있으면 하드 실패
  const diffs = UNIVERSE.map((p) => ({ path: p, server: serverJudge(p), file: fileJudge(p) })).filter(
    (r) => r.server !== r.file,
  );
  const looser = diffs.filter((r) => STRICTNESS[r.file] < STRICTNESS[r.server]);
  const stricter = diffs.filter((r) => STRICTNESS[r.file] > STRICTNESS[r.server]);
  out(`③ 경로 ${UNIVERSE.length}개 — 파일이 더 느슨: ${looser.length} / 더 엄격: ${stricter.length}`);
  for (const r of looser.slice(0, 10)) out(`   [느슨] ${r.path}: 서버 ${r.server} / 파일 ${r.file}`);
  for (const r of stricter.slice(0, 5)) out(`   [엄격] ${r.path}: 서버 ${r.server} / 파일 ${r.file}`);

  out();
  const failed = drifted || fixtureMismatch.length > 0 || looser.length > 0;
  out(failed ? '결과: 실패' : '결과: 통과 — 디스크의 settings.json이 서버와 같은 결론을 낸다');
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
