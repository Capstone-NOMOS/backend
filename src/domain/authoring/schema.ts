import { z } from 'zod';
import { TEAM_ROLES } from '../roles.js';

// 명세·태스크 입력의 형태와 상한. HTTP(routes/specs.ts·routes/tasks.ts)와 파일 들여오기(scripts/lib/import-tasks.ts)가
// 같은 정의를 쓴다 — 상한이 두 곳에 있으면 한쪽만 느슨해진다.
//
// ⚠️ 이 폴더(domain/authoring)는 운영자 노트북에서 도는 seed:tasks가 import한다. 서버 설정(config/env·config/db·logger)을
// 직접이든 간접이든 import하지 말 것 — 그러면 JWT_SECRET 없이는 스크립트가 뜨지 않는다(tests/seed-remote-tasks.test.ts가 고정).

export const AUTHORING_LIMITS = { specs: 50, tasks: 200, testsPerSpec: 30 } as const;
export const TASK_KINDS = ['IMPLEMENT', 'INTEGRATION', 'REWORK'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

// 시험지는 V2에서 **팀원 노트북에서 실행되는 코드**다. 지금은 대표만 만들 수 있지만, PM이 쓰게 되면
// 사람 검토 없이 남의 노트북에서 코드가 실행되는 경로가 생긴다 — 그때 검토 단계를 반드시 넣을 것.
export const specTestInputSchema = z
  .object({
    criterion: z.string().trim().min(1).max(500),
    testCode: z.string().min(1).max(50_000),
    // 필수다(기본값 없음). 잠근 시험지만 V2의 근거가 되는데, 빠뜨리면 조용히 false가 되어 V2가 근거 없이 돈다.
    // 잠금은 **만들 때만** 정한다 — 나중에 잠그면 이미 제출된 산출물보다 늦게 잠긴 시험지가 생긴다(locked_at < artifacts.created_at).
    locked: z.boolean(),
  })
  .strict();

export const specInputSchema = z
  .object({
    featureKey: z.string().trim().min(1).max(32),
    title: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(20_000),
    tests: z.array(specTestInputSchema).max(AUTHORING_LIMITS.testsPerSpec).default([]),
  })
  .strict();

export type SpecInput = z.infer<typeof specInputSchema>;

// 태스크 공통 필드. 레포·명세·선행 태스크를 가리키는 방식은 경로마다 다르다(API는 id, 파일은 이름·ref).
export const taskFieldsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  // NULL = 역할 제한 없음(통합 태스크). 기본값을 두지 않는 이유는 "지정을 잊은 것"과 "일부러 열어둔 것"이 달라서다(009).
  teamRole: z.enum(TEAM_ROLES).nullable(),
  kind: z.enum(TASK_KINDS).default('IMPLEMENT'),
});
