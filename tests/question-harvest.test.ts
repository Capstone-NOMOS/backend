import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { specInputSchema, taskFieldsSchema } from '../src/domain/authoring/schema.js';
import { buildHarvestRequests, harvestReport, parseHarvestScenario, pickFeatures } from '../scripts/lib/question-harvest.js';

// 질문 모으기(scripts/question-harvest.ts) — 빈칸을 심은 명세로 FE·BE 태스크를 만든다.
// 심은 빈칸의 예상 담당자는 실험자 메모라 서버로 보내지 않는다(라우터·에이전트가 보면 안 된다).

const EXAMPLE = 'scripts/examples/harvest.example.json';
const scenario = () => parseHarvestScenario(JSON.parse(readFileSync(EXAMPLE, 'utf8')));

describe('시나리오', () => {
  it('예시 시나리오를 읽고, 만드는 명세·태스크가 작성 API 입력 형식을 통과한다 — 계약 단계 없음, FE·BE가 같은 명세', () => {
    const s = scenario();
    expect(s.features.length).toBe(2);
    expect(new Set(s.features.flatMap((f) => f.plantedGaps.map((g) => g.expectedOwner)))).toEqual(new Set(['BACKEND', 'FRONTEND', 'PM', 'SELF']));
    for (const r of buildHarvestRequests(s.features, 'abc123')) {
      expect(specInputSchema.safeParse(r.spec).success).toBe(true);
      expect(r.spec.needsApi).toBe(false);
      expect(r.spec.featureKey).toBe(`${r.featureKey}-abc123`);
      expect(new Set(r.tasks.map((t) => t.teamRole))).toEqual(new Set(['FRONTEND', 'BACKEND']));
      for (const t of r.tasks) expect(taskFieldsSchema.safeParse(t).success).toBe(true);
    }
    // 꼬리표가 다르면 같은 제목 거부에 걸리지 않는다.
    expect(buildHarvestRequests(s.features, 'x1')[0]!.tasks[0]!.title).not.toBe(buildHarvestRequests(s.features, 'x2')[0]!.tasks[0]!.title);
  });

  it('서버로 보낼 본문에 심은 빈칸·예상 담당자가 없다', () => {
    const body = JSON.stringify(buildHarvestRequests(scenario().features, 't'));
    expect(body).not.toContain('expectedOwner');
    expect(body).not.toContain('plantedGaps');
    for (const g of scenario().features.flatMap((f) => f.plantedGaps)) expect(body).not.toContain(g.note);
  });

  it('--only·형식 오류', () => {
    expect(pickFeatures(scenario(), 'HV-JOIN').map((f) => f.featureKey)).toEqual(['HV-JOIN']);
    expect(() => pickFeatures(scenario(), 'NOPE')).toThrow(/없는 기능/);
    expect(() => parseHarvestScenario({ features: [{ featureKey: 'A', title: 't', content: 'c', tasks: [{ title: 'x', teamRole: 'QA' }] }] })).toThrow(/형식 오류/);
    expect(() => parseHarvestScenario({ features: [{ featureKey: 'A', title: 't', content: 'c', plantedGaps: [{ note: 'n', expectedOwner: 'BOSS' }], tasks: [{ title: 'x', teamRole: 'FRONTEND' }] }] })).toThrow(/형식 오류/);
  });

  it('dry-run 출력의 서버 요청 본문에 예상 담당자가 없다', () => {
    const res = spawnSync(path.resolve('node_modules/.bin/tsx'), ['scripts/question-harvest.ts', '--scenario', EXAMPLE, '--dry-run'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('POST /projects/:id/specs');
    expect(res.stdout).toContain('"needsApi": false');
    expect(res.stdout).not.toContain('expectedOwner');
    for (const g of scenario().features.flatMap((f) => f.plantedGaps)) expect(res.stdout).not.toContain(g.note);
  });
});

describe('집계', () => {
  it('기능별 심은 빈칸·투입 횟수·나온 질문·발생률', () => {
    const items = [
      { id: '1', input: { spec: { featureKey: 'HV-LIST-aaa' }, questions: [{}, {}], askerRole: 'FRONTEND' }, primary: { target: 'BACKEND' } },
      { id: '2', input: { spec: { featureKey: 'HV-LIST-bbb' }, questions: [{}], askerRole: 'BACKEND' }, primary: { target: 'FRONTEND' } },
      { id: '3', input: { spec: { featureKey: 'OTHER' }, questions: [{}], askerRole: 'FRONTEND' }, primary: { target: 'PM' } },
    ];
    const [list, join] = harvestReport(scenario(), items, ['HV-LIST-aaa', 'HV-LIST-bbb', 'HV-JOIN-aaa', 'OTHER']);
    expect(list).toMatchObject({ featureKey: 'HV-LIST', plantedGaps: 3, runs: 2, questionRows: 2, questions: 3, rate: '50%', byTarget: { BACKEND: 1, FRONTEND: 1 } });
    expect(join).toMatchObject({ featureKey: 'HV-JOIN', plantedGaps: 4, runs: 1, questions: 0, rate: '0%' });
  });
});
