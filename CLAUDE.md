# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트

NOMOS 서버 — 여러 개발자가 각자 노트북에서 Claude Code 에이전트를 돌릴 때 그 사이의 계약·권한·분쟁을 조율하는 서버. 현재 구현 범위는 조직·레포·경로 소유권·초대, 로컬 계정과 CLI 연결(브라우저 승인 포함), 프로젝트·태스크·산출물·인계 노트·검증, 명세·태스크 작성, 내장 PM의 계획 수립(마이그레이션 014까지), AWS 배포다.

설계 원칙(위반 금지): **P1** 상태는 서버가 소유하고 클라이언트는 전이를 요청만 한다. **P3** 모든 행동은 사람에게 귀속된다(`on_behalf_of` 없는 이벤트는 없다). **P5** 모든 상태 변화는 `events`에 append되고 events가 유일한 진실이다.

설계 결정의 근거는 이 파일에 있다. 무엇이 정본인가: 스키마는 `migrations/`(그린 문서는 `docs/erd.dbml`), 동작은 코드와 테스트, 규칙과 그 이유는 이 파일.

전체 서비스 설계는 두 문서다: `docs/planning.md`(파이프라인 — 어떤 순서로 무슨 일이 벌어지는가), `docs/construction.md`(컴포넌트 — 어떤 모듈이 무엇을 맡는가). **둘 다 초안이다** — 구현되지 않은 계획과 뒤집힌 옛 결정이 섞여 있으므로 코드·이 파일과 다르면 그쪽이 맞다.

## 명령어

```bash
npm run build                       # tsc -> dist/
npm run dev                         # tsx watch src/index.ts (스키마가 뒤처져 있으면 뜨지 않는다)
npm start                           # node dist/boot.js server (build 후, 운영과 같은 진입점)
npm run migrate up                  # 마이그레이션 적용 (down도 지원)
npm test                            # vitest run (전체)
npm run seed                        # 수동 테스트용 시드 (기존 데이터 비우고 같은 상태 재생성, 로컬 DB만)
npm run seed:tasks -- <projectId> <파일.json> --as <대표> [--apply]   # 기존 프로젝트에 명세·태스크만 INSERT (운영용, 기본 dry-run)
npm run typecheck                   # src + scripts 타입체크
npm run executor -- connect --server http://localhost:3000   # 로그인 → 배정 대기 → 폴링 (팀원은 npx @capstone-nomos/cli@latest connect)
npm run executor once               # READY 태스크 하나 처리 (start=폴링, clean=worktree 정리, doctor=설치 점검)
npm run executor -- login <baseUrl> # 로그인만 (--connect-key=연결 키 경로, refresh=재발급). 플래그를 넘기려면 -- 필수
npm run build:cli                   # CLI 패키지 → packages/cli/dist (check:cli-package = pack·설치·실행 점검)
docker build -t nomos-server .      # 운영 이미지. 배포 절차는 docs/deploy-aws.md
npm run verify:settings             # worktree의 settings.json을 서버 판정과 대조
npm run db:psql                     # .env의 DATABASE_URL로 조회 (접속 대상을 첫 줄에 찍는다)
npm run db:psql -- "SELECT ..."     # 임의 SQL

npx tsc -p tsconfig.json --noEmit   # 타입체크만 (tests/는 제외됨 — vitest가 별도로 검사)
npx vitest run tests/glob.test.ts   # 단일 파일
npx vitest run -t "기본 경로 규칙"    # 이름으로 단일 테스트
```

### 환경변수

`.env`는 **`src/config/env.ts` 한 곳에서만 읽는다**(Node 내장 `process.loadEnvFile`, dotenv 의존성 없음).
진입점마다 로드하는 구조면 새 진입점을 만들 때마다 같은 사고가 반복된다 — `scripts/seed-manual.ts`가 실제로 그렇게 깨졌다.

- **이미 설정된 환경변수가 `.env`보다 우선한다**(`loadEnvFile`의 동작, 실측 확인). `DATABASE_URL=... npm run seed`로 한 번만 덮어쓸 수 있다.
- `NODE_ENV`가 `production` 또는 **`test`**면 `.env`를 읽지 않는다. 테스트는 `vitest.config.ts`의 `test.env`만 쓴다 —
  읽으면 개발용 `DATABASE_URL`·`GITHUB_TOKEN`이 테스트로 새어 **테스트가 개발 DB를 TRUNCATE**하거나 실제 네트워크를 호출한다.
  `tests/env-loading.test.ts`가 이 격리를 고정한다.
- `npm run migrate`는 node-pg-migrate라는 **별도 프로세스**라 `env.ts`를 거치지 않는다. 그래서 npm 스크립트에서
  Node의 `--env-file-if-exists=.env`로 같은 파일을 읽힌다. 새 CLI 진입점을 추가하면 같은 처리를 해줄 것.
- `DATABASE_URL`의 **포트를 확인할 것.** 도커 컨테이너는 수동 `55433`·자동 테스트 `55432`, 호스트에 설치한 PostgreSQL은 보통 `5432`이고
  둘 다 `nomos_dev`를 가질 수 있다. 포트만 틀리면 조용히 다른 DB에 붙어 `relation ... does not exist`가 난다.

### 테스트용 DB

테스트는 **실제 PostgreSQL을 쓴다. DB를 목킹하지 말 것** — 이 코드베이스의 상당 부분이 SQL 제약(부분 유니크 인덱스, DEFERRABLE FK, CHECK)에 의존하므로 목킹하면 검증 대상이 사라진다.

```bash
# 자동 테스트용 — npm test가 이 스키마를 매 파일마다 drop하고 다시 만든다
docker run -d --name nomos-db-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=nomos_test -p 55432:5432 postgres:16-alpine

# 수동 테스트용 — .env의 DATABASE_URL이 가리키는 쪽
docker run -d --name nomos-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=nomos_dev -p 55433:5432 postgres:16-alpine
```

호스트 포트를 5432가 아닌 55433으로 두는 이유: Windows의 TCP 동적 포트 범위가 1024~15000인 환경에서는 WinNAT/Hyper-V가
그 안의 구간을 부팅마다 임의로 예약해(실제로 5355~5454가 잡혔다) 컨테이너가 `bind: forbidden`으로 뜨지 않는다. 15000 위이면서
SSM 포트 포워딩(`15432`)·자동 테스트(`55432`)와 겹치지 않는 번호를 골랐다.

DB 이름은 환경마다 다르다: 운영 RDS `nomos` · 로컬 수동 `nomos_dev` · 자동 테스트 `nomos_test`. 로컬을 운영과 같은 `nomos`로 두지 않는 이유는
위의 포트 혼동과 같다 — 이름이 같으면 어느 쪽에 붙었는지 드러나지 않는다.
예전 이름(`ai_hq`·`ai_hq_test`)으로 만든 컨테이너는 한 번만 이름을 바꾼다(데이터는 유지된다, 서버·테스트를 끈 상태에서):
```bash
docker exec nomos-db-test psql -U postgres -c "ALTER DATABASE ai_hq_test RENAME TO nomos_test"
docker exec nomos-db      psql -U postgres -c "ALTER DATABASE ai_hq RENAME TO nomos_dev"   # 그리고 .env의 DATABASE_URL 끝을 /nomos_dev로
```

컨테이너 둘의 이름·포트·DB 이름이 모두 다르다. **DB를 조회할 때 컨테이너 이름을 쓰지 말고 `npm run db:psql`을 쓸 것** —
`.env`의 `DATABASE_URL`을 그대로 써서 서버가 실제로 붙는 DB를 보고, 접속 대상을 첫 줄에 찍는다.
`docker exec <컨테이너> psql`로 조회하면 다른 쪽 DB를 보게 되는 사고가 실제로 있었다.
**반복되는 혼동은 문서 경고가 아니라 이렇게 고를 여지를 없애서 막는다.**


### 픽스처 작성 규칙

새 픽스처는 **그 상태를 만드는 서비스 함수가 있으면 직접 INSERT하지 않는다.** 직접 INSERT는 서비스가 지키는
불변식(`agents.org_id = users.org_id` 등)을 조용히 건너뛰고, 그렇게 만든 상태 위에서 통과한 테스트는 실제로는
아무것도 보장하지 않는다. 서비스 함수가 아직 없는 테이블(Phase 2 스키마)만 직접 INSERT하고 이유를 주석으로 남긴다.
**기존 픽스처를 이 규칙에 맞춰 리팩터링하지 말 것 — 신규에만 적용한다.**

DB 제약으로 올릴 수 있는 불변식은 마이그레이션으로 올려 잘못된 픽스처가 INSERT에서 죽게 만든다(008이 선례).
테이블을 가로질러야 알 수 있어 CHECK로 표현 못 하는 것만 `tests/helpers/assert-invariants.ts`에 넣고,
`tests/setup-invariants.ts`의 전역 `afterEach`가 매 테스트 뒤에 확인한다. afterAll로 몰면 어느 테스트가 깼는지를 잃는다.

`npm run dev`로 띄우면 <http://localhost:3000/docs>에 Swagger UI가 올라온다(운영은 `DOCS_ENABLED` + Basic Auth — 배포 절 참고).
`docs/openapi.yaml`은 **손으로 쓰지만 테스트가 코드와 대조하는 계약이다.** FE가 여기서 타입을 생성한다(`openapi-typescript`) — 그래서 모든 성공 응답에 `schema`가 있어야 한다(example은 타입이 되지 않는다).
- `tests/setup-invariants.ts`가 Express `res.json`을 감싸 **테스트가 내는 모든 `/api` 응답**을 문서의 schema로 검사한다(`tests/helpers/openapi-contract.ts`, ajv).
  문서에 없는 필드가 오면 실패다(객체는 기본 `additionalProperties: false`) — "문서엔 `userId`, 실제는 `id`"가 실제로 있었다. 에러 응답은 공통 `Error` 형태만 본다.
- `tests/openapi-contract.test.ts`가 **라우트와 문서가 1:1**인지(`src/routes/*.ts`를 전부 읽는다), 모든 2xx에 schema가 있는지, 그리고 **모든 성공 응답을 실제 HTTP로 한 번 이상 받는지** 확인한다.
  API를 추가하면 문서에 경로·schema를 쓰고 그 흐름에 호출 한 줄을 넣어야 CI가 통과한다.
- 응답 필드를 바꾸면 문서를 같이 고친다 — 안 고치면 테스트가 잡는다. 스키마는 `components.schemas`에 두고 응답에서는 `$ref`로 쓴다.
- 코드로 생성하지 않고 손으로 쓰는 이유: 사람이 읽는 설명(한국어 description·예시)이 문서의 절반이라 YAML이 읽기 쉽다. 대신 틀리면 테스트가 잡는다.
`{{PROJECT_ID}}` 같은 자리표는 `/docs/openapi.json`을 서빙할 때마다 DB에서 읽어 채우므로(`src/openapi/spec.ts`) 재시드 후 새로고침만 하면 된다.

수동으로 서버를 띄워 API를 손으로 찔러보는 절차는 `docs/manual-test.md`에 있다 — 기동·환경변수·API 25개 curl 예시·시나리오 대본.
`npm run seed`(`scripts/seed-manual.ts`)가 대표·팀원 2명·레포 2개·프로젝트·READY 태스크 4개를 만들고 토큰과 id를 표로 출력한다.
**명세·태스크만** 직접 INSERT하고 나머지는 서비스 함수를 거친다(프로젝트는 011의 `createProject`를 쓴다). **수동 테스트 DB는 `nomos_dev`이고 자동 테스트는 `nomos_test`다 — 섞지 말 것.**

접속 문자열과 `JWT_SECRET`은 `vitest.config.ts`의 `test.env`에 하드코딩되어 있다(`localhost:55432/nomos_test`). 빠른 사용자·조직 생성은 `tests/fixtures.ts`(scrypt를 거치지 않음), 인증 자체를 검증할 때는 `signup()`을 쓴다. `tests/test-db.ts`의 `resetSchema()`가 매 테스트 파일 시작 시 스키마를 drop 후 재생성하므로 별도 마이그레이션 실행은 필요 없다. 테스트 파일 간 스키마를 공유하므로 `fileParallelism: false`로 직렬 실행한다.

## 아키텍처

### 레이어와 의존 방향

`routes → service → repository → pg`. 역방향 import는 없다.

- **routes** — zod 스키마를 라우트 정의 옆에 두고 `validate` 미들웨어로 적용. 비즈니스 로직 금지.
  성공 응답은 전부 `{ data: ... }`이고 **목록은 `{ data: { <복수명>: [...] } }`로 감싼다**(`tasks`, `paths`, `notes`, ...) —
  한 곳만 배열을 그대로 내면 클라이언트가 엔드포인트별로 다르게 풀어야 한다(`notes`가 실제로 그랬다).
- **service** — 트랜잭션 경계. `withTransaction`을 열고 repository 호출 + `appendEvent`를 묶는다. **SQL을 몰라야 한다.**
- **repository** — SQL만. `snake_case` ↔ `camelCase` 변환을 `toXxx(row)` 함수로 **명시적으로** 한다(자동 변환 라이브러리 금지 — 조용히 틀리면 디버깅이 어렵다).

### 이벤트 소싱이 핵심 제약이다

`src/domain/events/append.ts`의 `appendEvent(tx, ...)`가 **events 테이블에 쓰는 유일한 경로**이고, `tx`를 필수 인자로 받는다. 상태 변경과 이벤트가 같은 트랜잭션에 있어야 "상태는 바뀌었는데 이벤트가 없는" 상황이 생기지 않는다.

```ts
await withTransaction(async (tx) => {
  const repo = await insertRepo(tx, ...)
  await insertSeedRepoPaths(tx, repo.id, SEED_PATH_RULES)
  await appendEvent(tx, { type: 'REPO_CONNECTED', onBehalfOf: userId, ... })
})
```

`on_behalf_of`는 NOT NULL이고 절대 비울 수 없다(모든 행동은 사람에게 귀속된다는 원칙의 구현체). 시스템이 주체면 `'system:planner'`처럼 명시적 문자열을 쓴다 — 빈 문자열이나 `'system'` 같은 모호한 값 금지. events는 append-only로, UPDATE/DELETE하지 않는다.

조직에 들기 전의 행동(가입, 연결 키 교체, CLI 연결)은 `orgId: null`로 기록한다(003에서 `events.org_id` nullable). `orgId`는 생략할 수 없는 필수 인자라 호출부가 의식적으로 `null`을 고르게 되어 있다. **비밀값(연결 키·토큰·비밀번호)은 payload에 절대 넣지 않는다** — events는 지워지지 않는다.

### 순환 FK

`organizations.created_by → users.id`와 `users.org_id → organizations.id`가 서로를 참조한다. 해법은 두 UUID를 `randomUUID()`로 **애플리케이션에서 미리 생성**하고, `fk_org_created_by`를 `DEFERRABLE INITIALLY DEFERRED`로 선언해 커밋 시점에 검사되게 하는 것이다(`migrations/001_init.sql`).

003 이후에는 사용자가 가입으로 먼저 생기고, 조직을 만들거나 초대를 수락할 때 `users.org_id`를 NULL→값으로 채운다(`assignUserToOrg`). `org_id`는 **한 번만** 바뀐다 — 단일 조직 규칙은 `UPDATE ... WHERE org_id IS NULL` 조건 하나로 지켜지므로 이걸 빼면 안 된다. 같은 순간에 `agents.org_id`도 채운다(`assignAgentsToOrg`, 불변식: `agents.org_id = users.org_id`).

### 경로 소유권 모델

레포를 연결하면 `seed-paths.ts`의 규칙 15개가 `repo_paths`에 자동 삽입된다(`source='seed'`, `owner_role`은 전부 null). 대표가 `**` 행의 소유자를 지정하는 것이 온보딩의 실질적 산출물이다.

**레포 연결(`POST /api/orgs/:orgId/repos`)과 그 드롭다운(`GET .../github/repos`)은 대표 전용이 아니다** — 조직 멤버 누구나 한다. `repos` 행은 그 자체로 권한을 만들지 않기 때문이다: 판정이 읽는 경로 규칙은 `project_repos`에 조인된 레포만이므로(`listProjectRepoPaths`) 연결만 된 레포는 어떤 에이전트도 건드릴 수 없다. **실제 관문인 소유권 지정(`updatePathOwnership`)·규칙 추가(`addRepoPath`)·프로젝트 투입(`createProject`의 `repoIds`)은 대표 전용으로 남겨야 한다** — 그걸 함께 열면 "연결을 열었다"가 "권한을 열었다"가 된다(`tests/repo-paths.test.ts`의 '레포 연결 권한' 블록이 이 경계를 고정한다).

**소유 역할은 상속되고, 상속할 게 없으면 기본 거부다**(B-2, `docs/construction.md` §3.0). 한 경로에 대해
**접근(`access`)·행동 키(`action_key`)는 이기는 행**(가장 높은 priority)에서, **소유 역할은 `owner_role`이 NULL이 아닌 가장 높은 행**에서
가져온다(`domain/policy/scope-check.ts`의 `resolvePathPolicy`). 시드는 `**`만 대표가 소유자를 정하고 `tests/**`·`migrations/**` 등은
owner가 NULL이므로, 그 파일들은 `**`의 소유 역할을 따른다. 상속할 소유자가 하나도 없으면 **아무도 쓸 수 없다.**
- `owner_role`이 NULL인 행을 "누구나"로 읽지 말 것. 예전 구현이 그랬고, BACKEND 레포의 테스트를 FE 에이전트가 고칠 수 있었다.
- 소유권은 **쓰기에만** 적용한다. 읽기는 `denied`만 막는다(`contracts/**`는 누구나 읽는다). 운영 호출부(제출·V3)는 전부 쓰기다.
- 금지(`denied`)·읽기 전용 판정이 소유권보다 먼저다. 소유자가 없어 막힌 것은 `path_violation=false`(남의 영역 침범이 아니다),
  **다른 역할이 소유한 경로**에 쓴 것만 `path_violation=true`다 — M5′ 분자가 이 구분에 기댄다.
- 경로 판정 거부에는 `TOOL_DENIED.payload.reason`(`owned_by_other`·`unowned`·`read_only`·`denied_path`·`no_rule`)이 붙는다.
  **집계는 이 값으로 한다** — `stage='ownership'`에 여러 경우가 섞이고 `detail`은 사람이 읽는 문구라, 문구로 세면 고치는 순간 지표가 0이 된다.
  `unowned`는 "온보딩 소유권 지정 누락" 지표다(M5′에서 제외). V3 FAIL은 `verifications.detail.denialReason`에 같은 값.
- 브리핑의 `writablePaths`는 규칙마다 대표 경로(`glob.ts`의 `samplePath`)를 만들어 **같은 판정기**를 돌린 결과다. 판정 로직을 두 벌 두지 말 것.
- 테스트 픽스처는 온보딩처럼 `**` 소유자를 지정해야 한다(`tests/fixtures.ts`의 `assignRootOwner`). 안 하면 기본 거부로 제출이 전부 막힌다.

그래서 **소유 역할이 지정된 경로 규칙이 하나도 없는 레포는 프로젝트에 넣을 수 없다**(`createProject`, 422 `REPO_OWNERSHIP_NOT_SET`, 메시지에 막힌 레포 전부와 부를 API를 함께 적는다). 그대로 두면 아무도 쓸 수 없는 레포라 원인이 제출 시점에야 드러나기 때문이다.
기준은 "하나라도 지정됐는가"이지 "`**`가 지정됐는가"가 아니다 — 모노레포처럼 `apps/*/**`만 나누고 루트를 비워 두는 설계를 막지 않는다. 그 경우 루트 파일은 기본 거부다(열리지 않는다).

각 규칙의 `action_key`는 **허용 레벨 정책표**(`action_catalog`, 17행)의 "탐지" 열을 경로로 옮긴 것이다. 정책표는 행동마다 누가 승인하는가(AUTO / PM_REVIEW / HUMAN / FORBIDDEN)를 L1~L4 열로 정의하고, `locked_mode`(🔒) 행은 네 레벨이 모두 같아야 한다는 CHECK로 DB가 막는다. **`PM_REVIEW`는 PM이 반려만 할 수 있고 통과는 AUTO 검증이 결정한다** — LLM이 게이트를 열 수 없다. PM이 응답하지 못할 때(타임아웃·예산 소진) AUTO 강등은 **PM_REVIEW 한 칸에만** 적용하고(🔒 행은 원천 제외, HUMAN·FORBIDDEN은 절대 강등 없음) 같은 트랜잭션에 `PM_REVIEW_DEGRADED`(사유·`policy_hash`)를 남긴다(`domain/policy/pm-review-fallback.ts`). `package.json`의 `dep:add`는 경로가 아니라 dependencies/devDependencies diff로 판정하도록 **판정기만 있고 연결되지 않았다**(`domain/policy/dependency-diff.ts`, 읽을 수 없으면 dep:add로 취급) — 지금은 `package.json`을 고쳐도 `dep:add`가 걸리지 않는다. 시드 40번(`requirements.txt`)만 경로로 잡힌다. `package.json`을 경로 행으로 추가해 메우지 말 것: scripts만 고친 변경까지 dep:add가 되고, 승인 API가 없어 `AWAITING_APPROVAL`에서 멈춘다. 제출·V3가 변경 전후 내용을 읽을 때 연결한다. 비밀 파일 행의 `action_key`를 NULL로 두면 `code:own_path`로 해석되므로 반드시 `secret:touch`여야 한다. 시드 목록을 바꾸면 `source='seed'` 행만 골라 기존 레포에도 반영하는 마이그레이션을 같이 쓴다(004·005가 선례).

- `priority`는 **항상 명시적 정수**이고 **레포 안에서 유일**하다(`uq_repo_paths_priority`). 대역은 `0~99` seed · `100~199` scan · `200~299` manual · `900+` 조직 상한이고 source별 CHECK(`repo_paths_priority_band_chk`)가 강제한다. manual 규칙은 priority를 안 주면 대역의 최댓값 + 1. "더 구체적인 패턴이 이긴다" 같은 규칙 기반 판정은 금지 — 재현 실험이 성립하려면 어느 규칙이 이기는지가 결정적이어야 한다.
- `resolveRule`은 매칭 규칙 중 priority 최대값을 고르고, 동점이면 `path_pattern` **사전순 오름차순**으로 tie-break한다. priority가 유일하므로 DB 데이터에선 폴백이 발동하지 않지만, 함수 자체의 결정성은 유지한다.
- 조직 상한(priority 900+) 행은 어떤 필드도 API로 바꿀 수 없다(409 `IMMUTABLE_ORG_CEILING`). negation 문법이 없으므로 예외(`**/.env.example`)는 **더 높은 priority의 허용 행**으로 표현한다. `action_key`와 `priority`는 어떤 API로도 수정할 수 없다 — 정책 판정의 기준이라 임의로 바뀌면 재현성이 깨진다. `updatePathOwnership`의 입력 타입에 아예 없다.

### glob 문법은 의도적으로 좁다

`src/domain/repo/glob.ts`가 허용하는 것은 `**`, `*`, 리터럴 경로뿐이다. `{a,b}`, `!`, `?`, `[]`는 `validatePattern`이 거부한다.

이유: `path_pattern`이 서버(picomatch)와 브릿지가 만드는 `.claude/settings.json` deny 규칙 양쪽에서 소비되는데, 두 엔진의 glob 방언이 다르면 서버는 통과시키는데 로컬은 막거나 그 반대가 생긴다. **부정이 필요하면 `priority`로 푼다.** 이 제약을 완화하지 말 것.

서버 매처의 의미: `**/`는 **0개 이상의** 디렉터리(`**/.env*`는 `.env`와 `apps/api/.env` 둘 다), `*`는 `/`를 넘지 않고, **`**/`로 시작하지 않는 패턴은 레포 루트에 고정**된다(`Dockerfile`, `contracts/**`는 루트만), 그리고 **대소문자를 구분하지 않는다**. 방언이 갈리는 표기 — 세그먼트 일부로 쓴 `**`(`a**b`, `src/**.ts`)와 빈 세그먼트(`/abs`, `dir/`) — 는 `validatePattern`이 거부한다.

대소문자를 구분하지 않는 이유는 두 가지다. Claude Code의 권한 규칙이 대소문자를 무시하고(실측 확인), Windows·macOS 파일시스템도 구분하지 않으므로 `.ENV`로 `.env`를 고치는 우회를 막아야 한다. 구분하면 `.env.EXAMPLE`을 **서버는 막고 로컬은 허용하는** 더 위험한 방향의 불일치가 난다.

브릿지용 `.claude/settings.json`은 `src/domain/repo/claude-settings.ts`가 만든다. Claude Code는 **deny가 항상 이기고** allow로 예외를 만들 수 없으며, deny 목록 안의 `!패턴`만 앞선 규칙에서 경로를 빼낸다. 슬래시 없는 패턴과 `dir/**` 형태의 deny는 모든 깊이에 매칭된다. 그래서 생성기는 루트 고정 패턴에 `/`를 붙이고, priority 오름차순으로 제한 행은 그대로·허용 행은 `!`로 낸다. **`/`로 앵커된 규칙과 `x/**`로 디렉터리째 막은 규칙은 `!`로 뚫을 수 없다** — 서버에서 그런 규칙을 더 높은 priority로 되살리면 두 엔진이 어긋난다(시드에서 `**/secrets/**`를 `.env.example` 예외보다 위에 둔 이유). 시드나 매처를 바꾸면 `tests/path-golden.test.ts`가 두 엔진(서버 매처 / gitignore 구현체 `ignore` 위에 올린 Claude Code 모델)을 같은 골든 fixture로 검사한다. 한쪽에만 테스트를 추가하지 말 것.

**비교는 비대칭이다.** `settings.json이 서버보다 느슨함`은 하드 실패로 다룬다 — 에이전트가 파일을 실제로 건드린 뒤 제출 시점(V3)에야 반려되므로 정직한 실수 방어선이 한 겹 늦게 작동한다. 반대로 `더 엄격함`은 로컬에서 먼저 막히는 보수적 방향이라 통과시키고 경고로 남긴다. 조직 상한 대역(950대)에 예외를 추가하면 **짝 검사 테스트**가 그 예외가 `!`로 뚫을 수 없는 규칙(루트 고정·디렉터리째 막은 규칙)을 서버에서만 뚫는지 확인한다 — 필요하면 재고정 행을 추가한다(`contracts/**/.env.example` 955가 그 사례). 모델의 가정은 생성한 settings.json을 임시 작업공간에 깔고 헤드리스 Claude Code를 실제로 돌려 확인했다(`tests/claude-permission-model.ts` 주석).

### 인증

사람은 `POST /api/auth/login`으로 받은 JWT(**24시간**, refresh 없음)를 `Authorization: Bearer`로 보낸다. 에이전트 토큰(1시간)보다 긴 이유는 사람 토큰에 권한이 없고 매 요청 DB에서 조직·역할을 다시 읽기 때문이다 — 남는 위험은 탈취된 토큰을 만료 전에 끊을 수 없다는 것(로그아웃·강제 만료 없음). 프론트는 로그인 뒤 `GET /api/me`로 조직·역할을 읽는다(조직이 없으면 `orgRole`도 null — `users.org_role`의 기본값 MEMBER를 그대로 내지 않는다). 에이전트(CLI)는 가입 때 받은 개인 연결 키로 `POST /api/agents/connect`를 호출해 access/refresh 토큰을 받는다. JWT는 의존성 없이 `node:crypto`로 구현했다(`src/utils/tokens.ts`, HS256). 비밀번호는 `scrypt`(`src/utils/password.ts`) — argon2·bcrypt는 네이티브 빌드가 Windows에서 자주 깨진다.

- `authenticate`는 토큰에서 **신원(`sub`)만** 믿고 `orgId`·`orgRole`은 매 요청 DB에서 다시 읽는다. 토큰의 `org_role`로 판정하면 조직을 만든 직후에도 옛 역할이 남는다.
- 토큰의 `kind`(`user` | `agent`)를 반드시 검사한다. 빼면 에이전트 토큰으로 사람 API를 부를 수 있다.
- JWT 헤더는 발급한 값과 **바이트 단위로** 비교한다. `alg`를 파싱해 분기하지 말 것(alg:none 공격).
- 연결 키·refresh token은 **sha256 해시**로 저장한다. 무작위 32바이트라 느린 해시가 필요 없고, 결정적이어야 해시로 행을 찾을 수 있다. salt가 붙는 scrypt는 비밀번호에만.
- 틀린 연결 키는 401이 아니라 **400 + 일반 메시지**(`INVALID_CONNECT_REQUEST`). 없는 아이디와 틀린 비밀번호는 같은 에러를 내고, 없는 아이디일 때도 scrypt를 한 번 돌려 응답 시간 차이를 없앤다.
- **에이전트 토큰에는 신원만 담는다.** `sub`(agent_id), `on_behalf_of`, `org_id`, `project_id`, `policy_hash`, `exp`.
  `scopes`·`denied`를 넣지 말 것 — 대표가 금지 경로를 추가해도 만료 전까지 옛 권한으로 돌고, 그 구멍이 M5′ 분모에 들어간다.
  `policy_hash`는 그 DB 조회를 대체하는 게 아니라 위에 얹는 무효화 장치다(`domain/policy/policy-hash.ts`).
  `repo_paths`를 바꾸는 서비스는 반드시 `recomputePolicyHashesForRepo`를 같은 트랜잭션에서 호출한다 — 빠뜨리면 0b 방어선이 죽는다.
- 에이전트 요청은 `middleware/agent-auth.ts`(서명 → 에이전트 재조회 → 0a 정지 → 0b 정책 신선도) → `domain/policy/scope-check.ts`(2~5단계) 순서로 검증한다.
  사람 경로와 마찬가지로 **`agents` 행을 매 요청 다시 읽는다** — `orgId`의 정본은 토큰이 아니라 DB이고,
  지워진 에이전트의 토큰은 만료 전이라도 거부된다. 토큰의 `on_behalf_of`가 `agents.user_id`와 다르면 받지 않는다(P3).
  실패는 전부 `TOOL_DENIED` 이벤트로 남긴다. 통과만 기록하면 "무엇이 차단됐는가"(M5′의 분모)가 사라진다.
  경로는 규칙을 한 번만 풀어 `access`로 금지와 소유권을 함께 판정한다 — 소유권을 먼저 보면 `.env`가 `scope:violation`으로 잘못 기록된다.
- **복호화가 필요한 비밀값만** `utils/secret-box.ts`(AES-256-GCM)로 암호화한다. 연결 키·refresh 토큰처럼 대조만 하는 값은 계속 sha256 해시다.
  키는 KMS가 정본이고 `SECRET_ENCRYPTION_KEY`는 로컬 폴백이다. `KMS_KEY_ID`가 있는데 KMS 경로가 없으면 조용히 내려가지 말고 실패시킨다.
- **CLI 로그인의 기본은 브라우저 승인(device flow, RFC 8628, `domain/agent/device-service.ts`)이다.** CLI가 `/agents/device/start`로 코드를 받아
  브라우저를 열고 `poll`하면, 로그인된 사람이 웹(`{FRONTEND_BASE_URL}/connect/device`)에서 승인한다. 연결 키(`/agents/connect`)는 SSH 등 브라우저가 없는 환경용으로 남는다.
  - 토큰 발급은 두 경로가 **`issueAgentCredentials` 한 벌**을 쓴다(`AGENT_CONNECTED.payload.method`로 가른다). 한쪽만 고치면 토큰이 갈라진다.
  - deviceCode는 해시로만 저장하고 **토큰은 한 번만 나간다**(APPROVED → CONSUMED 조건부 UPDATE + 행 잠금). 만료 10분, interval보다 빠른 poll은 `slow_down`(+5초, 저장).
  - 요청 시점에는 승인할 사람이 없어 `AGENT_DEVICE_REQUESTED`는 `system:device-flow` 명의다. 결정·연결은 승인한 사람 명의이고, 그 사람이 에이전트의 주인이다.
  - 피싱 대비: 승인 화면에 에이전트 이름·**요청 IP**·시각을 보여 주고, CLI는 승인 뒤 **연결된 계정**(`account`)을 출력한다(남이 내 코드를 승인한 경우를 드러낸다).
    요청 IP를 위해 `app.set('trust proxy', 1)` — Caddy 한 단만 믿는다. 늘리거나 `true`로 바꾸면 클라이언트가 끼운 X-Forwarded-For를 믿게 된다.
  - userCode는 자음 20자 8자리(약 2.5×10¹⁰), 대소문자·하이픈 무시. 서버에 rate limit이 아직 없다 — 대입 공격은 조합 수와 10분 만료로만 막는다.
- 교체 지점은 여전히 `auth.ts` 하나다. 라우트는 `req.user`와 `orgIdOf(req)`만 쓴다. `req.user.orgId`는 조직 가입 전 `null`이므로 조직이 필요한 핸들러는 `orgIdOf(req)`(없으면 403 `NOT_IN_ORG`)를 쓴다.

### 브릿지와 MCP

에이전트는 서버 API를 직접 부르지 않는다. `src/bridge/mcp-server.ts`가 노출한 도구(`claim_task`·`submit_artifact`)만 쓰고,
그 도구가 `src/bridge/nomos-client.ts`를 통해 HTTP로 서버를 부른다.

- **`--mcp-config`와 `--strict-mcp-config`는 항상 함께 간다**(`src/bridge/claude-args.ts`). 후자가 빠지면 사용자의
  `~/.claude.json`에 등록된 MCP 서버가 함께 로드되고, GitHub MCP가 살아 있으면 `submit_artifact`를 건너뛰고
  직접 push할 수 있다. 그러면 제출 시점 경로 검증이 아무것도 못 막는다. `tests/bridge-args.test.ts`가 이걸 고정한다.
- MCP 서버의 **stdout은 JSON-RPC 전용**이다. 로그는 반드시 stderr로 쓴다.
- 401 `POLICY_STALE`은 refresh로 재발급하고 원 요청을 **1회만** 재시도한다. 재발급 후에도 stale이면
  `PolicyStaleLoopError`로 즉시 멈춘다 — 무한 재시도가 이 흐름에서 가장 흔한 사고다.
- `src/app.ts`의 `createApp()`이 앱 조립만 하고 `listen`은 `index.ts`가 한다. 통합 테스트가 포트 0으로 띄우기 위해서다.
- **거부 이벤트를 트랜잭션 안에서 throw로 흘리지 말 것.** `TOOL_DENIED`까지 함께 롤백된다.
  서비스는 거부 사실을 커밋하고 돌아온 뒤 밖에서 `AppError`를 던진다(`domain/task/service.ts`의 `settle`).

### Executor (브릿지 본체)

팀원 노트북에서 도는 프로그램(`src/executor/`). 서버 주소는 `~/.nomos/credentials`의 `baseUrl`에서 온다.

- **npm 패키지 `@capstone-nomos/cli`(bin `nomos`)로 배포한다.** 팀원에게 서버 레포를 받게 하지 않는다 — 웹 안내는 `npx @capstone-nomos/cli@latest connect` 한 줄이다
  (`@latest`: npx가 캐시한 옛 버전이 바뀐 서버 API와 어긋나지 않게). 패키지는 `src/executor`·`src/bridge`만 빌드한 것이고(`tsconfig.cli.json` → `packages/cli/dist`),
  **이 두 폴더는 서버 코드(`config`·`domain`·`utils`)를 import하지 않는다** — 하면 서버 파일이 노트북으로 실려 나간다(`tests/cli-package.test.ts`가 막는다).
  외부 의존성을 추가하면 `packages/cli/package.json`에도 같은 범위로 넣는다(같은 테스트).
- **파일 위치는 `import.meta.url` 기준이다**(`executor/paths.ts`). 패키지는 아무 폴더에서나 실행되므로 `path.resolve('dist/...')`처럼 cwd 기준으로 찾지 말 것 —
  MCP 서버 경로가 실제로 그렇게 backend 폴더에서만 맞았다. 설치·실행은 `npm run check:cli-package`가 pack한 패키지를 다른 폴더에서 돌려 확인한다(배포 워크플로가 publish 전에 돈다).
- `connect`: 자격 증명이 없거나 다른 서버 것이거나 재발급이 4xx면 브라우저 승인 로그인 → 배정 전이면 15초마다 **재발급 후** `/agents/me`로 확인
  (배정 전 토큰에는 `project_id`가 없다) → `start`. `--server` 기본값은 운영 주소(`connect.ts`의 `DEFAULT_SERVER`). 시작 전에 `git`·`claude`를 확인한다.
- **태스크의 레포는 CLI가 받는다**(`executor/repo-checkout.ts`): `~/.nomos/repos/<조직>/<레포>`에 브리핑의 `repo.cloneUrl`(NULL이면 `github.com/{fullName}`)로 클론하고,
  태스크마다 fetch해 `origin/<기본 브랜치>`에서 분기한다. `repos.json`에 적힌 경로가 있으면 그게 우선이다(fetch하지 않음, 시드·기존 클론용).
  서버가 준 주소라도 노트북에서 한 번 더 거른다(https·로컬 경로만, `-` 시작·`::`·자격 증명 거부, `git clone --`). git 비밀값은 서버가 주지 않는다 — 사용자의 git 자격 증명을 쓴다.
- **npm 배포는 `cli-v*` 태그 → Trusted Publishing(OIDC)이다**(`publish-cli.yml`). `NPM_TOKEN`을 Secrets에 두지 말 것. 태그와 `packages/cli/package.json` 버전이 다르면 멈춘다.

- **자격 증명의 정본은 `~/.nomos/credentials`(0600)다.** MCP 설정 파일에 토큰을 넣지 말 것 —
  그 파일은 Claude Code에 넘기는 설정이고, 재발급 결과를 되돌려 쓸 곳이 없어 매 실행이 401로 시작했다.
  `onTokensChanged`로 갱신된 토큰을 파일에 쓴다.
- **재발급 대상은 `POLICY_STALE`과 `UNAUTHENTICATED` 둘 다다.** 만료(1시간)를 빼면 한 시간 뒤부터 조용히 죽는다.
  재발급 후에도 같은 이유로 막히면 `PolicyStaleLoopError`로 멈춘다 — 두 번째 재발급은 하지 않는다.
- 작업공간은 `~/.nomos/workspaces/{projectId}/{taskId}/`에 **git worktree로** 만든다. 레포 자체와 분리되므로
  사용자의 작업 트리를 건드리지 않는다. 태스크가 끝나도 **남긴다** — 실패 원인은 남은 파일에서 드러난다.
- `.claude/settings.json`이 로컬 방어선이다. 생성에 쓴 `policy_hash`를 `.claude/.nomos-policy.json`에 함께 남긴다.
  디스크의 파일이 서버 판정과 같은 결론을 내는지는 `npm run verify:settings`가 검사한다.
- **자동 재시도를 넣지 말 것.** `tasks.retry_count`는 서버가 관리하는 값이고, Executor가 돌리면 M4가 오염된다.
- 프롬프트에는 태스크 id·명세·인계 노트·수정 가능 경로를 **서버 브리핑에서 받아** 넣는다.
  주지 않으면 모델이 제목으로 도구를 부르거나 없는 도구를 제안한다(실측).
- 태스크 수령은 `TaskSource` 인터페이스 뒤에 있다. 지금은 폴링, 나중에 이벤트 스트림으로 갈아끼운다.

### 검증 (V1A~V4)

**누가 판정하느냐**로 단계가 갈린다. 서버가 혼자 판정할 수 있는 V1A·V1B·V3은 제출 응답 안에서 **동기로**
끝나고(`domain/verification/service.ts`의 `runServerVerifications`), 작업공간이 있어야 돌 수 있는 V2·V4만
브릿지가 `POST /api/artifacts/:id/verifications`로 나중에 보고한다. 전부 비동기로 통일하지 말 것 —
"제출은 됐는데 결과는 언제 오는가"를 관리하는 상태가 하나 더 늘고, 모델은 그 사이에 다음 태스크로 넘어간다.

- **V1A는 계약(OpenAPI) 대조이지 명세(EARS) 대조가 아니다.** `contracts.schema_yaml`과 실제 응답의
  스키마·상태코드·필드명을 기계적으로 비교하는 결정적 단계라 P2에 걸리지 않는다. 지금 SKIPPED인 이유는
  비교 대상을 담을 `contracts` 테이블이 없어서일 뿐이고, 기록되는 사유도 그렇게 적는다.
  **사유를 "LLM 판정 필요"로 바꾸지 말 것** — 그러면 P2를 근거로 영원히 안 붙는다
  (`tests/verifications.test.ts`가 그 문구를 막는다).
- **V3는 커밋의 실제 diff를 읽는다.** 제출 시점 3·4단계는 *신고한* 경로만 보므로, 신고에서 뺀 파일은
  아무 검사도 받지 않는다. diff의 출처는 제출자가 아니어야 한다 — `CommitInspector` 뒤에 있고
  지금 구현체는 서버가 bare mirror를 들고 fetch하는 `gitMirrorInspector`, 운영은 GitHub Commits API다.
  읽을 곳은 `repos.clone_url`이며 NULL이면 PASS가 아니라 **SKIPPED**다. 신고 누락도 과다 신고도 FAIL이다.
- **`SKIPPED`를 `PASS`로 적지 말 것.** "못 돌렸다"가 통과로 세어지면 M5가 조용히 부풀려진다.
  사유 없는 SKIPPED는 DB가 막는다(`verifications_skip_reason_chk`). 없는 커밋은 FAIL이지만
  서버 사정으로 못 읽은 것은 SKIPPED다 — 후자를 FAIL로 적으면 에이전트가 자기 잘못이 아닌 일로 재시도를 잃는다.
- **브릿지는 V2·V4만 보고할 수 있다.** 로컬이 보고한 V3를 서버가 받으면 V3의 전제가 무너진다.
  V2는 PASS로 와도 서버가 `spec_tests.locked_at < artifacts.created_at`을 다시 보고 뒤집는다.
- 한 산출물의 한 단계는 한 번만(`uq_verifications_stage`). 재제출은 `attempt`가 올라간 **새 artifact**다.
- FAIL이면 `retry_count`가 오르고 태스크는 `READY`로 돌아가며 **담당을 비운다**(안 비우면 아무도 못 잡는다).
  3회째는 `ESCALATED`. 전부 통과해도 `gate_mode`가 `AUTO`가 아니면 `AWAITING_APPROVAL`이다 —
  검증이 6단계 정책 게이트를 대신 열어주지 않는다. 결론이 난 뒤 늦게 온 보고는 상태를 건드리지 않는다.
- **`AWAITING_APPROVAL`에서 나올 경로는 아직 없다.** approvals 테이블은 ERD에만 있고 승인·반려 API도 없어서
  들어가면 사람이 DB를 고치기 전까지 멈춘다. 그래서 그 상태로 보낼 때 경고 로그·이벤트 payload·제출 응답
  (`verification.notice`) 세 곳에 `APPROVAL_PATH_MISSING`을 남긴다 — 조용히 멈추면 원인을 로그에서 찾을 수 없다.
  승인 API를 붙일 때 이 상수의 사용처를 지우는 것이 그 작업의 체크리스트다.
- V3가 쓰는 bare mirror(`~/.nomos/server-mirrors/{repoId}.git`)는 **서버가** 만드는 것이라 정리도 서버 쪽에 있다.
  `npm run seed`가 TRUNCATE와 같은 자리에서 지운다(레포 행이 사라지면 repoId로 이름 붙은 mirror는 고아다).
  `executor clean`은 팀원 노트북에서 도는 브릿지 명령이므로 서버 산출물을 지우는 자리가 아니다.

### 인계 노트

노트는 기록이고 채널이 아니다. `reply_to`·`to_agent`·본문 `text` 컬럼을 **만들지 말 것** —
칸을 주면 길게 채우고, 답글을 주면 채팅이 된다. 정정은 새 행(`supersedes`)이다.

- 제목은 서버가 조립한다(`domain/note/title.ts`). 연결(`spec_id`·`repo_id`)은 태스크에서 물려받는다.
- 검증 위반은 **422로 전부 되돌려주고 자르지 않는다.** `key_points`는 인덱스와 글자수를 함께 낸다.
  그 위반 목록이 HTTP 응답까지 나가려면 `error-handler`의 `PUBLIC_DETAIL_CODES`에 `NOTE_INVALID`가 있어야 한다 —
  기본은 상세를 감추는 것이므로 빼면 에이전트는 `note validation failed`만 보고 같은 요청을 반복한다.
  `NomosApiError`는 `details`를 메시지에도 붙인다(MCP 도구는 `err.message`만 모델에게 보여준다).
- 구조로 표현되는 검증은 DB CHECK로 올린다(010에 8개). 배열 원소별 길이는 CHECK가 서브쿼리를 못 써 볼 수 없으므로
  앱이 보고, DB는 `notes_budget_chk`(합계 700자)로 총량을 지킨다. 한쪽만 고치지 말 것 — 숫자는 `domain/note/kinds.ts`에 한 곳.
- **과실 주장은 문자열 포함 검사로만 막는다(P2).** 다른 에이전트의 id·이름이 있으면 422 + `raise_dispute` 안내.
  자연어로 심사하지 않는다. LLM에 "누가 잘못했나"를 묻는 코드를 넣지 말 것.
- 읽기는 이벤트를 남기지 않는다. 발행만 `NOTE_PUBLISHED`.
- **노트 읽기와 산출물 목록은 사람도 부른다**(`authenticateAny`). 에이전트만 읽을 수 있으면 대표는
  "VERIFYING에서 멈췄다"까지만 보이고 이유를 볼 수 없다. 사람 경로는 `domain/project/visibility.ts`의
  `assertProjectVisibleToUser`를 쓴다 — "이 사람이 이 프로젝트를 볼 수 있는가"의 정의는 거기 한 곳이다.
  사람의 권한 부족은 `TOOL_DENIED`로 남기지 않는다(도구 호출 차단이 아니므로 M5′ 분모가 오염된다).
  노트는 에이전트의 **자기 보고**이므로 검증 결과(`verifications`)를 대체하지 않는다 — 화면에 둘 다 필요하다.
- 프롬프트 주입은 `read_notes` 호출에 의존하지 않는다(`domain/note/injection.ts`). 서버가 골라 넣는다.

### 명세·태스크 작성 (`domain/authoring`)

대표가 API(`POST /projects/:id/specs`·`/tasks`)로, 운영자가 `seed:tasks` 파일로, 나중에 PM이 계획으로 만든다 —
**경로가 셋이어도 검증(`validate.ts`)·트랜잭션 흐름(`apply.ts`의 `authorInTransaction`)은 한 벌이다.** 서버는 pool에서 꺼낸 연결을,
스크립트는 자기 연결을 넘기기만 한다. 한쪽에만 검사를 추가하면 다른 경로가 느슨해진다.

- **이 폴더는 운영자 노트북의 `seed:tasks`가 import한다.** `config/env`·`config/db`·`logger`를 직접이든 간접이든 런타임 import하지 말 것
  (`import type`만). 서버 비밀값 없이는 스크립트가 뜨지 않는다 — 빈 임시 폴더에서 서버 변수를 지우고 스크립트를 띄우는 테스트가 고정한다.
  `pool`을 쓰는 `service.ts`만 예외이고, 스크립트는 그 파일을 import하지 않는다.
- **이 폴더와 `import-tasks.ts`의 SQL은 SELECT·INSERT뿐이다**(폴더 전체를 읽는 소스 검사 테스트). 수정·삭제가 필요해지면 그 함수는 폴더 밖에 둔다.
- 흐름: BEGIN → **프로젝트 행 `FOR NO KEY UPDATE`** → 권한(대표)·상태(`planning`·`active`만, 아니면 409 `PROJECT_NOT_OPEN`) → 검증 → INSERT → 이벤트 → COMMIT.
  잠금이 사전 검사(같은 제목·같은 명세 키)와 INSERT 사이의 경합을 막는다. **`FOR UPDATE`로 바꾸지 말 것** — 외래 키 검사의 `FOR KEY SHARE`와 충돌해
  작성 중에 그 프로젝트를 참조하는 모든 INSERT(이벤트·노트·제출)가 줄을 선다. 두 성질 모두 테스트가 잠금을 실제로 잡고 확인한다.
- 검증 위반은 **전부 모아 422 `PLAN_INVALID`**(`details: [{ where, message }]`). 사전 검사를 지나 DB 유일 제약에 걸린 경우만 409 `PLAN_CONFLICT`.
- **IMPLEMENT는 명세 필수**, INTEGRATION·REWORK는 생략 가능. 같은 제목은 거부(재실행·버튼 두 번 방지) — **REWORK가 같은 제목을 쓰게 되면 이 규칙을 다시 본다.**
- **시험지의 `locked`는 필수이고 만들 때만 정한다.** 기본값을 두면 빠뜨린 시험지가 조용히 잠기지 않아 V2가 근거 없이 돈다. 나중에 잠그는 API를 두지 말 것 —
  이미 제출된 산출물보다 늦게 잠긴 시험지가 생긴다(`locked_at < artifacts.created_at`). `specs.approved_at`은 비워 둔다(G1이 채운다).
- **시험지는 V2에서 팀원 노트북에서 실행되는 코드다.** 지금은 대표만 쓰지만, PM이 쓰게 되면 사람 검토 없이 남의 노트북에서 코드가 도는 경로가 생긴다 — 그때 검토 단계를 넣는다.
- 이벤트는 항목마다 `SPEC_CREATED`·`TASK_CREATED`이고 `payload.source`가 `human`·`import`·`pm`이다. 지표는 이 값으로 가른다.
  예전의 묶음 요약 `TASKS_IMPORTED`는 더 이상 남기지 않는다(이미 쌓인 행을 읽을 때만 타입이 남아 있다).
- 이렇게 만든 태스크는 `plan_id`가 NULL이다(PM 계획인 `plans` 행이 없다) — **M6b 리플레이 그룹핑에서 빠진다.** 모듈 이름이 `plan`이 아닌 이유도 `plans` 테이블과 헷갈리지 않게다.
- 명세 목록(`GET .../specs`)의 범위는 태스크 목록과 같다. 에이전트에게는 잠긴 시험지만 보인다(브리핑과 같은 규칙).
- 수정·삭제·명세 개정(`superseded_by`)은 아직 없다.

### 내장 PM (`domain/pm`) — 계획 수립만

대표의 지시 → PM 초안(비동기, `pending → ready | failed`) → 대표 검토 → 적용(`applied`). PM은 NOMOS 키(`ANTHROPIC_API_KEY`)로 서버에서 돈다.
PM_REVIEW 반려·피드백 분류·이의 설명·보고서는 아직 없다.

- **판정은 코드가 한다(P2).** 초안은 명세·태스크 작성과 같은 검증(`domain/authoring`)을 **dry-run**으로 거친다. 위반이면 위반 목록을 붙여
  **한 번만** 다시 쓰게 하고, 그래도 틀리면 `failed(invalid)`. 교정 횟수를 늘리지 말 것 — 비용과 비결정성만 는다.
- **응답은 `stop_reason`부터 본다** → JSON → 형식(zod) → 도메인 검증. `refusal`은 `refused`, `max_tokens`는 `truncated` — PM이 틀린 게 아니라
  교정하지 않는다. 실패 사유는 `error_reason`(refused·truncated·timeout·invalid·restart·budget·api_error)이고 상태에 섞지 않는다.
- **수정 요청과 교정은 새 단발 호출이다**(이전 초안 + 피드백/위반). 대화를 이어 붙이지 않으므로 거절된 턴이 섞이지 않는다.
- **비용**: 호출마다 `PM_CALL` 이벤트(`on_behalf_of: system:pm`, `events.token_cost` USD). `usage.iterations`의 **시도마다** 그 모델 가격으로 더한다
  캐시 쓰기(입력 × 1.25)와 읽기는 따로 센다. 가격표는 `pm/pricing.ts` 한 곳.
- **대체 모델(`fallbacks`)은 쓰지 않는다.** 켜면 안전 거절 때 서버가 고른 다른 모델이 한 번 더 돌 수 있어, 호출 상한을 가장 비싼 모델 기준으로
  두 번 잡아야 했다($3.9). 계획 작성이 거절될 일은 드물다 — 거절되면 `failed(refused)`, 대표가 다시 요청한다. 다시 켜면 `maxCallCost`도 같이 고칠 것.
- **예산**: 매 호출 전(교정 포함) "누적 + 이번 최대치 > `pm_budget_usd`"면 부르지 않는다. 최대치는 `max_tokens`(기본 32,000) × 출력가 + 입력분 —
  Sonnet 5.5 기준 약 $0.4, 계획 하나(교정 포함 2회) 약 $0.8. 초과 시 설계상 승인 카드가 떠야 하지만 **승인 경로 미구현**이라 409로 거절하고 메시지에 그렇게 적는다.
- **끊긴 호출**: 호출 직전 최대치를 `plans.inflight_max_cost_usd`에 적고, 시간 제한(`PM_TIMEOUT_MS`)·재시작으로 끊기면 그 값으로 `PM_CALL(interrupted)`을 남긴다.
  재시작 정리(`recoverInterruptedPlans`)는 **`startServer`에서만** 부른다 — migrate 단계에서는 옛 서버가 아직 작업 중일 수 있다.
  상태 전이는 전부 `WHERE status = 'pending'` 조건부라 정리된 계획을 늦게 끝난 작업이 덮어쓰지 못한다.
- **적용은 저장된 초안을 그대로** 명세·태스크 작성 경로에 넣는다(`source: 'pm'`, `tasks.plan_id`). **시험지는 전부 `locked: true`** — 초안 화면에서
  대표가 시험지 코드 전문을 보고 적용하는 것이 곧 검토다(시험지는 팀원 노트북에서 실행된다). 같은 잠금 안에서 ready·체인 미적용을 다시 확인하고
  (`uq_plans_applied_root`가 마지막 방어선), 검증에 걸리면 롤백되어 계획은 ready로 남는다.
- **적용은 G1이 아니다.** `applied_at`만 채우고 `plans.approved_at`은 비워 둔다(G1 승인 = 잠김). 프로젝트 상태도 바꾸지 않는다.
- **PM_REVIEW의 AUTO 강등을 아직 연결하지 말 것.** PM이 리뷰(②)를 하지 않는 지금 연결하면 "PM 무응답"이 상시라 PM_REVIEW가 전부 자동 통과된다.
- `dag_hash`는 **구조만**(명세 키, 태스크의 레포·역할·종류·명세, 선행 쌍) 해시한다 — 근거·제목·ref 이름을 넣으면 M6a가 항상 0%다. 구조는 `plans.structure`에도 둔다.
- 키가 없으면 PM API만 503 `PM_UNAVAILABLE`(`ANTHROPIC_API_KEY`는 선택). 테스트는 `setPmModel`로 가짜 모델을 끼운다 — CI는 실제 API를 부르지 않는다.
- **중계 모드(`PM_PROVIDER=relay`)는 결제 전 임시 방식이다.** 모델 호출 한 자리만 대표 노트북의 `executor pm-worker`(headless Claude Code, 구독)로
  바뀌고 나머지 흐름은 같다(`domain/pm/relay.ts`, 대기열은 메모리). 작업은 **그 조직 대표 본인의 에이전트만** 가져간다(`GET /pm/jobs/next`) —
  작업에 프로젝트 맥락이 들어 있고 결과가 곧 초안이다. 아무도 안 가져가면 `PM_TIMEOUT_MS`로 `failed(timeout)`. 개인 구독을 여러 사용자의 PM으로
  쓰지 말 것 — 운영은 API 모드(기본)다. 워커는 지침을 파일·프롬프트를 stdin으로 넘긴다(Windows 명령줄 32k자 제한).
- **시험지는 동작 수준이다**(지침): HTTP 요청·응답 또는 화면 동작만, 진입점은 헌법·명세에 적힌 것만. 내부 모듈 경로를 import하면
  구현보다 먼저 잠긴 시험지가 구조를 강제한다(실제 초안이 `../src/attendance/service`를 import했다).
- 모델·노력·한도는 설정값(`PM_MODEL` 기본 `claude-sonnet-5-5`, `PM_EFFORT` 기본 `high`, `PM_MAX_TOKENS`). 생각 토큰도 출력으로 과금되니 실제 비용을 보고 조정한다.

### 프로젝트와 멤버

- 프로젝트 생성은 **한 트랜잭션**에서 프로젝트 행·레포 연결·`project_policies` 17행 복사·헌법 스냅샷·`policy_hash`를
  함께 만든다(`domain/project/service.ts`). 하나라도 빠지면 판정이 성립하지 않는다.
  정책 사본에는 `lock_key`도 함께 복사해야 007의 복합 FK가 🔒 위조를 막는다.
- `policy_hash`는 NOT NULL인데 계산하려면 정책 사본이 먼저 있어야 한다. 그래서 자리값 `'pending'`으로 INSERT한 뒤
  같은 트랜잭션에서 `recomputeProjectPolicyHash`가 덮어쓴다 — 자리값이 트랜잭션 밖으로 나가면 안 된다.
- **같은 레포를 두 활성 프로젝트(`planning`·`active`)가 쓸 수 없다.** DB 제약으로 표현할 수 없어 서비스가 막는다(409).
- **에이전트는 진행 중(completed·aborted가 아닌) 프로젝트를 하나만 맡는다**(409 `AGENT_IN_ANOTHER_PROJECT`). 토큰의 `project_id`가 하나라서
  두 곳에 배정되면 먼저 배정된 쪽은 조용히 못 쓰게 된다. "진행 중"의 정의는 `findAgentMembership`과 같아야 한다.
- **G1(`projects.started_at`) 이후에는 멤버를 바꿀 수 없다**(403). G1으로 가는 경로(승인 API)는 아직 없어 지금은 항상 `planning`이다. 역할 교체는 해제 후 재배정이다 —
  UPDATE 경로를 두면 한 역할에 둘이 잠깐 겹친다.
- **멤버 배정 뒤 그 에이전트는 토큰을 재발급해야 한다.** 배정 전 토큰에는 `project_id`가 없다.
  배정 응답의 `notice`와 openapi 설명에 그 안내가 들어 있다.
- 허용 레벨 어휘 위반은 zod(400)가 아니라 서비스가 **422**로 답한다 — 무엇이 허용되는지 함께 알려주기 위해서다.
- **`date` 컬럼은 `toXxx`에서 `YYYY-MM-DD` 문자열로 되돌린다**(`toProject`의 `toDateString`). pg가 `date`를
  로컬 자정의 JS `Date`로 파싱하므로 그대로 JSON에 실으면 KST 서버에서 하루 빠른 UTC 타임스탬프가 나간다
  (`projects.deadline`이 실제로 그랬다). 전역 타입 파서로 바꾸지 말 것 — 이후 추가되는 모든 date 컬럼에 조용히 영향을 준다.

### 조직 간 접근 차단

`:repoId`가 요청자 조직 소속인지 확인하지 않으면 다른 조직의 경로 소유권을 조회·수정할 수 있다. 규칙:

- repository의 조회 함수는 기본적으로 `WHERE org_id = $1`을 포함한다.
- `repo/service.ts`의 `assertRepoInOrg()`가 "없음(404 `REPO_NOT_FOUND`)"과 "다른 조직 소유(403 `CROSS_ORG_ACCESS`)"를 구분한다. repoId를 받는 서비스 함수는 전부 이걸 먼저 호출한다.
- `:orgId`를 받는 라우트는 `requireSameOrg` 미들웨어를 붙인다.

### 에러

도메인 코드는 `src/errors.ts`의 `AppError`만 던진다. HTTP 상태는 `STATUS_BY_CODE` 테이블이 code로부터 결정하므로 서비스는 상태 코드를 몰라도 된다. `error-handler`는 항상 마지막에 등록하고, AppError가 아닌 예외는 500으로 감추고 상세는 로그로만 남긴다.

**GitHub API 실패가 우리 기능을 멈추면 안 된다.** collaborator 조회가 실패해도 members 목록은 반환된다 — try/catch로 감싸고 `isCollaborator` 필드를 **생략**한다. `false`로 채우지 말 것: "확인 안 됨"과 "권한 없음"은 다르다. 토큰이 없을 때 레포 목록 조회는 500이 아니라 빈 배열 + 경고 로그를 반환한다.

## 배포

EC2 1대(Docker) + RDS PostgreSQL 16 + KMS + SSM. 콘솔 절차는 `docs/deploy-aws.md`(계정 ID·도메인이 들어 있어 저장소에 올리지 않는 로컬 전용 문서), 파일은 `deploy/`.

- **진입점은 `src/boot.ts`다.** SSM(`SSM_PARAMETER_PATH`)에서 비밀값을 `process.env`로 적재한 **뒤에** 나머지를
  동적 import한다. `env.ts`는 import 시점에 검증하므로 boot.ts가 무엇이든 정적으로 import하면 비밀값 없이 검증이 돈다
  (logger도 env를 읽으므로 boot는 stderr만 쓴다). 서브커맨드 `server` | `migrate`.
- **마이그레이션은 자동 실행하지 않는다.** 실패하면 컨테이너가 재시작을 반복하며 서버가 죽어 있다. 대신
  `deploy/deploy.sh`가 migrate → 서버 순서로 돌고, 서버는 기동 시 **이미지의 마이그레이션이 DB에 전부 있는지** 보고
  없으면 뜨지 않는다(`config/migrations.ts`의 `assertSchemaUpToDate`). 운영 migrate는 같은 프로세스에서
  node-pg-migrate API로 돈다 — CLI를 따로 띄우면 SSM에서 적재한 값을 못 받는다(`npm run migrate`가 `.env`를 따로 읽혀야 했던 것과 같은 사고).
- **운영 migrate는 DB에 `nomos.environment = production`을 박는다.** 시드는 호스트명 검사에 더해 이 표시를 읽고
  거부한다 — SSM 포트 포워딩으로 RDS를 보면 `DATABASE_URL`이 `localhost:15432`가 되어 호스트명 검사를 통과하기 때문이다
  (`scripts/lib/remote-db-guard.ts`). 원격을 비우려면 `--allow-remote`를 명시해야 한다.
- **`COMMIT_INSPECTOR`는 기본값이 없다**(`github` | `mirror`). 잘못된 쪽이 조용히 골라지면 V3가 전부 SKIPPED로 쌓이는데
  에러는 나지 않는다. 검사기는 "못 읽음"을 `InspectionSkipped(reason)`로 던지고(→ SKIPPED), 없는 커밋만
  `CommitNotFoundError`(→ FAIL)다. 전제 조건(clone_url·github_repo_id·대표 GitHub 연결)은 **구현체가** 판단한다.
- **githubInspector**는 `/repositories/{github_repo_id}/commits/{sha}`로 파일 목록만 읽는다(코드 내용은 저장하지 않는다).
  토큰은 조직 **대표**의 `oauth_sessions`를 복호화한다. 404는 레포를 한 번 더 봐서 "커밋 없음(FAIL)"과
  "토큰으로 안 보임(SKIPPED)"을 가른다. 이름 변경은 옛 경로도 포함한다(mirror의 diff-tree와 결론을 맞춘다).
- **KMS**: `KMS_KEY_ID`가 있으면 KMS Encrypt/Decrypt를 직접 부른다(`kms1.` 접두사, 암호화 맥락 `purpose=nomos-secret`).
  실패해도 환경변수 키로 내려가지 않는다. `encryptSecret`/`decryptSecret`은 **async**다. 자격 증명은 EC2 인스턴스 역할 —
  액세스 키를 환경변수에 넣지 말 것. 컨테이너가 역할 자격 증명을 받으려면 EC2 메타데이터 홉 제한이 2여야 한다.
- **`APP_BASE_URL`은 `API_BASE_URL`(서버 자신)과 `FRONTEND_BASE_URL`(초대 링크)로 나뉘었다.** 남아 있으면 기동을 거부한다.
  초대 링크는 `{FRONTEND_BASE_URL}/invites/{token}` — 프론트가 이 경로를 구현해야 한다. 운영에서는 둘 다 https 필수.
- **CORS**(`middleware/cors.ts`, 의존성 없음): 정확 일치 또는 첫 라벨 접두 와일드카드(`https://*-팀슬러그.vercel.app`)만.
  `https://*.vercel.app`처럼 고정 접미사 없는 와일드카드는 기동 시 거부한다 — 남의 Vercel 앱이 전부 허용된다.
  Authorization 헤더 방식이라 `Allow-Credentials`는 붙이지 않는다.
- **Swagger**: `DOCS_ENABLED`가 켜고(`NODE_ENV`와 분리), 운영에서 켜면 `DOCS_BASIC_AUTH`가 필수다. 원격에서는
  미사용 **초대 토큰을 example에 채우지 않는다** — 공유 Basic Auth 비밀번호가 곧 조직 가입 자격이 된다.
- **`PATCH /api/repos/:repoId`**(대표 전용)가 `github_repo_id`·`clone_url`을 고친다. **`clone_url`은 서버가 `git clone`에 넘기므로
  `domain/repo/clone-url.ts`의 `validateCloneUrl`이 보안 경계다** — `-`로 시작(`--upload-pack=` 명령 실행), `ext::`, SSH, http, URL 속
  자격 증명(events에 영구히 남는다), 상대 경로를 거부한다. **범위는 서버의 `COMMIT_INSPECTOR`를 따른다** — github(운영)는
  `https://github.com/owner/repo`만(호스트 일치로 본다. 접두 문자열 비교면 `github.com.evil.com`이 통과한다), 로컬 절대 경로·`file://`은
  mirror(로컬)에서만. 운영에서 경로를 받으면 서버 파일시스템의 다른 git 저장소를 읽을 수 있다. 이 검증을 느슨하게 하지 말 것. mirror 검사기는 `git clone -- <url>`로
  한 겹 더 막고, 기존 mirror의 원격을 매번 `set-url`로 맞춘다(안 그러면 주소를 바꿔도 옛 원격에서 받아 새 커밋을 FAIL로 판정한다).
- **`seed:tasks`**(`scripts/lib/import-tasks.ts`)는 운영 DB에 쓰려고 있는 도구라 운영 표시로 막지 않는다. 안전은 구조에서 온다:
  검증·쓰기는 API와 같은 `domain/authoring` 한 벌을 탄다(아래 "명세·태스크 작성"). 이 스크립트는 JSON 해석과 `--as` 확인만 한다.
  기본 dry-run이고, dry-run도 실제와 같은 경로로 끝까지 돈 뒤 ROLLBACK한다. 서버 `env.ts`를 거치지 않고 `DATABASE_URL`만 읽는다.
- **브릿지 push**(`bridge/push.ts`): `submit_artifact`가 서버에 제출하기 **전에** 서버에 기록된 태스크 브랜치
  (`tasks.branch_name`)만 push한다. main·dev·레포의 `default_branch`·`dev_branch`는 거부(대소문자 무시), force 없음,
  HEAD가 태스크 브랜치이고 커밋이 그 브랜치에 있어야 한다. 실패하면 **제출하지 않는다**(재시도 횟수가 오르지 않는다).
  origin이 없는 로컬 데모 레포는 건너뛴다(mirror 모드). push는 모델이 아니라 도구가 한다 — 모델에게 push 도구를 주면
  GitHub MCP를 막아둔 이유가 무너진다. 에러 메시지의 원격 URL 자격 증명은 지운다.
- 이미지에 Amazon RDS CA 번들을 넣고 `NODE_EXTRA_CA_CERTS`로 신뢰한다(`sslmode=verify-full`). `ADD --chmod`는 새로 만드는
  부모 디렉터리에도 같은 모드를 적용하므로 디렉터리를 먼저 만든다 — 안 그러면 node 사용자가 못 읽는다(실제로 막혔다).
- `/health`는 DB까지 닿는지 본다. 배포 스크립트와 컨테이너 헬스체크가 쓴다.

### CI/CD (`.github/workflows/`)

브랜치는 `dev`에서 따서 PR로 `dev`에 합치고, 배포할 때 `dev → main`으로 머지한다. **`main`에 들어온 것이 곧 운영이다.**

- `ci.yml` — `dev` 대상 PR과 `dev` push에서 타입체크 + 전체 테스트. PostgreSQL 서비스 컨테이너를
  `vitest.config.ts`와 **같은 포트·DB 이름**(`55432/nomos_test`)으로 띄운다 — CI용 접속 문자열을 따로 두지 말 것.
  `dev → main` PR에서는 돌지 않는다 — 머지 직후 deploy가 같은 코드를 다시 테스트하므로 중복이다.
- `deploy.yml` — `main` push에서 `ci.yml`을 다시 돌린 뒤(`workflow_call`) 이미지를 `sha-<7자리>` 태그로 ECR에 올리고,
  **SSM Run Command**로 EC2에서 그 이미지의 배포 파일을 꺼내 `deploy.sh`를 돈다. 수동 배포와 같은 경로다
  (migrate → 서버 교체 → 헬스체크). 롤백은 Run workflow에 이전 태그를 넣는다(빌드·테스트를 건너뛴다).
- **AWS 자격 증명은 OIDC다.** 액세스 키를 GitHub Secrets에 넣지 말 것. 역할의 신뢰 정책은 `sub`를
  `<접두사>:environment:production`으로 묶는다(`deploy/github-actions-trust.json`) — 그래서 deploy 잡의
  `environment: production`을 빼면 역할을 못 받고, 다른 브랜치·PR의 워크플로는 운영 권한을 얻지 못한다.
  **접두사는 `repo:소유자/레포`가 아니다.** 이 레포는 GitHub의 불변 subject(`use_immutable_subject`)라 소유자·레포 id가 붙는다
  (`repo:Capstone-NOMOS@327380436/backend@1375402955`). 추측하지 말고
  `gh api repos/<소유자>/<레포>/actions/oidc/customization/sub`의 `sub_claim_prefix`를 그대로 쓴다 — 이름 형식으로 적었다가 실제로 막혔다.
  권한은 `deploy/github-actions-policy.json`(ECR 한 리포지토리 푸시 + 그 인스턴스에만 SendCommand).
- 설정값은 **production 환경의 Variables**(`AWS_REGION`·`AWS_DEPLOY_ROLE_ARN`·`ECR_REPOSITORY`·`EC2_INSTANCE_ID`)다.
  전부 비밀이 아니다. 앱 비밀값은 지금처럼 SSM Parameter Store에만 둔다 — CI에 복사하지 말 것.
- 배포 잡은 `concurrency: deploy-production`, `cancel-in-progress: false`다. 마이그레이션 도중에 취소되면 안 된다.

## 마이그레이션

`migrations/*.sql`은 node-pg-migrate의 raw SQL 형식이다. `-- Up Migration` / `-- Down Migration` 주석이 구분자이며, `tests/test-db.ts`도 이 마커로 Up 구간만 잘라 실행하므로 **마커 문자열을 바꾸면 테스트가 깨진다.**

`action_catalog`는 `repo_paths.action_key`가 FK로 참조하므로 002에서 시드되고, 004에서 허용 레벨 정책표 17행(`mode_l1`~`mode_l4`)으로 교체됐다.

## 코딩 컨벤션

- TypeScript `strict` + `noUncheckedIndexedAccess`. `any` 금지 — 불가피하면 `unknown` + 타입 가드. `interface`보다 `type` 선호(선언 병합이 필요한 경우 제외).
- 도메인 ID는 `src/domain/ids.ts`의 브랜디드 타입(`OrgId`, `RepoId`, ...). `(orgId: string, repoId: string)` 시그니처는 인자 순서를 바꿔도 컴파일이 통과하므로 브랜드로 막는다.
- ORM·쿼리 빌더 금지(`pg` + raw SQL). 이벤트 소싱의 append-only, `text[]` 컬럼, 부분 인덱스, DEFERRABLE FK를 모두 써야 하는데 ORM 추상화와 충돌한다. 파라미터 바인딩(`$1`) 필수, 문자열 결합 금지.
- `console.log` 금지 — `src/config/logger.ts`의 구조화 로거를 쓴다. 순환 import 금지.
- 파일명 `kebab-case.ts`, 타입 `PascalCase`, 함수·변수 `camelCase`, 상수·이벤트 타입 `SCREAMING_SNAKE_CASE`, DB `snake_case`, action_key는 `콜론:구분`.
- 팀 역할은 `src/domain/roles.ts`의 `TEAM_ROLES`(`FRONTEND` | `BACKEND`) 하나에서만 정의한다. **QA는 삭제됐다.** zod enum에 역할 문자열을 직접 쓰지 말고 `z.enum(TEAM_ROLES)`를 쓸 것 — 흩어져 있으면 QA가 되살아난다.

### Express 5 params 타입

`noUncheckedIndexedAccess`와 Express 5 타입 때문에 `req.params.x`가 `string | string[] | undefined`로 잡힌다. `validate` 미들웨어가 이미 검증했으므로 핸들러에서 zod 타입으로 캐스팅해 꺼낸다:

```ts
const { repoId } = req.params as z.infer<typeof repoIdParamsSchema>
```

### 라우터 마운트

라우터 12개(`auth`, `agents`, `orgs`, `repos`, `repo-paths`, `invites`, `oauth`, `tasks`, `notes`, `projects`, `specs`, `pm`)가 전부 `app.use("/api", ...)`로 마운트되고(`/health`·`/docs`는 `/api` 밖), 각 파일이 `/orgs/:orgId/...` 같은 전체 경로를 직접 선언한다. 그래서 URL 접두사가 아니라 **도메인 기준**으로 파일이 나뉜다 — 예를 들어 `POST /api/orgs/:orgId/repos`는 URL은 orgs 밑이지만 `routes/repos.ts`에 있고, `POST /api/orgs/:orgId/invites`는 `routes/invites.ts`에 있다.


## 스키마 변경 규칙

스키마 원본은 `migrations/`다. `docs/erd.dbml`은 그것을 그린 문서다.

마이그레이션을 추가하면 **같은 커밋에서** `docs/erd.dbml`도 갱신한다.
- 새 테이블 → Table 블록 + Ref 추가
- 새 컬럼 → 해당 Table에 추가
- DBML로 표현 못 하는 것(부분 인덱스, CHECK, DEFERRABLE)은 Note에 SQL 그대로

둘이 어긋나면 마이그레이션이 맞다.