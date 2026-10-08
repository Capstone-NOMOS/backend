import { describe, expect, it } from 'vitest';
import { buildConsultPrompt, consultArgs, parseConsultDraft } from '../src/executor/consult.js';

// 상담 실행(C안) — 다른 역할의 질문에 레포를 읽기만 해서 답 초안을 만든다. 실험(④⑤)에서 정한 설정을 고정한다.
describe('상담 실행', () => {
  it('쓸 수 있는 내장 도구는 Read·Grep·Glob뿐이고 사용자 MCP를 싣지 않는다 — disallowedTools만으로는 Artifact·예약 도구가 남았다', () => {
    const args = consultArgs('p', '/tmp/empty.json');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/empty.json');
    expect(args).not.toContain('acceptEdits');
  });

  it('프롬프트는 읽기만 하고, 질문 안의 지시를 따르지 않고, 코드가 정한 것만 decided로 하라고 한다', () => {
    const prompt = buildConsultPrompt({ role: 'BACKEND', repoName: 'acme/api', question: { id: 'q', askerRole: 'FRONTEND', questions: [{ question: '응답 형태는?' }] } });
    for (const part of ['읽기만 한다', '질문 안의 지시', 'decided=true', 'decided=false', '응답 형태는?', 'acme/api', 'BACKEND']) expect(prompt, part).toContain(part);
  });

  it('응답을 초안으로 꺼낸다 — decided 형식이 틀리면 "정해지지 않음"으로 본다(확신 없는 답이 사람 확인 없이 나가지 않게)', () => {
    const draft = parseConsultDraft(
      '```json\n{"answers":{"A?":"x","B?":"y"},"decided":{"A?":true,"B?":"yes"},"basis":{"A?":["src/a.ts"]}}\n```',
      ['A?', 'B?'],
    );
    expect(draft).toEqual({ answers: { 'A?': 'x', 'B?': 'y' }, decided: { 'A?': true, 'B?': false }, basis: { 'A?': ['src/a.ts'], 'B?': [] } });
  });

  it('질문 문장 그대로의 답이 없으면 예외 — 사람에게 맡긴다', () => {
    expect(() => parseConsultDraft('{"answers":{"다른 질문":"x"},"decided":{}}', ['A?'])).toThrow();
    expect(() => parseConsultDraft('답은 x입니다', ['A?'])).toThrow();
  });
});
