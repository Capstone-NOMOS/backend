// 브릿지가 NOMOS 서버를 부를 때 쓰는 클라이언트. MCP 서버가 이걸 통해 도구를 실행한다.
//
// 핵심 책임 하나: 401 policy_stale 처리. 경로 규칙이나 정책이 바뀌면 이미 발급된 토큰은
// 옛 스냅샷 기준이 되어 거부된다. 그때 refresh로 재발급하고 원 요청을 **1회만** 재시도한다.
// 재발급 후에도 stale이면 루프이므로 즉시 멈춘다 — 무한 재시도가 이 흐름에서 가장 흔한 사고다.

export type Tokens = { accessToken: string; refreshToken: string };

export type NomosClientOptions = {
  baseUrl: string;
  tokens: Tokens;
  fetchImpl?: typeof fetch;
  // 재발급된 access token을 저장하고 싶을 때 (브릿지는 ~/.nomos/credentials에 쓴다).
  onTokensChanged?: (tokens: Tokens) => void;
};

// 재발급 직후에도 정책이 또 바뀐 경우. 사용자에게 알리고 멈춰야 하는 신호다.
export class PolicyStaleLoopError extends Error {
  constructor() {
    super('policy changed again right after refresh; stopping instead of retrying');
    this.name = 'PolicyStaleLoopError';
  }
}

export class NomosApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  // details는 메시지에도 붙인다. MCP 도구는 err.message만 모델에게 보여주므로,
  // 여기서 빼면 NOTE_INVALID의 위반 목록이 모델에 닿지 않고 같은 요청이 반복된다.
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(details === undefined ? message : `${message} ${JSON.stringify(details)}`);
    this.name = 'NomosApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

type RawResponse = { status: number; body: Record<string, unknown> };

export class NomosClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onTokensChanged: ((tokens: Tokens) => void) | undefined;
  private current: Tokens;
  // 진단용. 통합 테스트가 "정확히 한 번만 재발급했는가"를 확인한다.
  refreshCount = 0;

  constructor(options: NomosClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onTokensChanged = options.onTokensChanged;
    this.current = options.tokens;
  }

  get tokens(): Tokens {
    return this.current;
  }

  async claimTask(taskId: string): Promise<Record<string, unknown>> {
    return (await this.request('POST', `/api/tasks/${taskId}/claim`)) as Record<string, unknown>;
  }

  async submitArtifact(
    taskId: string,
    input: { commitSha: string; changedPaths: string[] },
  ): Promise<Record<string, unknown>> {
    return (await this.request('POST', `/api/tasks/${taskId}/artifacts`, input)) as Record<string, unknown>;
  }

  // 브릿지 단계(V2·V4) 보고. 서버가 판정하는 V1A·V1B·V3는 여기로 보낼 수 없다 — 403이 돌아온다.
  async reportVerification(
    artifactId: string,
    input: {
      stage: 'V2' | 'V4';
      result: 'PASS' | 'FAIL' | 'SKIPPED';
      detail: Record<string, unknown>;
      durationMs?: number;
    },
  ): Promise<Record<string, unknown>> {
    return (await this.request(
      'POST',
      `/api/artifacts/${artifactId}/verifications`,
      input,
    )) as Record<string, unknown>;
  }

  // 모델이 MCP 도구로 제출한 산출물의 id를 Executor가 찾는 경로. 최신이 앞에 온다.
  async listArtifacts(taskId: string): Promise<Record<string, unknown>[]> {
    const data = (await this.request('GET', `/api/tasks/${taskId}/artifacts`)) as {
      artifacts: Record<string, unknown>[];
    };
    return data.artifacts;
  }

  async publishNote(
    taskId: string,
    input: {
      kind: string;
      headline: string;
      keyPoints: string[];
      affects: string[];
      supersedes?: string;
    },
  ): Promise<Record<string, unknown>> {
    return (await this.request('POST', `/api/tasks/${taskId}/notes`, input)) as Record<string, unknown>;
  }

  async readNotes(
    projectId: string,
    filter: { specId?: string; sinceSeq?: number; limit?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams();
    if (filter.specId !== undefined) params.set('spec_id', filter.specId);
    if (filter.sinceSeq !== undefined) params.set('since_seq', String(filter.sinceSeq));
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    const query = params.toString();
    const path = `/api/projects/${projectId}/notes${query ? `?${query}` : ''}`;
    const data = (await this.request('GET', path)) as { notes: Record<string, unknown>[] };
    return data.notes;
  }

  // Executor 폴링용. 에이전트 토큰이면 서버가 자기 역할로 강제 필터한다.
  async listTasks(
    projectId: string,
    filter: { state?: string; limit?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams();
    if (filter.state !== undefined) params.set('state', filter.state);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    const query = params.toString();
    const data = (await this.request('GET', `/api/projects/${projectId}/tasks${query ? `?${query}` : ''}`)) as {
      tasks: Record<string, unknown>[];
    };
    return data.tasks;
  }

  // 프롬프트와 .claude/settings.json을 만드는 데 필요한 것 한 번에.
  // 지금 가져갈 수 있는 태스크(서버가 역할·선행·시작 여부로 거른 것). 웹소켓 푸시와 같은 목록이다.
  async listClaimableTasks(): Promise<Record<string, unknown>[]> {
    const data = (await this.request('GET', '/api/agents/me/tasks')) as { tasks: Record<string, unknown>[] };
    return data.tasks;
  }

  async getBriefing(taskId: string): Promise<Record<string, unknown>> {
    return (await this.request('GET', `/api/tasks/${taskId}/briefing`)) as Record<string, unknown>;
  }

  async describeSelf(): Promise<{ projectId: string; maxConcurrent: number; teamRole: string | null }> {
    return (await this.request('GET', '/api/agents/me')) as {
      projectId: string;
      maxConcurrent: number;
      teamRole: string | null;
    };
  }

  async reportBranch(taskId: string, branchName: string): Promise<void> {
    await this.request('PATCH', `/api/tasks/${taskId}/branch`, { branchName });
  }

  // 중계 모드 PM 작업(대표 노트북의 pm-worker만).
  async nextPmJob(): Promise<Record<string, unknown> | null> {
    const data = (await this.request('GET', '/api/pm/jobs/next')) as { job: Record<string, unknown> | null };
    return data.job;
  }

  async submitPmJobResult(jobId: string, result: unknown): Promise<void> {
    await this.request('POST', `/api/pm/jobs/${jobId}/result`, result);
  }

  async failPmJob(jobId: string, message: string): Promise<void> {
    await this.request('POST', `/api/pm/jobs/${jobId}/failure`, { message });
  }

  private async request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
    const first = await this.send(method, path, body);
    if (!needsRefresh(first)) return unwrap(first);

    // 여기서부터가 재시도 경로. 재발급 → 원 요청 1회.
    await this.refresh();
    const second = await this.send(method, path, body);
    // 재발급 직후에도 같은 이유로 막히면 루프다. 두 번째 재발급은 하지 않는다.
    if (needsRefresh(second)) throw new PolicyStaleLoopError();
    return unwrap(second);
  }

  private async send(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<RawResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.current.accessToken}`,
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  private async refresh(): Promise<void> {
    this.refreshCount += 1;
    const res = await this.fetchImpl(`${this.baseUrl}/api/agents/token/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: this.current.refreshToken }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (res.status !== 200) {
      throw toApiError({ status: res.status, body });
    }
    const data = body.data as { accessToken?: string } | undefined;
    if (!data?.accessToken) {
      throw new NomosApiError(res.status, 'INVALID_REFRESH_RESPONSE', 'refresh returned no access token');
    }
    this.current = { ...this.current, accessToken: data.accessToken };
    this.onTokensChanged?.(this.current);
  }
}

function errorOf(res: RawResponse): {
  code?: string;
  message?: string;
  reason?: string;
  details?: unknown;
} {
  const error = res.body.error;
  return typeof error === 'object' && error !== null ? (error as Record<string, string>) : {};
}

// 재발급으로 풀 수 있는 401인가.
//   POLICY_STALE    경로 규칙·정책이 바뀌어 토큰이 옛 스냅샷 기준이 됐다
//   UNAUTHENTICATED access token이 만료됐다 (1시간)
// 둘 다 refresh 한 번으로 풀린다. 만료를 빼놓으면 Executor가 한 시간 뒤부터 조용히 죽는다 —
// 실제로 그렇게 멈춰 있었다.
function needsRefresh(res: RawResponse): boolean {
  if (res.status !== 401) return false;
  const code = errorOf(res).code;
  return code === 'POLICY_STALE' || code === 'UNAUTHENTICATED';
}

function toApiError(res: RawResponse): NomosApiError {
  const { code, message, details } = errorOf(res);
  return new NomosApiError(res.status, code ?? 'UNKNOWN', message ?? 'request failed', details);
}

function unwrap(res: RawResponse): unknown {
  if (res.status >= 400) throw toApiError(res);
  return res.body.data ?? {};
}
