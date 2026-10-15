import { describe, expect, it } from 'vitest';
import { buildContractPrompt, CONTRACT_JSON_SCHEMA, parseContractDraft, type ContractJob } from '../src/executor/contract.js';
import { readOnlyClaudeArgs } from '../src/executor/consult.js';
import { buildTaskPrompt } from '../src/executor/prompt.js';

const job: ContractJob = {
  id: 'c1',
  featureKey: 'F1',
  specTitle: '회원 목록',
  attempt: 2,
  feedback: '가입일은 memberSince로',
  specContent: '대표가 회원 목록을 본다.',
  apiNeeds: '회원 이름과 가입일',
  previous: { schemaYaml: 'paths:\n  /members:\n    get:\n      responses:\n        "200": { description: ok }\n', summary: '목록 API' },
};

// 계약 작성(023) — BE 노트북이 레포를 읽기만 해서 계약 초안을 쓴다. 상담 실행과 같은 읽기 전용 실행이다.
describe('계약 작성 실행', () => {
  it('읽기 전용 도구만 쓰고, 긴 프롬프트는 명령줄이 아니라 stdin으로 넘긴다', () => {
    const args = readOnlyClaudeArgs(null, '/tmp/empty.json', CONTRACT_JSON_SCHEMA);
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('--output-format'); // 프롬프트 자리가 없다 — Windows 명령줄 32k자 제한
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('acceptEdits');
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1]!)).toEqual(CONTRACT_JSON_SCHEMA);
  });

  it('프롬프트에 명세·오가는 데이터·확정한 계약·직전 초안·수정 요청·형식 위반이 들어간다', () => {
    const prompt = buildContractPrompt({
      repoName: 'acme/api',
      job,
      approved: [{ featureKey: 'F0', title: '로그인', schemaYaml: 'paths:\n  /auth/login: {}' }],
      problems: ['경로 /members에 메서드가 없다'],
    });
    for (const part of ['acme/api', '대표가 회원 목록을 본다.', '회원 이름과 가입일', '/auth/login', '목록 API', 'memberSince', '경로 /members에 메서드가 없다', '읽기만 한다']) {
      expect(prompt).toContain(part);
    }
  });

  it('처음 쓰는 계약에는 직전 초안·수정 요청 절이 없다', () => {
    const prompt = buildContractPrompt({ repoName: 'acme/api', job: { ...job, attempt: 1, feedback: null, previous: null }, approved: [] });
    expect(prompt).not.toContain('직전 초안');
    expect(prompt).not.toContain('# 수정 요청');
    expect(prompt).not.toContain('형식 검사에서 거부');
  });

  it('구조화 출력을 읽고, 빠진 필드는 실패로 본다', () => {
    expect(parseContractDraft({ openapiYaml: 'paths: {}', summary: '요약', openQuestions: ['가정 1', 3] })).toEqual({
      openapiYaml: 'paths: {}',
      summary: '요약',
      openQuestions: ['가정 1'],
    });
    expect(parseContractDraft(JSON.stringify({ openapiYaml: 'paths: {}', summary: '요약' })).openQuestions).toEqual([]);
    expect(() => parseContractDraft({ summary: '요약' })).toThrow();
    expect(() => parseContractDraft({ openapiYaml: 'paths: {}', summary: ' ' })).toThrow();
  });
});

// 태스크 실행 프롬프트(새 계획 흐름 3단계) — 확정한 계약이 FE·BE 프롬프트에 그대로 들어간다.
describe('태스크 프롬프트의 확정한 계약', () => {
  const base = { task: { id: 't1', title: 'T', teamRole: 'FRONTEND' }, repo: { fullName: 'a/web' }, spec: null, notesBlock: '', writablePaths: [{ pathPattern: '**' }] };

  it('계약이 있으면 요약과 YAML을 싣고, 없거나 옛 서버면 절이 없다', () => {
    const prompt = buildTaskPrompt({ ...base, contract: { featureKey: 'F-20', summary: '멤버 목록', schemaYaml: 'paths:\n  /api/members: {}\n' } }, 'task/t1');
    expect(prompt).toContain('# 확정한 API 계약 (F-20)');
    expect(prompt).toContain('멤버 목록');
    expect(prompt).toContain('```yaml\npaths:\n  /api/members: {}\n```');
    expect(buildTaskPrompt({ ...base, contract: null }, 'task/t1')).not.toContain('확정한 API 계약');
    expect(buildTaskPrompt(base, 'task/t1')).not.toContain('확정한 API 계약');
  });
});
