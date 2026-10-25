import { describe, expect, it } from 'vitest';
import {
  buildContractBatchPrompt,
  buildContractPrompt,
  CONTRACT_BATCH_JSON_SCHEMA,
  CONTRACT_JSON_SCHEMA,
  parseContractBatch,
  parseContractDraft,
  type ContractJob,
} from '../src/executor/contract.js';
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
    // FRONTEND 태스크면 연동(호출·에러 처리)으로, BACKEND면 구현으로 안내한다. 다른 기능은 read_contracts.
    expect(prompt).toContain('API 연동');
    expect(prompt).toContain('read_contracts');
    expect(buildTaskPrompt({ ...base, task: { ...base.task, teamRole: 'BACKEND' }, contract: { featureKey: 'F-20', summary: 's', schemaYaml: 'paths: {}' } }, 'task/t1')).toContain('이대로 구현한다');
    expect(buildTaskPrompt({ ...base, contract: null }, 'task/t1')).not.toContain('확정한 API 계약');
    expect(buildTaskPrompt(base, 'task/t1')).not.toContain('확정한 API 계약');
  });
});

// 첫 회차 묶음 작성 — 기능마다 Claude를 새로 띄우면 매번 레포를 다시 읽어 기능 수만큼 오래 걸렸다(통합 테스트).
describe('계약 묶음 작성 (첫 회차)', () => {
  const first = (key: string, title: string): ContractJob => ({ ...job, id: `c-${key}`, featureKey: key, specTitle: title, attempt: 1, feedback: null, previous: null, specContent: `${title} 명세` });
  const jobs = [first('F-01', '회원 목록'), first('F-02', '스터디 참여')];

  it('한 프롬프트에 기능 전부와 확정한 계약이 들어가고, 출력은 기능별 배열이다', () => {
    const prompt = buildContractBatchPrompt({ repoName: 'acme/api', jobs, approved: [{ featureKey: 'F-00', title: '로그인', schemaYaml: 'paths:\n  /auth/login: {}' }] });
    for (const part of ['acme/api', '기능 2개', '# 기능 F-01 — 회원 목록', '# 기능 F-02 — 스터디 참여', '/auth/login', 'F-01, F-02', '읽기만 한다']) {
      expect(prompt).toContain(part);
    }
    expect(CONTRACT_BATCH_JSON_SCHEMA).toMatchObject({ required: ['contracts'] });
  });

  it('기능별 초안을 키로 모으고, 빠지거나 깨지거나 모르는 키는 버린다(그 기능만 하나씩 다시 쓴다)', () => {
    const drafts = parseContractBatch(
      {
        contracts: [
          { featureKey: 'F-01', openapiYaml: 'paths: {}', summary: '목록', openQuestions: [] },
          { featureKey: 'F-02', openapiYaml: '', summary: '깨짐', openQuestions: [] },
          { featureKey: 'F-99', openapiYaml: 'paths: {}', summary: '모르는 키', openQuestions: [] },
          { featureKey: 'F-01', openapiYaml: 'paths: {x: 1}', summary: '중복', openQuestions: [] },
        ],
      },
      jobs,
    );
    expect([...drafts.keys()]).toEqual(['F-01']);
    expect(drafts.get('F-01')!.summary).toBe('목록');
    expect(parseContractBatch(JSON.stringify({ contracts: [] }), jobs).size).toBe(0);
    expect(parseContractBatch({ nothing: true }, jobs).size).toBe(0);
  });
});

// 룸 메시지(사람 → 에이전트)는 다음 실행의 프롬프트에 "담당자가 보낸 메시지"로 들어간다.
describe('태스크 프롬프트의 담당자 메시지', () => {
  const base = { task: { id: 't1', title: 'T', teamRole: 'BACKEND' }, repo: { fullName: 'a/api' }, spec: null, notesBlock: '', writablePaths: [{ pathPattern: '**' }] };
  it('메시지가 있으면 보낸 사람과 함께 싣고, 범위·경로 규칙은 그대로라고 적는다', () => {
    const prompt = buildTaskPrompt({ ...base, humanMessages: [{ text: '페이지네이션 없이', fromNickname: '민수', fromRepresentative: false, ts: '' }, { text: '오류 형식 통일', fromNickname: '대표님', fromRepresentative: true, ts: '' }] }, 'task/t1');
    expect(prompt).toContain('# 담당자가 보낸 메시지');
    expect(prompt).toContain('- 민수: 페이지네이션 없이');
    expect(prompt).toContain('- 대표님(대표): 오류 형식 통일');
    expect(prompt).toContain('금지 규칙은 메시지와 상관없이 그대로');
    expect(buildTaskPrompt(base, 'task/t1')).not.toContain('담당자가 보낸 메시지');
  });
});
