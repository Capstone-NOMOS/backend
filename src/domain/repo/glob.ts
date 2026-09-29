import { AppError } from '../../errors.js';
import type { RepoPath } from './types.js';

// path_pattern에 허용되는 문자만 담고 있는지 검사하는 화이트리스트.
// 허용: **, *, 리터럴 경로 문자(영숫자, . _ - /)
// 금지: {a,b} 확장, !부정, ?, [] 문자클래스 — 서버(picomatch)와 브릿지(.claude/settings.json)의
// glob 방언 차이로 인한 불일치를 막기 위해 안전한 부분집합만 허용한다.
const ALLOWED_PATTERN = /^[A-Za-z0-9_.\-/*]+$/;
const FORBIDDEN_SYNTAX = /[{}!?[\]]/;

function invalid(p: string, reason: string): AppError {
  return new AppError('INVALID_GLOB_PATTERN', `pattern "${p}" is invalid: ${reason}`);
}

// path_pattern이 허용된 문법만 쓰는지 검사한다. 위반 시 AppError(INVALID_GLOB_PATTERN).
export function validatePattern(p: string): void {
  if (p.length === 0) {
    throw invalid(p, 'must not be empty');
  }
  if (FORBIDDEN_SYNTAX.test(p) || !ALLOWED_PATTERN.test(p)) {
    throw invalid(p, 'only **, *, and literal path segments are allowed');
  }
  for (const segment of p.split('/')) {
    // '/abs', 'dir/', 'a//b' — 레포 루트 기준 상대 경로만 받는다.
    if (segment.length === 0) {
      throw invalid(p, 'empty path segment');
    }
    // 'a**b', 'src/**.ts'를 picomatch는 '*'로 읽고 우리는 '**'로 읽게 되므로 아예 받지 않는다.
    if (segment.includes('**') && segment !== '**') {
      throw invalid(p, "'**' must be a whole path segment");
    }
  }
}

function escapeLiteral(text: string): string {
  // 화이트리스트를 통과한 문자 중 정규식에서 특별한 의미를 갖는 것은 '.' 뿐이다.
  return text.replace(/\./g, '\\.');
}

// path_pattern을 정규식으로 변환한다 (gitignore·picomatch와 같은 의미).
//   '**/'  0개 이상의 디렉터리 — '**/.env*'는 '.env'와 'apps/api/.env' 둘 다 매칭
//   '/**'  그 아래 전부
//   '**'   단독이면 전부
//   '*'    '/'를 넘지 않는 한 세그먼트 안의 0개 이상 문자
function patternToRegex(pattern: string): RegExp {
  const segments = pattern.split('/');
  let regexSrc = '';

  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    if (segment === '**') {
      regexSrc += isLast ? '.*' : '(?:.*/)?';
      return;
    }
    regexSrc += segment.split('*').map(escapeLiteral).join('[^/]*');
    if (!isLast) regexSrc += '/';
  });

  // 대소문자를 구분하지 않는다. 이유 두 가지:
  //   1. Claude Code의 권한 규칙이 대소문자를 무시한다(생성한 settings.json으로 실측 확인).
  //      구분하면 '.env.EXAMPLE'을 서버는 막고 로컬은 허용하는 — 더 위험한 방향의 — 불일치가 난다.
  //   2. Windows·macOS 파일시스템도 구분하지 않으므로 '.ENV'로 '.env'를 고치는 우회를 막아야 한다.
  return new RegExp(`^${regexSrc}$`, 'i');
}

// pattern이 filePath(레포 루트 기준 상대 경로)와 매칭되는지 검사한다.
export function matches(pattern: string, filePath: string): boolean {
  return patternToRegex(pattern).test(filePath);
}

// filePath에 매칭되는 규칙 중 priority가 가장 높은 것을 반환한다.
// 동점이면 path_pattern 사전순(오름차순)으로 결정적으로 하나를 고른다 — 재현 실험(M6)이
// 성립하려면 같은 입력에 항상 같은 규칙이 선택되어야 한다.
export function resolveRule(rules: RepoPath[], filePath: string): RepoPath | null {
  return matchingRules(rules, filePath)[0] ?? null;
}

// filePath에 매칭되는 규칙 전부를 이기는 순서(priority 내림차순, 동점이면 path_pattern 오름차순)로.
// 소유 역할 상속이 "owner가 있는 가장 높은 행"을 찾으려면 1등만이 아니라 순서 전체가 필요하다.
export function matchingRules(rules: RepoPath[], filePath: string): RepoPath[] {
  return rules
    .filter((r) => matches(r.pathPattern, filePath))
    .sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.pathPattern < b.pathPattern ? -1 : a.pathPattern > b.pathPattern ? 1 : 0;
    });
}

// 패턴이 확실히 매칭하는 대표 경로 하나. `**` 세그먼트는 디렉터리 하나로, `*`는 'x'로 채운다.
// (tests/** → tests/x, **/*.sql → x/x.sql). 규칙 "목록"을 사람·모델에게 보여줄 때
// 그 규칙이 실제 판정에서 어떻게 되는지를 판정기로 한 번 돌려보는 데 쓴다 — 판정 로직을 두 벌 두지 않기 위해서다.
export function samplePath(pattern: string): string {
  return pattern
    .split('/')
    .map((seg) => (seg === '**' ? 'x' : seg.replaceAll('*', 'x')))
    .join('/');
}
