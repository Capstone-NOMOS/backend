import ignore from 'ignore';
import type { ClaudePermissions } from '../src/domain/repo/claude-settings.js';
import type { PathAccess } from '../src/domain/repo/seed-paths.js';

// Claude Code의 권한 규칙 평가를 흉내 내는 테스트용 모델.
// 기본 매칭은 우리 매처가 아니라 gitignore 명세 구현체(`ignore`)에 맡긴다 — 서버 매처로 브릿지를 검사하면
// 같은 버그를 양쪽이 공유해도 테스트가 통과하기 때문이다. 그 위의 Claude Code 고유 규칙은
// code.claude.com/docs/en/permissions 문서에 적힌 대로 옮겼다:
//   1. 'dir/**'처럼 디렉터리 한 칸짜리 deny 규칙은 모든 깊이에 매칭된다.
//   2. '!패턴'은 앞에 나온 규칙에서 경로를 빼낸다. 단 '/'로 앵커된 규칙과 'x/**'로 디렉터리를 통째로
//      막은 규칙은 빼내지 못한다.
//   3. Read deny는 Edit·Write도 막는다.
//
// 아래 네 가지는 생성기가 만든 settings.json을 임시 작업공간에 깔고 헤드리스 Claude Code를 실제로
// 돌려 확인했다(2026-09-16, v2.1.263, Windows):
//   - '**/.env*' deny + '!**/.env.example' → .env 거부 / .env.example 읽기·수정 허용
//   - '/contracts/**' deny는 '!'로 뚫리지 않고(수정 거부), 레포 루트에만 적용됨(vendor/contracts는 허용)
//   - '**/secrets/**' 안의 .env.example은 예외로도 되살아나지 않음(읽기 거부)
//   - **대소문자를 구분하지 않음**: '.ENV'는 거부, '.env.EXAMPLE'은 허용
// ignore의 기본값이 ignorecase: true라서 마지막 항목과 일치한다. 리눅스 에이전트에서 Claude가
// 대소문자를 구분한다면 이 모델은 더 엄격한 쪽으로 틀리게 되는데, 그 방향은 비대칭 테스트가 통과시킨다.

function gitignoreMatches(pattern: string, path: string): boolean {
  return ignore().add(pattern).ignores(path);
}

// deny 규칙 하나(괄호 안 경로)가 path에 매칭되는가.
export function claudeDenyRuleMatches(rulePath: string, path: string): boolean {
  if (/^[^/*]+\/\*\*$/.test(rulePath)) return gitignoreMatches(`**/${rulePath}`, path);
  return gitignoreMatches(rulePath, path);
}

function isUncarvable(rulePath: string): boolean {
  return rulePath.startsWith('/') || rulePath.endsWith('/**');
}

function blockedBy(deny: readonly string[], tool: 'Read' | 'Edit', path: string): boolean {
  let blockers: string[] = [];
  for (const rule of deny) {
    const match = /^(Read|Edit)\((.*)\)$/.exec(rule);
    if (!match || match[1] !== tool) continue;
    const rulePath = match[2]!;
    if (rulePath.startsWith('!')) {
      if (gitignoreMatches(rulePath.slice(1), path)) blockers = blockers.filter(isUncarvable);
    } else if (claudeDenyRuleMatches(rulePath, path)) {
      blockers.push(rulePath);
    }
  }
  return blockers.length > 0;
}

export function judgeWithClaudeSettings(settings: ClaudePermissions, path: string): PathAccess {
  const { deny } = settings.permissions;
  if (blockedBy(deny, 'Read', path)) return 'denied';
  if (blockedBy(deny, 'Edit', path)) return 'read';
  return 'write';
}
