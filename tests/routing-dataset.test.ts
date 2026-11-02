import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RoutingInput } from '../src/domain/question/router.js';
import type { EvalRouter } from '../scripts/lib/question-routers.js';
import { parseDataset, runEvaluation, summarize } from '../scripts/lib/routing-dataset.js';

// 오프라인 라우터 평가 데이터셋(scripts/eval-question-router.ts) — v2(운영과 같은 RoutingInputSnapshot)와 옛 v1을 읽고,
// 평가는 저장된 입력을 다시 조립하지 않고 그대로 라우터에 넣는다.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const INPUT = {
  stage: 'implementation',
  askerRole: 'FRONTEND',
  roles: ['FRONTEND', 'BACKEND'],
  task: { title: 'T-1 스터디 목록 화면', kind: 'IMPLEMENT' },
  spec: { featureKey: 'F-1', title: '스터디 목록', content: '모집 중인 스터디 목록' },
  repo: { fullName: 'acme/web' },
  questions: [{ question: '한 페이지 크기는?', header: '페이지', options: [{ label: '10개' }, { label: '20개' }] }],
  contract: { featureKey: 'F-1', summary: 'GET /api/studies' },
};

// 받은 입력을 그대로 기록하는 가짜 라우터.
function recordingRouter(target: 'BACKEND' | 'FRONTEND' | 'PM' | 'SELF') {
  const seen: RoutingInput[] = [];
  const router: EvalRouter = {
    name: 'fake',
    route: async () => ({ target, confidence: null, reason: null, routedBy: 'fake' }),
    routeWithCost: async (input) => {
      seen.push(input);
      return { target, confidence: null, reason: null, routedBy: 'fake', costUsd: 0 };
    },
  };
  return { router, seen };
}

describe('데이터셋 v2', () => {
  it('항목의 input이 그대로 라우터에 들어간다 — 내보내기 응답 파일({ data: { items } })도 그대로 읽는다', async () => {
    const exported = {
      data: {
        items: [
          { id: 'q1', stage: 'implementation', input: INPUT, accept: ['BACKEND'], source: 'real-run', asked_at: '2026-11-01T00:00:00.000Z', primary: { router: 'llm', target: 'BACKEND' }, gold_labeled: true },
          { id: 'q2', input: { ...INPUT, contract: null }, accept: [], source: 'real-run', asked_at: '2026-11-01T00:00:01.000Z', primary: { router: 'llm', target: 'PM' }, gold_labeled: false },
        ],
      },
    };
    const dataset = parseDataset(exported);
    expect(dataset.format).toBe('v2');
    expect(dataset.items.map((i) => i.id)).toEqual(['q1']);
    expect(dataset.unlabeled).toEqual(['q2']);

    const { router, seen } = recordingRouter('BACKEND');
    const rows = await runEvaluation(dataset.items, router, { repeat: 2, concurrency: 2 });
    expect(seen).toHaveLength(2);
    for (const input of seen) expect(input).toEqual(INPUT);
    const summary = summarize(rows, dataset.items, 2);
    expect(summary).toMatchObject({ runs: 2, accuracy: '100%', bySource: { 'real-run': { runs: 2, accuracy: '100%' } }, byStage: { implementation: { runs: 2, accuracy: '100%' } }, unstable: 0 });
  });

  it('출처별 정확도를 낸다', async () => {
    const dataset = parseDataset({
      items: [
        { id: 'a', input: INPUT, accept: ['BACKEND'], source: 'human' },
        { id: 'b', input: INPUT, accept: ['PM'], source: 'llm', difficulty: 'trap' },
      ],
    });
    const { router } = recordingRouter('BACKEND');
    const summary = summarize(await runEvaluation(dataset.items, router, { repeat: 1, concurrency: 1 }), dataset.items, 1);
    expect(summary.bySource).toEqual({ human: { runs: 1, accuracy: '100%' }, llm: { runs: 1, accuracy: '0%' } });
  });

  it('단계별 정확도 — PM이 묻는 기능 명세 초안 질문(태스크 없음)도 읽고, stage가 없으면 implementation', async () => {
    const { stage: _s, ...noStage } = INPUT;
    const featureInput = { ...INPUT, stage: 'feature_spec', askerRole: 'PM', task: null, repo: null, contract: null };
    const dataset = parseDataset({
      items: [
        { id: 'a', input: noStage, accept: ['BACKEND'] },
        { id: 'b', input: featureInput, accept: ['PM'], source: 'human' },
      ],
    });
    expect(dataset.items.map((i) => [i.id, i.stage, i.input.stage])).toEqual([['a', 'implementation', 'implementation'], ['b', 'feature_spec', 'feature_spec']]);
    const { router, seen } = recordingRouter('BACKEND');
    const summary = summarize(await runEvaluation(dataset.items, router, { repeat: 1, concurrency: 1 }), dataset.items, 1);
    expect(summary.byStage).toEqual({ implementation: { runs: 1, accuracy: '100%' }, feature_spec: { runs: 1, accuracy: '0%' } });
    expect(seen.find((i) => i.stage === 'feature_spec')).toMatchObject({ askerRole: 'PM', task: null });
    // 항목의 stage와 input.stage가 다르면 형식 오류.
    expect(() => parseDataset({ items: [{ id: 'c', stage: 'contract', input: INPUT, accept: ['BACKEND'] }] })).toThrow(/stage\(contract\)와 input.stage\(implementation\)/);
  });

  it('형식 오류: input 필드 누락·accept에 없는 값·겹치는 id', () => {
    const { questions: _q, ...noQuestions } = INPUT;
    expect(() => parseDataset({ items: [{ id: 'a', input: noQuestions, accept: ['BACKEND'] }] })).toThrow(/items\.0\.input\.questions/);
    expect(() => parseDataset({ items: [{ id: 'a', input: INPUT, accept: ['QA'] }] })).toThrow(/items\.0\.accept\.0/);
    expect(() => parseDataset({ items: [{ id: 'a', input: INPUT, accept: ['PM'] }, { id: 'a', input: INPUT, accept: ['PM'] }] })).toThrow(/id가 겹친다/);
  });
});

describe('데이터셋 v1 (옛 형식)', () => {
  it('기존 20문항을 RoutingInputSnapshot으로 바꾼다 — stage는 implementation, roles는 [FRONTEND, BACKEND], contract는 null', () => {
    const dataset = parseDataset(JSON.parse(readFileSync('scripts/data/question-routing.json', 'utf8')));
    expect(dataset.format).toBe('v1');
    expect(dataset.items).toHaveLength(20);
    for (const item of dataset.items) {
      expect(item.stage).toBe('implementation');
      expect(item.input.stage).toBe('implementation');
      expect(item.input.roles).toEqual(['FRONTEND', 'BACKEND']);
      expect(item.input.contract).toBeNull();
      expect(item.input.questions.length).toBeGreaterThan(0);
      for (const q of item.input.questions) expect(q.options).toEqual([]);
    }
  });
});

describe('--check', () => {
  const tsx = path.resolve('node_modules/.bin/tsx');
  const run = (file: string) => spawnSync(tsx, ['scripts/eval-question-router.ts', '--check', '--data', file], { encoding: 'utf8' });

  it('v2 형식을 검사한다 — 맞으면 0, 틀리면 위반을 적고 1', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nomos-routing-ds-'));
    dirs.push(dir);
    const good = path.join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ items: [{ id: 'a', input: INPUT, accept: ['BACKEND'] }, { id: 'b', input: INPUT, accept: [] }] }));
    const ok = run(good);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('(v2)');
    expect(ok.stdout).toContain('정답 라벨이 없어 건너뜀 1건');

    const bad = path.join(dir, 'bad.json');
    const { task: _t, ...noTask } = INPUT;
    writeFileSync(bad, JSON.stringify({ items: [{ id: 'a', input: noTask, accept: ['BOSS'] }] }));
    const ng = run(bad);
    expect(ng.status).toBe(1);
    expect(ng.stderr).toContain('items.0.input.task');
    expect(ng.stderr).toContain('items.0.accept.0');
  });

  it('옛 형식(기본 데이터셋)도 통과한다', () => {
    const res = run('scripts/data/question-routing.json');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('(v1)');
    expect(res.stdout).toContain('20문항');
  });
});
