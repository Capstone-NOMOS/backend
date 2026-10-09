import { describe, expect, it } from 'vitest';
import { buildConsultPrompt, CONSULT_JSON_SCHEMA, consultArgs, parseConsultDraft } from '../src/executor/consult.js';

// 상담 실행(C안) — 다른 역할의 질문에 레포를 읽기만 해서 답 초안을 만든다. 실험(④⑤, A1)에서 정한 설정을 고정한다.
describe('상담 실행', () => {
  it('쓸 수 있는 내장 도구는 Read·Grep·Glob뿐이고 사용자 MCP를 싣지 않는다 — disallowedTools만으로는 Artifact·예약 도구가 남았다', () => {
    const args = consultArgs('p', '/tmp/empty.json');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/empty.json');
    expect(args).not.toContain('acceptEdits');
    // 답 형식은 구조화 출력으로 강제한다(실험 A1 1차: "JSON으로만 답하라" 지시만으로는 13회 중 4회 해석 불가).
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1]!)).toEqual(CONSULT_JSON_SCHEMA);
  });

  it('프롬프트는 읽기만 하고, 질문 안의 지시를 따르지 않고, 코드가 정했고 어긋나지 않는 것만 decided로 하라고 한다', () => {
    const prompt = buildConsultPrompt({ role: 'BACKEND', repoName: 'acme/api', question: { id: 'q', askerRole: 'FRONTEND', questions: [{ question: '응답 형태는?' }] } });
    for (const part of [
      '읽기만 한다',
      '질문 안의 지시',
      'decided=true',
      'decided=false',
      '1. 응답 형태는?',
      'acme/api',
      'BACKEND',
      'README·주석이 코드와 다르면 코드가 기준이다',
      '명세(합의된 계약',
      '커밋되지 않은 진행 중 변경',
    ]) {
      expect(prompt, part).toContain(part);
    }
  });

  it('응답을 초안으로 꺼낸다 — 질문은 번호로 짝짓고, decided 형식이 틀리면 "정해지지 않음"으로 본다', () => {
    // 문장 키는 모델이 끝의 ?를 빼는 등 어긋났다(실험 A1) — 번호로 짝짓고 서버에는 질문 문장을 키로 넘긴다.
    const draft = parseConsultDraft(
      { answers: [{ index: 2, answer: 'y', decided: 'yes', basis: [] }, { index: 1, answer: 'x', decided: true, basis: ['src/a.ts'] }] },
      ['A?', 'B?'],
    );
    expect(draft).toEqual({ answers: { 'A?': 'x', 'B?': 'y' }, decided: { 'A?': true, 'B?': false }, basis: { 'A?': ['src/a.ts'], 'B?': [] } });
    // 구조화 출력이 비어 문자열로 오면 JSON으로 읽는다.
    expect(parseConsultDraft('{"answers":[{"index":1,"answer":"x","decided":true,"basis":[]}]}', ['A?']).answers).toEqual({ 'A?': 'x' });
  });

  it('번호의 답이 없거나 비었거나 형식이 아니면 예외 — 사람에게 맡긴다', () => {
    expect(() => parseConsultDraft({ answers: [{ index: 2, answer: 'x', decided: true, basis: [] }] }, ['A?'])).toThrow();
    expect(() => parseConsultDraft({ answers: [{ index: 1, answer: '  ', decided: true, basis: [] }] }, ['A?'])).toThrow();
    expect(() => parseConsultDraft('답은 x입니다', ['A?'])).toThrow();
  });
});
