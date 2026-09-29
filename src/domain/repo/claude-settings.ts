import { validatePattern } from './glob.js';
import type { PathAccess } from './seed-paths.js';

// 브릿지가 worktree에 까는 .claude/settings.json의 permissions 부분을 경로 규칙에서 만든다.
// 목표는 서버 매처(resolveRule)와 같은 판정이다. tests/path-golden.test.ts가 이걸 검증한다.
//
// Claude Code 권한 규칙에서 우리가 기대는 사실 (code.claude.com/docs/en/permissions):
//   - deny가 allow보다 항상 이긴다. allow로는 예외를 못 만든다.
//   - deny 목록 안의 '!패턴'은 앞에 나온 규칙에서 경로를 빼낸다 (gitignore 방식).
//     단 '/'로 앵커된 규칙과, 디렉터리를 통째로 막은 'x/**' 규칙 안의 파일은 되살리지 못한다.
//   - Read deny는 Edit·Write도 막는다. Write 경로 규칙은 참조되지 않으므로 Edit를 쓴다.
//   - 슬래시 없는 패턴과 'dir/**' 형태의 deny는 모든 깊이에 매칭된다 → 서버와 맞추려면 '/'로 앵커한다.

export type PathRuleForSettings = {
  pathPattern: string;
  access: PathAccess;
  priority: number;
};

export type ClaudePermissions = {
  permissions: { deny: string[] };
};

// 서버 패턴을 Claude Code 규칙 안의 경로로 옮긴다.
// 서버에서 '**/'로 시작하지 않는 패턴은 레포 루트에 고정되므로 '/'(settings 파일 기준 = worktree 루트)를 붙인다.
export function toClaudePath(serverPattern: string): string {
  validatePattern(serverPattern);
  return serverPattern.startsWith('**/') ? serverPattern : `/${serverPattern}`;
}

// 서버는 priority가 높은 규칙이 이기고, gitignore는 뒤에 나온 규칙이 이긴다.
// priority 오름차순으로 늘어놓고, 제한 행은 그대로, 허용 행은 '!'로 내면 같은 결과가 된다.
function emit(
  sorted: readonly PathRuleForSettings[],
  tool: 'Read' | 'Edit',
  isRestrictive: (access: PathAccess) => boolean,
): string[] {
  const out: string[] = [];
  let restricted = false;
  for (const rule of sorted) {
    const path = toClaudePath(rule.pathPattern);
    if (isRestrictive(rule.access)) {
      out.push(`${tool}(${path})`);
      restricted = true;
    } else if (restricted) {
      // 앞에 막은 규칙이 없으면 '!'는 아무것도 빼지 못하므로 내지 않는다.
      out.push(`${tool}(!${path})`);
    }
  }
  return out;
}

export function buildClaudePermissions(rules: readonly PathRuleForSettings[]): ClaudePermissions {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.priority === sorted[i - 1]!.priority) {
      // 동점이면 뒤에 오는 규칙이 정해지지 않아 서버의 사전순 폴백과 다른 결과가 날 수 있다.
      throw new Error(`buildClaudePermissions: duplicate priority ${sorted[i]!.priority}`);
    }
  }

  return {
    permissions: {
      deny: [
        ...emit(sorted, 'Read', (access) => access === 'denied'),
        // denied도 넣는다 — Read deny는 NotebookEdit을 막지 않는다.
        ...emit(sorted, 'Edit', (access) => access !== 'write'),
      ],
    },
  };
}
