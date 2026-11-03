// CommitInspector 구현체들이 함께 쓰는 타입과 에러. commit-inspector.ts(선택)와 각 구현체가
// 서로를 import하면 순환이 생기므로 여기 따로 둔다.

export type InspectInput = {
  repoId: string;
  orgId: string;
  cloneUrl: string | null;
  githubRepoId: number | null;
  commitSha: string;
  // 태스크 브랜치가 갈라져 나온 기본 브랜치(repos.default_branch). 주면 커밋 하나가 아니라 **기본 브랜치와의 분기점부터 이 커밋까지**를 본다 —
  // 태스크 브랜치에 커밋이 여럿이면(반려·검증 실패 뒤 이어서 고침, 질문 뒤 재개) 마지막 커밋 하나만 보면 앞 커밋의 파일이 "과다 신고"로 FAIL이었다(통합 테스트).
  // null이거나 그 브랜치를 못 찾으면 커밋 하나만 본다(예전 동작).
  baseBranch: string | null;
  // 이 태스크가 그 위에서 시작한 선행 태스크의 커밋들(같은 레포의 끝난 선행, task/repository.ts의 listPredecessorBases) — 서버가 DB로 정한다.
  // 비어 있지 않으면 기본 브랜치 대신 **커밋마다 (분기점 ... 제출 커밋)을 보고 교집합**을 이 태스크의 변경으로 본다:
  // 선행 A의 파일은 A 기준 비교에서 빠지고, 선행 B의 파일은 B 기준 비교에서 빠진다. 선행이 하나면 그 커밋 기준 비교 그대로다.
  // 선행 코드를 합치지 않고 기본 브랜치에서 시작한 태스크(옛 CLI)도 분기점이 기본 브랜치 쪽으로 잡혀 예전과 같은 결과다.
  // 한계: 두 선행이 **같은 파일**을 바꿨으면 그 파일은 이 태스크가 안 건드렸어도 변경으로 잡힌다(드물다 — 신고 누락 FAIL로 드러난다).
  baseCommits?: string[];
};

// 선행 기준 비교들의 교집합. 순서는 첫 비교의 순서를 따른다.
export function intersectChanged(lists: string[][]): string[] {
  if (lists.length === 0) return [];
  const rest = lists.slice(1).map((l) => new Set(l));
  return lists[0]!.filter((p) => rest.every((s) => s.has(p)));
}

export type CommitInspector = {
  readonly kind: string;
  // 태스크 브랜치가 건드린 경로 목록(baseBranch 참고). 레포 루트 기준 상대경로, 슬래시 구분.
  // 없는 커밋이면 CommitNotFoundError(→ FAIL), 서버 쪽 사정으로 못 읽으면 InspectionSkipped(→ SKIPPED).
  changedPaths(input: InspectInput): Promise<string[]>;
  // 태스크 브랜치 직전(분기점, 없으면 부모)과 그 커밋의 파일 내용 — dep:add 판정(package.json의 의존성 diff)이 쓴다. 없던 파일·지운 파일은 null.
  // 못 읽으면 던진다(호출부는 fail closed — dep:add로 본다). 구현하지 않은 검사기도 같은 취급이다.
  fileVersions?(input: InspectInput, filePath: string): Promise<{ before: string | null; after: string | null }>;
};

// 매니페스트는 작다. 이보다 크면 의존성 판정 대상이 아니라고 보고 읽지 않는다(던진다 → fail closed).
export const MAX_MANIFEST_BYTES = 512 * 1024;

export class CommitNotFoundError extends Error {
  constructor(readonly commitSha: string, cause?: unknown) {
    super(`commit ${commitSha} not found`);
    this.name = 'CommitNotFoundError';
    this.cause = cause;
  }
}

// "못 읽었다"를 사유와 함께 알린다. FAIL과 구분하는 이유: 에이전트 잘못이 아닌 일로 FAIL을 적으면
// retry_count가 올라 재시도 기회를 잃는다. 사유는 verifications.detail.reason에 그대로 남는다.
export class InspectionSkipped extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'InspectionSkipped';
  }
}
