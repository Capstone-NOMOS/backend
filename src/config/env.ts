import { z } from 'zod';

// .env는 여기 한 곳에서만 읽는다. 진입점(서버·시드 스크립트·마이그레이션)마다 기억해야 하는 구조면
// 새 진입점을 만들 때마다 같은 사고가 반복된다 — scripts/seed-manual.ts가 실제로 그렇게 깨졌다.
//
// Node 22+의 내장 기능이라 dotenv 의존성이 필요 없다.
// process.loadEnvFile은 **이미 설정된 변수를 덮어쓰지 않는다**(실측 확인). 그래서 셸이나
// vitest의 test.env가 넘긴 값이 .env보다 우선한다.
//
// test에서도 읽지 않는 이유: vitest.config.ts의 test.env가 필요한 값을 전부 주므로 .env는 불필요하고,
// 읽으면 ANTHROPIC_API_KEY 같은 개발용 값이 테스트로 새어 실제 네트워크 호출이 일어날 수 있다.
const DOTENV_SKIPPED = new Set(['production', 'test']);

if (!DOTENV_SKIPPED.has(process.env.NODE_ENV ?? 'development')) {
  try {
    process.loadEnvFile();
  } catch {
    // .env가 없어도 된다 — 셸이나 CI가 환경변수를 직접 넘기는 경우가 정상이다.
    // 값이 모자라면 아래 zod 검증이 무엇이 빠졌는지 알려준다.
  }
}

const flag = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    // 서버 자신의 공개 주소와 프론트 주소는 다르다(프론트는 Vercel). 초대 링크는 사람이 여는 것이므로
    // 프론트 주소로 만든다 — API 주소로 만들면 링크를 연 사람이 JSON 화면을 본다.
    API_BASE_URL: z.string().url().optional(),
    FRONTEND_BASE_URL: z.string().url().optional(),
    // 예전 이름. 둘로 나뉘었으므로 남아 있으면 어느 쪽 의미로 썼는지 알 수 없다 — 조용히 무시하지 않고 거부한다.
    APP_BASE_URL: z.string().optional(),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    // GitHub OAuth (Device Flow). 없으면 OAuth 라우트만 502로 답하고 나머지 기능은 그대로 돈다.
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    // 저장용 대칭키. 운영은 KMS, 로컬은 이 환경변수 (base64 32바이트).
    SECRET_ENCRYPTION_KEY: z.string().optional(),
    KMS_KEY_ID: z.string().optional(),
    // V3가 커밋 diff를 어디서 읽는가. 기본값을 두지 않는다 — 배포에서 mirror가, 로컬에서 github가
    // 조용히 선택되면 V3가 전부 SKIPPED로 쌓이는데 에러는 나지 않는다.
    COMMIT_INSPECTOR: z.enum(['github', 'mirror'], {
      errorMap: () => ({ message: "COMMIT_INSPECTOR must be 'github' or 'mirror' (no default — choose explicitly)" }),
    }),
    // 브라우저 CORS 허용 오리진. 쉼표 구분. 정확 일치 또는 첫 라벨의 접두 와일드카드(https://*-team.vercel.app).
    CORS_ALLOWED_ORIGINS: z.string().optional(),
    // Swagger UI. 켜면 운영에서는 Basic Auth가 필수다(DOCS_BASIC_AUTH = "user:password").
    DOCS_ENABLED: flag,
    DOCS_BASIC_AUTH: z.string().optional(),
    // 내장 PM(NOMOS 키로 실행). 없으면 PM API만 503 PM_UNAVAILABLE이고 나머지는 그대로 돈다 —
    // 필수로 두면 SSM에 키를 넣기 전까지 운영 서버가 뜨지 않는다.
    ANTHROPIC_API_KEY: z.string().optional(),
    // api: 서버가 Anthropic API를 직접 부른다(운영). relay: 대표 노트북의 `executor pm-worker`가 자기 Claude Code로 실행한다
    // (결제 전까지의 임시 모드 — 개인 구독은 본인용이라 여러 사용자에게 PM을 제공하는 운영에서는 api를 쓴다).
    PM_PROVIDER: z.enum(['api', 'relay']).default('api'),
    // 모델·노력 수준·출력 한도는 설정값이다. 새 모델이 이상하면 이전 모델로 바꿔 비교한다.
    PM_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
    PM_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
    // 생각 토큰도 이 한도 안에 든다. 호출 한 번의 최대 비용(예산 사전 검사)이 이 값으로 정해진다.
    PM_MAX_TOKENS: z.coerce.number().int().min(1024).max(128_000).default(32_000),
    // 스트리밍 호출 전체 시간 제한. 연결이 멈춰도 pending이 영원히 남지 않게.
    PM_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    // 한 수정 체인에서 받을 수 있는 수정 요청 수(원본 요청은 세지 않는다). 중계 모드에서는 API 예산이 상한 역할을 못 하므로 서버가 센다.
    PM_MAX_REVISIONS: z.coerce.number().int().min(0).max(20).default(3),
    // 에이전트 질문(AskUserQuestion)의 유효 기간. 묻는 쪽 실행은 몇 분만 기다리고(브릿지 NOMOS_QUESTION_INLINE_WAIT_MS) 태스크를
    // BLOCKED로 내려놓는다 — 이 기간 안에 답이 오면 READY로 돌아가고, 지나면 질문은 만료되고 태스크는 ESCALATED.
    QUESTION_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(30 * 86_400_000).default(3 * 86_400_000),
  })
  .superRefine((v, ctx) => {
    if (v.APP_BASE_URL !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_BASE_URL'],
        message: 'APP_BASE_URL was split into API_BASE_URL (this server) and FRONTEND_BASE_URL (invite links); remove it',
      });
    }
    if (v.NODE_ENV === 'production') {
      // 운영에서 기본값으로 떨어지면 초대 링크가 localhost로 나간다. 명시하게 하고 https를 강제한다.
      for (const key of ['API_BASE_URL', 'FRONTEND_BASE_URL'] as const) {
        const value = v[key];
        if (value === undefined || !value.startsWith('https://')) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} must be set to an https:// URL in production` });
        }
      }
      if (v.DOCS_ENABLED === true && !v.DOCS_BASIC_AUTH) {
        // 인증 없이 열리는 Swagger를 운영에 띄우지 않는다. 조용히 끄지도 않는다 — 켜려던 의도가 있었으므로 실패시킨다.
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DOCS_BASIC_AUTH'], message: 'DOCS_ENABLED=true requires DOCS_BASIC_AUTH in production' });
      }
    }
    if (v.DOCS_BASIC_AUTH !== undefined) {
      const sep = v.DOCS_BASIC_AUTH.indexOf(':');
      if (sep < 1 || v.DOCS_BASIC_AUTH.length - sep - 1 < 12) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DOCS_BASIC_AUTH'], message: 'DOCS_BASIC_AUTH must be "user:password" with a password of 12+ characters' });
      }
    }
  })
  .transform((v) => ({
    ...v,
    API_BASE_URL: v.API_BASE_URL ?? 'http://localhost:3000',
    // 프론트(Next)는 로컬에서 3001로 뜬다(3000은 이 서버). 초대 링크가 이 주소로 만들어진다.
    FRONTEND_BASE_URL: v.FRONTEND_BASE_URL ?? 'http://localhost:3001',
    // 로컬 개발에서는 지금처럼 켜 두고, 그 외(운영·테스트)는 명시해야 켜진다.
    DOCS_ENABLED: v.DOCS_ENABLED ?? v.NODE_ENV === 'development',
  }));

export type Env = z.infer<typeof envSchema>;

// process.env를 zod 스키마로 검증하고 타입이 보장된 설정 객체를 만든다. 실패 시 즉시 종료한다.
// 값은 로그에 싣지 않는다 — 여기 오는 것들 상당수가 비밀값이다.
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid environment variables: ${issues}`);
  }
  return parsed.data;
}

function loadEnv(): Env {
  return parseEnv(process.env);
}

export const env = loadEnv();
