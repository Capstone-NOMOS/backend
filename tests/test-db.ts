import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drainTasksChanged } from '../src/domain/dispatch/tasks-changed.js';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

// 테스트 전용 커넥션 풀. 실제 PostgreSQL을 대상으로 한다 (DB 목킹 금지).
export const testPool = new Pool({ connectionString: process.env.DATABASE_URL });

// "-- Up Migration" / "-- Down Migration" 마커로 나눈다. node-pg-migrate와 같은 규칙.
export function readMigration(file: string): { up: string; down: string } {
  const raw = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
  const [upPart, downPart] = raw.split('-- Down Migration');
  return { up: (upPart ?? '').replace('-- Up Migration', ''), down: downPart ?? '' };
}

export async function runMigrations(): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    await testPool.query(readMigration(file).up);
  }
}

export async function truncateAll(): Promise<void> {
  // 커밋 뒤 비동기로 도는 tasksChanged 리스너(배정 기록 등)가 TRUNCATE와 겹치면 교착하거나 지운 행을 참조한다 — 끝나길 기다린다.
  await drainTasksChanged();
  await testPool.query(
    `TRUNCATE TABLE agent_questions, agent_activity, task_dispatches, approvals, notes, verifications, artifacts, task_deps, tasks, plans, spec_tests, specs, project_policies, oauth_sessions, project_members, project_repos, projects,
       agent_device_requests, agent_tokens, agents, events, invites, repo_paths, repos, users, organizations
     RESTART IDENTITY CASCADE`,
  );
}

// 스키마를 지우고 처음부터 다시 만든다. vitest가 파일마다 별도 프로세스를 띄울 수 있으므로
// 각 파일이 항상 깨끗한 스키마로 시작하게 한다.
export async function resetSchema(): Promise<void> {
  await dropSchema();
  await runMigrations();
}

export async function dropSchema(): Promise<void> {
  await testPool.query(`
    DROP TABLE IF EXISTS agent_questions;
    DROP TABLE IF EXISTS agent_activity;
    DROP TABLE IF EXISTS task_dispatches;
    DROP TABLE IF EXISTS approvals;
    DROP TABLE IF EXISTS agent_device_requests;
    DROP TABLE IF EXISTS events;
    DROP FUNCTION IF EXISTS nomos_notify_event();
    DROP TABLE IF EXISTS oauth_sessions;
    DROP TABLE IF EXISTS spec_tests;
    DROP TABLE IF EXISTS project_policies;
    DROP TABLE IF EXISTS notes;
    DROP TABLE IF EXISTS verifications;
    DROP TABLE IF EXISTS artifacts;
    DROP TABLE IF EXISTS task_deps;
    DROP TABLE IF EXISTS tasks;
    DROP TABLE IF EXISTS plans;
    DROP TABLE IF EXISTS specs;
    DROP TABLE IF EXISTS project_members;
    DROP TABLE IF EXISTS project_repos;
    DROP TABLE IF EXISTS projects;
    DROP TABLE IF EXISTS agent_tokens;
    DROP TABLE IF EXISTS agents;
    DROP TABLE IF EXISTS invites;
    DROP TABLE IF EXISTS repo_paths;
    DROP TABLE IF EXISTS repos;
    ALTER TABLE IF EXISTS organizations DROP CONSTRAINT IF EXISTS fk_org_created_by;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS organizations;
    DROP TABLE IF EXISTS action_catalog;
  `);
}

// 마이그레이션 down 테스트용. 대상보다 뒤의 마이그레이션이 대상 테이블을 참조하므로
// 대상만 혼자 내려갈 수 없다. 대상과 그 뒤를 역순으로 함께 내린다 —
// 새 마이그레이션이 쌓여도 기존 down 테스트가 깨지지 않는다.
function migrationsFrom(file: string): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const index = files.indexOf(file);
  if (index < 0) throw new Error(`알 수 없는 마이그레이션: ${file}`);
  return files.slice(index);
}

export async function rollbackFrom(file: string): Promise<void> {
  for (const f of [...migrationsFrom(file)].reverse()) {
    await testPool.query(readMigration(f).down);
  }
}

export async function reapplyFrom(file: string): Promise<void> {
  for (const f of migrationsFrom(file)) {
    await testPool.query(readMigration(f).up);
  }
}
