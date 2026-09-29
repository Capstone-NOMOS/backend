// CommitInspector 구현체들이 함께 쓰는 타입과 에러. commit-inspector.ts(선택)와 각 구현체가
// 서로를 import하면 순환이 생기므로 여기 따로 둔다.

export type InspectInput = {
  repoId: string;
  orgId: string;
  cloneUrl: string | null;
  githubRepoId: number | null;
  commitSha: string;
};

export type CommitInspector = {
  readonly kind: string;
  // 커밋이 건드린 경로 목록. 레포 루트 기준 상대경로, 슬래시 구분.
  // 없는 커밋이면 CommitNotFoundError(→ FAIL), 서버 쪽 사정으로 못 읽으면 InspectionSkipped(→ SKIPPED).
  changedPaths(input: InspectInput): Promise<string[]>;
};

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
