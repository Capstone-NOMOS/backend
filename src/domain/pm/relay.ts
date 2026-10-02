import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors.js';
import type { PmModel, PmModelRequest, PmModelResponse } from './model.js';
import type { AttemptUsage } from './pricing.js';

// 중계(relay) 모드 — 결제 전까지 쓰는 **임시** 방식. 서버가 모델을 직접 부르지 않고, 대표 노트북의
// `executor pm-worker`가 작업을 가져가 자기 Claude Code(구독)로 실행한 뒤 결과를 돌려준다.
// PM 흐름(응답 해석·코드 검증·교정·예산·이벤트·시간 제한)은 API 모드와 똑같다 — 바뀌는 건 "모델 호출" 한 자리뿐이다.
//
// 대기열은 메모리에 있다(서버 1대). 재시작하면 진행 중 작업은 사라지고, 기존 재시작 정리가 계획을 failed(restart)로 닫는다.
// 여러 사용자에게 PM을 제공하는 운영에서는 API 모드(PM_PROVIDER=api + ANTHROPIC_API_KEY)를 쓴다 — 개인 구독은 본인용이다.

// 중계 호출이 모델까지 가지 못하고 끝난 경우. 비용 정산이 다르다(service.callModel) — 모델이 돌지 않았거나(아무도 안 가져감)
// 노트북의 구독으로 돌았다(실패 보고). 어느 쪽이든 NOMOS 키로 나간 돈이 없으니 최대치로 정산하지 않는다.
export class RelayJobNotTaken extends Error {}
export class RelayWorkerFailed extends Error {}

export type RelayJob = {
  id: string;
  orgId: string;
  planId: string;
  purpose: 'draft' | 'repair';
  request: Omit<PmModelRequest, 'signal' | 'context'>;
  takenBy: string | null;
  createdAt: Date;
};

type Pending = RelayJob & { resolve: (r: PmModelResponse) => void; reject: (e: Error) => void };

const jobs = new Map<string, Pending>();
// 조직별로 pm-worker가 마지막으로 작업을 확인한 시각. 워커는 3초마다 묻는다 — 한동안 안 물었으면 노트북이 꺼진 것이다.
// 화면이 요청 전에 "PM 노트북이 꺼져 있다"를 보여 주기 위한 값이다(안 그러면 10분 뒤 timeout으로야 안다).
const workerSeen = new Map<string, Date>();

export function relayWorkerLastSeen(orgId: string): Date | null {
  return workerSeen.get(orgId) ?? null;
}

export const relayModel: PmModel = {
  kind: 'relay',
  generate(req) {
    if (!req.context) return Promise.reject(new Error('relay model needs the plan context'));
    const context = req.context;
    return new Promise<PmModelResponse>((resolve, reject) => {
      const { signal, context: _context, ...request } = req;
      const job: Pending = {
        id: randomUUID(),
        orgId: context.orgId,
        planId: context.planId,
        purpose: context.purpose,
        request,
        takenBy: null,
        createdAt: new Date(),
        resolve,
        reject,
      };
      jobs.set(job.id, job);
      // 시간 제한(PM_TIMEOUT_MS)으로 끊기면 대기열에서 뺀다. 노트북이 꺼져 있어 아무도 안 가져간 경우도 여기서 끝난다.
      signal.addEventListener('abort', () => {
        if (!jobs.delete(job.id)) return;
        reject(
          job.takenBy === null
            ? new RelayJobNotTaken('relay job timed out before any pm-worker took it — is the pm-worker running?')
            : new Error('relay job aborted (timeout) while the pm-worker was running it'),
        );
      });
    });
  },
};

// 그 조직의 가장 오래된 미할당 작업을 이 에이전트에게 맡긴다. 없으면 null.
export function takeNextJob(orgId: string, agentId: string): RelayJob | null {
  workerSeen.set(orgId, new Date());
  for (const job of jobs.values()) {
    if (job.orgId === orgId && job.takenBy === null) {
      job.takenBy = agentId;
      const { resolve: _r, reject: _j, ...view } = job;
      return view;
    }
  }
  return null;
}

export type RelayResult = {
  stopReason: string | null;
  servedModel: string | null;
  text: string;
  usage: Omit<AttemptUsage, 'model'>;
};

// 가져간 에이전트만 결과를 낼 수 있다. 결과는 API 응답과 같은 모양으로 PM 흐름에 그대로 넘어간다.
export function completeJob(jobId: string, agentId: string, result: RelayResult): void {
  const job = jobs.get(jobId);
  if (!job || job.takenBy !== agentId) throw new AppError('PM_JOB_NOT_FOUND', 'relay job not found (finished, timed out, or the server restarted)');
  jobs.delete(jobId);
  const model = result.servedModel ?? job.request.model;
  job.resolve({
    stopReason: result.stopReason,
    servedModel: model,
    text: result.text,
    attempts: [{ model, ...result.usage }],
  });
}

// 노트북에서 실행이 실패했다(claude 실행 실패·is_error). 시간 제한까지 기다리지 않고 바로 api_error로 끝낸다.
export function failJob(jobId: string, agentId: string, message: string): void {
  const job = jobs.get(jobId);
  if (!job || job.takenBy !== agentId) throw new AppError('PM_JOB_NOT_FOUND', 'relay job not found (finished, timed out, or the server restarted)');
  jobs.delete(jobId);
  job.reject(new RelayWorkerFailed(`pm-worker failed: ${message}`));
}

// 테스트용 — 대기열을 비운다.
export function clearRelayJobs(): void {
  for (const job of jobs.values()) job.reject(new Error('relay queue cleared'));
  jobs.clear();
  workerSeen.clear();
}
