# 수동 테스트 안내

서버를 직접 띄우고 API를 손으로 찔러보는 절차. **A**는 API 목록을 하나씩 확인하는 사람,
**B**는 시나리오를 처음부터 끝까지 밟는 사람이 본다.

> 모든 예시는 실제로 실행해 응답 코드를 확인한 것이다. 어긋나면 코드가 맞고 이 문서가 틀렸다.

---

## 0. Swagger UI로 눌러보기 — 가장 빠른 길

curl 없이 브라우저에서 바로 눌러볼 수 있다.

```bash
npm run seed      # 상태 초기화 + 토큰·id 출력 (V3용 서버 mirror도 함께 지운다)
npm run dev       # 포트 3000
```

→ <http://localhost:3000/docs>

### 토큰 넣는 순서

오른쪽 위 **Authorize** 버튼을 누르면 칸이 **두 개** 뜬다. 둘 다 채워야 모든 API를 눌러볼 수 있다.

| 칸 | 어느 계정 | 어디에 쓰이나 | 값 얻는 법 |
|---|---|---|---|
| `userToken` | **rep** (대표) | 조직 · 레포 · 경로 · 초대 · OAuth | 아래 ① |
| `agentToken` | **be-laptop** (백엔드 에이전트) | 태스크 · 노트 | 아래 ② |

1. **userToken** — Swagger UI에서 `POST /auth/login`을 펼쳐 **Try it out** → Execute.
   예시 본문이 이미 `rep` / `manual-test-1234`로 채워져 있다. 응답의 `data.accessToken`을 복사한다.
2. **agentToken** — `npm run seed` 출력의 **be-laptop access token**을 그대로 복사한다.
   (만료됐으면 `POST /agents/token/refresh`에 시드 출력의 refresh token을 넣어 다시 받는다.)
3. **Authorize** → 각 칸에 붙여넣고 각각 **Authorize** → **Close**.

주의할 점:

- **`Bearer ` 접두사는 넣지 않는다.** UI가 붙인다.
- 토큰은 **1시간**이다. 401이 나면 만료를 먼저 의심할 것.
- 새로고침해도 토큰은 유지된다(`persistAuthorization`).
- 사람 토큰으로 태스크 API를 부르면 401이다. `kind` 클레임이 달라 서로의 API를 쓸 수 없다.

### example의 id는 자동으로 맞춰진다

경로 파라미터와 본문 예시의 `project_id`·`task_id`·`repo_id`·`pathId`·초대 토큰은
**`/docs/openapi.json`을 서빙할 때마다 DB에서 읽어 채운다.**
그래서 `npm run seed`를 다시 돌려 id가 바뀌어도 **브라우저를 새로고침하면** 맞는 값이 들어온다.

다만 **연결 키와 refresh 토큰은 채울 수 없다.** 서버에 해시로만 저장하기 때문이다 —
그 두 개는 시드 출력에서 직접 복사한다.

> `/docs`는 `DOCS_ENABLED`가 정한다(로컬 개발 기본 켜짐, 그 외 기본 꺼짐). 운영에서 켜려면 Basic Auth가
> 필수이고(`DOCS_BASIC_AUTH`), 원격에서는 미사용 초대 토큰을 example에 채우지 않는다 — 채우면 문서를 보는
> 사람 누구나 조직에 들어올 수 있다. 배포 절차는 `docs/deploy-aws.md`.

### 내장 PM — 서버를 거쳐 PM의 실제 응답 보기 (중계 모드)

결제(`ANTHROPIC_API_KEY`) 전까지는 **중계 모드**로 돌린다. 서버가 모델을 직접 부르지 않고, 대표 노트북의
`executor pm-worker`가 작업을 가져가 **자기 Claude Code(구독)**로 실행한 뒤 결과를 돌려준다. 나머지 흐름(응답 해석·검증·교정·저장)은
API 모드와 같다. 결제가 붙으면 `.env`를 `PM_PROVIDER=api` + `ANTHROPIC_API_KEY`로 바꾸면 끝이고, pm-worker는 필요 없다.

```bash
# 1) .env에 PM_PROVIDER=relay 를 두고 서버를 띄운다
npm run seed && npm run dev

# 2) 다른 터미널 — 대표(rep)의 에이전트로 연결한다. 연결 키는 시드 출력의 rep 행.
#    (~/.nomos/credentials를 rep 것으로 덮어쓴다. be-laptop으로 돌아가려면 seed를 다시 돌린다)
NOMOS_CONNECT_KEY=<rep 연결 키> npm run executor -- login http://localhost:3000 --connect-key --name rep-laptop   # -- 필수: 없으면 npm이 --플래그를 가져간다
npm run executor pm-worker      # 켜 둔다. 이 노트북의 claude가 로그인돼 있어야 한다
```

3) Swagger(userToken = rep)에서 `POST /projects/{projectId}/pm/plans`에 `{ "instruction": "..." }` → 202와 계획 id.
   pm-worker 터미널에 `PM 작업 … claude 실행 중`이 뜬다(보통 수십 초~1분).
4) `GET /projects/{projectId}/pm/plans/{planId}`를 몇 초 간격으로 → `status: ready`면 **`draft`가 PM이 낸 JSON 그대로**다.
   `failed`면 `error.reason`을 본다(`timeout`이면 pm-worker가 안 켜져 있었다, `api_error`면 노트북의 claude 실행 실패 — 메시지가 `error.detail`에).
5) 마음에 들면 `POST .../apply`로 명세·태스크가 생긴다. 고칠 게 있으면 `POST .../revise`에 `{ "feedback": "..." }`.

비용은 구독에서 나가지만, `PM_CALL` 이벤트에는 같은 토큰을 API 가격으로 환산한 값이 기록된다(`payload.provider: relay`) —
예산(`pmBudgetUsd`) 검사도 그 값으로 한다.

---

## 1. 준비

### 1-1. PostgreSQL 두 개 — 용도가 다르다

| 용도 | 컨테이너 | 포트 | DB |
|---|---|---|---|
| **수동 테스트** (이 문서) | `nomos-db` | 55433 | `nomos_dev` |
| **자동 테스트** (`npm test`) | `nomos-db-test` | 55432 | `nomos_test` |

```bash
# 수동 테스트용
docker run -d --name nomos-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=nomos_dev -p 55433:5432 postgres:16-alpine

# 자동 테스트용
docker run -d --name nomos-db-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=nomos_test -p 55432:5432 postgres:16-alpine

# 이미 만들어 뒀으면 시작만
docker start nomos-db nomos-db-test
```

컨테이너 이름도 포트도 DB 이름도 다르다. `npm test`는 `nomos-db-test`의 스키마를 매 파일마다 drop하고
다시 만들므로, 수동 테스트 데이터를 그쪽에 넣으면 테스트 한 번에 사라진다.

> **DB를 조회할 때는 컨테이너 이름을 쓰지 말 것.** `npm run db:psql`이 `.env`의 `DATABASE_URL`을
> 그대로 써서 **서버가 실제로 붙는 DB**를 본다. 접속 대상을 첫 줄에 찍어주므로 어디를 보고 있는지 항상 분명하다.
>
> ```bash
> npm run db:psql                                  # 접속 대상 + 테이블별 행 수
> npm run db:psql -- "SELECT * FROM projects"      # 임의 SQL
> ```
>
> `docker exec <컨테이너> psql`로 조회하면 `.env`가 가리키는 DB가 아닌 쪽을 볼 수 있다.
> 실제로 그렇게 헷갈린 적이 있어서 이 스크립트를 만들었다.

### 1-2. `.env` 준비

```bash
cp .env.example .env
```

**채워야 하는 값 세 개:**

| 변수 | 없으면 | 값 만들기 |
|---|---|---|
| `DATABASE_URL` | 서버가 뜨지 않는다 | `postgres://postgres:postgres@localhost:55433/nomos_dev` |
| `JWT_SECRET` | 서버가 뜨지 않는다 | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `SECRET_ENCRYPTION_KEY` | GitHub 연결 **완료 단계**에서만 실패한다 | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |

> ⚠️ **`DATABASE_URL`의 포트를 확인할 것.** §1-1의 수동 테스트 컨테이너는 **55433**(자동 테스트는 55432)이고, 호스트에 직접 설치한
> PostgreSQL은 보통 **5432**다. 둘 다 `nomos_dev`라는 DB를 가질 수 있어서 포트만 틀려도 조용히 다른 DB에 붙는다.
> `npm run seed`가 `relation "notes" does not exist`로 실패하면 **거의 항상 이것**이다 —
> 마이그레이션을 올린 DB와 서버가 붙는 DB가 다르다는 뜻이다. `npm run migrate up`을 같은 `.env`로 다시 돌리면 맞는다.

> ⚠️ **`KMS_KEY_ID`는 비워둘 것.** 채우면 암호화가 **일부러 실패한다** — 운영에서 KMS 대신
> 환경변수 키로 조용히 내려가는 것을 막는 설계다.

**Windows에서 `.env`를 만들 때:**

- 메모장으로 저장하면 인코딩을 **UTF-8**로 지정한다(저장 대화상자 아래쪽 드롭다운). ANSI로 저장하면 한글 주석이 깨진다.
- 메모장은 확장자를 `.txt`로 덧붙인다. 파일 형식을 **"모든 파일"**로 바꾸고 이름을 `.env`로 저장할 것.
  탐색기에서 `.env.txt`가 되어 있으면 서버는 `.env`가 없다고 판단하고 값이 하나도 안 들어간다.
- `.env`는 **`.env.example`과 달리 커밋하지 않는다.**

`.env`는 `src/config/env.ts`가 한 곳에서 읽는다(Node 내장 `process.loadEnvFile`). 그래서
`npm run dev`·`npm run seed`·`npm run migrate` 모두 별도 조작 없이 같은 값을 쓴다.
**이미 셸에 설정된 환경변수가 `.env`보다 우선한다** — 한 번만 다른 DB로 돌려보고 싶으면
`DATABASE_URL=... npm run seed`처럼 앞에 붙이면 된다.

### 1-3. 환경변수 전체 목록

`.env`에 넣는다. **필수는 세 개**이고 나머지는 기본값이 있다.

| 변수 | 필수 | 값 예시 | 없으면 |
|---|---|---|---|
| `DATABASE_URL` | ✅ | `postgres://postgres:postgres@localhost:55433/nomos_dev` | 서버가 뜨지 않는다 |
| `JWT_SECRET` | ✅ | 32자 이상 무작위 문자열 | 서버가 뜨지 않는다 |
| `COMMIT_INSPECTOR` | ✅ | 로컬은 `mirror` | 서버가 뜨지 않는다 — **기본값이 없다**(배포에서 mirror가, 로컬에서 github가 조용히 골라지면 V3가 전부 SKIPPED로 쌓인다) |
| `NODE_ENV` | | `development` | development |
| `PORT` | | `3000` | 3000 |
| `LOG_LEVEL` | | `info` | info |
| `API_BASE_URL` | | `http://localhost:3000` | 같은 값. 시드가 자격 증명의 `baseUrl`로 쓴다 |
| `FRONTEND_BASE_URL` | | `http://localhost:3001` | 같은 값. **초대 링크**가 `{이 값}/invites/{token}`으로 만들어진다 |
| `APP_BASE_URL` | ❌ | — | **두 값으로 나뉘었다.** 남아 있으면 서버가 뜨지 않는다 — 지울 것 |
| `DOCS_ENABLED` | | `true` | 로컬 개발은 켜짐, 그 외 꺼짐 |
| `CORS_ALLOWED_ORIGINS` | | `http://localhost:3001` | CORS 헤더 없음(같은 오리진만) |
| `GITHUB_CLIENT_ID` · `GITHUB_CLIENT_SECRET` | | OAuth App 값 | GitHub Device Flow 두 API만 502 |
| `SECRET_ENCRYPTION_KEY` | | base64 32바이트 | Device Flow **승인 완료 시점**에만 실패 |
| `KMS_KEY_ID` | | **비워둘 것** | — |

비밀값 생성:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"  # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"     # SECRET_ENCRYPTION_KEY
```

> ⚠️ **`KMS_KEY_ID`를 채우면 암호화가 일부러 실패한다.** 운영에서 KMS 대신 환경변수 키로 조용히
> 내려가는 것을 막기 위한 설계다. 로컬에서는 비워두고 `SECRET_ENCRYPTION_KEY`만 쓴다.

### 1-4. 마이그레이션과 서버

`npm run dev`로 띄우면 `/docs`에 Swagger UI가 함께 올라온다(§0).

```bash
npm install
npm run migrate up          # 010까지 적용
npm run dev                 # tsx watch, 포트 3000
# 또는
npm run build && npm start
```

확인:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/invites/nope   # 200 (valid:false)
```

### 1-5. 초기화 — 반복 실행용

```bash
npm run seed
```

**기존 데이터를 전부 비우고 같은 상태를 다시 만든다.** 여러 번 돌려도 결과가 같다.
태스크 상태를 바꿔놓고 처음부터 다시 밟고 싶을 때마다 이것만 실행하면 된다.

만드는 것:

- 계정 3개 — 대표(`rep`), 백엔드(`be`), 프론트엔드(`fe`). 비밀번호는 모두 `manual-test-1234`
- 조직 1개, 초대로 합류한 팀원 2명
- 레포 2개 — `acme/study-api`(BACKEND 소유), `acme/study-web`(FRONTEND 소유). 각각 기본 경로 규칙 15개
- 프로젝트 1개(허용 레벨 **L2**, `status=active`), 정책 사본 17행
- 명세 2개(F-01, F-03), **READY 태스크 4개**(BE 2 / FE 2)
- 에이전트 2개 연결 + access·refresh 토큰, 미사용 초대 토큰 1개

출력은 마크다운 표다. 로그인 정보·연결 키·토큰·`project_id`·`task_id`가 전부 들어 있으니
터미널을 열어두고 복사해 쓰면 된다.

> 프로젝트·태스크 생성 API가 아직 없어 그 테이블만 직접 INSERT한다. 나머지는 전부 서비스 함수를 거치므로
> 이벤트도 정상적으로 쌓이고 불변식도 지켜진다(`npm test`의 전역 검사기와 같은 항목을 통과한다).

---

## 2. 변수 설정

토큰이 두 종류다. **사람 토큰**은 로그인으로, **에이전트 토큰**은 연결 키로 받는다.
`kind` 클레임이 달라서 서로의 API를 부를 수 없다.

```bash
export BASE=http://localhost:3000/api

# ① 사람 토큰 — 조직·레포·경로·초대 API에 쓴다 (1시간)
export TOKEN=$(curl -s -X POST $BASE/auth/login \
  -H 'Content-Type: application/json' \
  --data '{"loginId":"rep","password":"manual-test-1234"}' | jq -r .data.accessToken)

# ② 에이전트 토큰 — 태스크·노트 API에 쓴다 (1시간)
#    npm run seed 출력의 refresh token을 넣는다. access token을 직접 복사해도 된다.
export REFRESH=<시드 출력의 be-laptop refresh token>
export AT=$(curl -s -X POST $BASE/agents/token/refresh \
  -H 'Content-Type: application/json' \
  --data "{\"refreshToken\":\"$REFRESH\"}" | jq -r .data.accessToken)

# ③ 식별자 — 시드 출력에서 복사
export ORG_ID=... PROJECT_ID=... REPO_API=... REPO_WEB=... TASK_ID=... SPEC_F03=...
```

`jq`가 없으면 응답을 그대로 보고 눈으로 복사한다.

> ⚠️ **Windows에서 한글이 포함된 `--data`는 깨진다.** cmd·PowerShell이 인자를 CP949로 넘기기 때문이고
> 서버 문제가 아니다. 한글 본문을 보낼 때는 UTF-8 파일로 저장해 `--data @body.json`을 쓴다.

---

## 3. A — API 32개

인증 칸: **user** = `Authorization: Bearer $TOKEN`, **agent** = `Bearer $AT`, **없음** = 헤더 불필요.
에이전트 토큰은 프로젝트에 배정된 것이어야 한다(아니면 403 `NOT_PROJECT_MEMBER`).

### 인증 · 계정

| 메서드 | 경로 | 토큰 | 성공 | 주요 실패 |
|---|---|---|---|---|
| POST | `/api/auth/signup` | 없음 | 201 | 409 `LOGIN_ID_TAKEN`, 400 `VALIDATION_ERROR` |
| POST | `/api/auth/login` | 없음 | 200 | 401 `INVALID_CREDENTIALS` |
| POST | `/api/me/connect-key/rotate` | user | 200 | 401 `UNAUTHENTICATED` |

```bash
curl -s -X POST $BASE/auth/signup -H 'Content-Type: application/json' \
  --data '{"loginId":"tester","password":"manual-test-1234","nickname":"tester"}'
curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  --data '{"loginId":"rep","password":"manual-test-1234"}'
curl -s -X POST $BASE/me/connect-key/rotate -H "Authorization: Bearer $TOKEN"
```

없는 아이디와 틀린 비밀번호는 **같은 응답**이다. 없는 아이디일 때도 scrypt를 한 번 돌려 응답 시간까지 맞춘다.
연결 키를 재발급하면 **기존 키는 즉시 무효**다.

### CLI 연결

| 메서드 | 경로 | 토큰 | 성공 | 주요 실패 |
|---|---|---|---|---|
| POST | `/api/agents/connect` | 없음(연결 키) | 201 | 400 `INVALID_CONNECT_REQUEST` |
| POST | `/api/agents/token/refresh` | 없음(refresh) | 200 | 401 `INVALID_REFRESH_TOKEN` |

```bash
curl -s -X POST $BASE/agents/connect -H 'Content-Type: application/json' \
  --data '{"connectKey":"<be 연결 키>","agentName":"be-laptop","harness":"claude-code@2.1.263","skills":["typescript"],"maxConcurrent":2}'
curl -s -X POST $BASE/agents/token/refresh -H 'Content-Type: application/json' \
  --data "{\"refreshToken\":\"$REFRESH\"}"
```

**틀린 연결 키는 401이 아니라 400 + 일반 메시지다.** 무엇이 틀렸는지 알려주지 않는다.
같은 `agentName`으로 다시 연결하면 새 행을 만들지 않고 갱신한다(CLI 재설치 대응).

#### 브라우저 승인(device flow) — CLI 기본 로그인

| 메서드 | 경로 | 토큰 | 성공 | 주요 실패 |
|---|---|---|---|---|
| POST | `/api/agents/device/start` | 없음 | 201 | 400 `VALIDATION_ERROR` |
| POST | `/api/agents/device/poll` | 없음(deviceCode) | 200(pending·slow_down·expired·denied·approved) | 400 `INVALID_DEVICE_CODE` |
| GET | `/api/agents/device/requests/{userCode}` | 사람 | 200 | 404 |
| POST | `/api/agents/device/requests/{userCode}/approve` · `/deny` | 사람 | 200 | 404 · 409 이미 결정 · 410 만료 |

```bash
# CLI 쪽 — 실제로는 executor login이 한다
curl -s -X POST $BASE/agents/device/start -H 'Content-Type: application/json'   --data '{"agentName":"be-laptop","harness":"claude-code"}'          # → deviceCode, userCode(예: WDJB-MJHT)
export DEVICE=<deviceCode>; export UCODE=<userCode>
curl -s -X POST $BASE/agents/device/poll -H 'Content-Type: application/json' --data "{\"deviceCode\":\"$DEVICE\"}"   # pending

# 웹 쪽 — 로그인한 사람
curl -s $BASE/agents/device/requests/$UCODE -H "Authorization: Bearer $REP"               # 코드·이름·IP 확인
curl -s -X POST $BASE/agents/device/requests/$UCODE/approve -H "Authorization: Bearer $REP"

sleep 5   # interval보다 빨리 부르면 slow_down
curl -s -X POST $BASE/agents/device/poll -H 'Content-Type: application/json' --data "{\"deviceCode\":\"$DEVICE\"}"   # approved + 토큰(한 번만)
```

- 같은 deviceCode로 다시 poll하면 `expired` — 토큰은 한 번만 나간다.
- 10분이 지나면 승인은 410, poll은 `expired`.
- userCode는 대소문자·하이픈을 무시한다(`wdjbmjht`도 된다).
- CLI로 한 번에: `npm run executor -- connect --server http://localhost:3000` → 브라우저가 열린다(프론트의 `/connect/device`가 아직 없으면 위 curl로 승인).
  로그인 뒤 배정을 기다렸다가 자동으로 폴링을 시작한다. 로그인만 하려면 `npm run executor -- login http://localhost:3000`,
  연결 키 경로는 `npm run executor -- login http://localhost:3000 --connect-key`.
  **`--`를 빼면 안 된다** — npm이 `--connect-key`·`--name`·`--server`를 자기 옵션으로 가져가 스크립트에 전달하지 않는다.
  배포된 패키지(`npx @capstone-nomos/cli …`)에는 이 문제가 없다.

#### CLI 패키지(@capstone-nomos/cli)

팀원은 서버 레포를 받지 않고 `npx @capstone-nomos/cli@latest connect` 한 줄로 시작한다(`--server` 기본값은 운영 주소).
패키지는 `src/executor`·`src/bridge`만 `packages/cli/dist`로 빌드한 것이다(`tsconfig.cli.json`).

```bash
npm run build:cli            # packages/cli/dist
npm run check:cli-package    # pack → 임시 폴더에 설치 → 다른 폴더에서 --version·doctor → MCP 서버 띄워 도구 목록 확인
```

로컬 서버에 패키지로 붙어 보려면: `npm run build:cli && npx ./packages/cli connect --server http://localhost:3000`.

배포는 `cli-v<버전>` 태그 push(`.github/workflows/publish-cli.yml`, Trusted Publishing). **첫 버전만** 손으로 올린다 —
Trusted Publisher는 패키지가 있어야 등록할 수 있다.

1. npmjs.com에서 조직 `capstone-nomos`를 만든다(공개 패키지는 무료). 팀원을 멤버로 초대한다.
2. `npm login` → `npm run build:cli && npm run check:cli-package` → `cd packages/cli && npm publish --access public`
3. npmjs.com → 패키지 Settings → **Trusted Publisher**: GitHub Actions, 조직 `Capstone-NOMOS`, 레포 `backend`, 워크플로 `publish-cli.yml`.
   그리고 같은 화면에서 토큰 publish를 막는다(Require two-factor and disallow tokens).
4. 이후: `packages/cli/package.json`의 version을 올려 커밋 → `git tag cli-v0.1.1 && git push origin cli-v0.1.1`.

### 조직

| 메서드 | 경로 | 토큰 | 성공 | 주요 실패 |
|---|---|---|---|---|
| POST | `/api/orgs` | user | 201 | 409 `ALREADY_IN_ORG` |
| GET | `/api/orgs/:orgId/github/repos` | user(멤버) | 200 | 403 `CROSS_ORG_ACCESS` |
| GET | `/api/orgs/:orgId/members` | user(멤버) | 200 | 403 `CROSS_ORG_ACCESS` |

```bash
curl -s -X POST $BASE/orgs -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data '{"name":"Acme Inc."}'
curl -s $BASE/orgs/$ORG_ID/github/repos -H "Authorization: Bearer $TOKEN"
curl -s $BASE/orgs/$ORG_ID/members -H "Authorization: Bearer $TOKEN"
```

대표가 GitHub를 연결하지 않았으면 레포 목록은 **빈 배열**이고, 멤버 목록에서는 `isCollaborator` 필드가 **생략**된다(GitHub 호출은 전부 대표의 토큰으로 한다 — 서버 공용 PAT는 없다)
(`false`로 채우지 않는다 — "확인 안 됨"과 "권한 없음"은 다르다).
시드 계정은 이미 조직에 속해 있으므로 `POST /api/orgs`는 409가 정상이다.

### 레포 · 경로 소유권

| 메서드 | 경로 | 토큰 | 성공 | 주요 실패 |
|---|---|---|---|---|
| POST | `/api/orgs/:orgId/repos` | user(멤버) | 201 | 409 `REPO_ALREADY_CONNECTED`, 403 `CROSS_ORG_ACCESS` |
| GET | `/api/repos/:repoId/paths` | user(멤버) | 200 | 404 `REPO_NOT_FOUND`, 403 `CROSS_ORG_ACCESS` |
| POST | `/api/repos/:repoId/paths` | user(대표) | 201 | 409 `PATH_PRIORITY_TAKEN`, 400 `INVALID_GLOB_PATTERN` |
| PATCH | `/api/repos/:repoId/paths/:pathId` | user(대표) | 200 | 409 `IMMUTABLE_ORG_CEILING`, 404 `PATH_NOT_FOUND` |
| PATCH | `/api/repos/:repoId` | user(대표) | 200 | 400 `VALIDATION_ERROR`(clone_url), 409 `REPO_ALREADY_CONNECTED`(github_repo_id 중복) |

```bash
curl -s -X POST $BASE/orgs/$ORG_ID/repos -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data '{"repos":[{"fullName":"acme/extra-repo"}]}'

curl -s $BASE/repos/$REPO_API/paths -H "Authorization: Bearer $TOKEN"

curl -s -X POST $BASE/repos/$REPO_API/paths -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data '{"pathPattern":"api/**","ownerRole":"BACKEND","access":"write"}'

export PATH_ID=$(curl -s $BASE/repos/$REPO_API/paths -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data.paths[] | select(.pathPattern=="tests/**") | .id')
curl -s -X PATCH $BASE/repos/$REPO_API/paths/$PATH_ID -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data '{"ownerRole":"BACKEND"}'
```

- `priority`는 **manual 대역 200~299**만 받고, 안 주면 대역 최댓값 + 1이 된다.
- `**/.env*`처럼 priority 900 이상인 조직 상한 행은 **어떤 필드도** 바꿀 수 없다 → 409 `IMMUTABLE_ORG_CEILING`.
- `{a,b}`·`!`·`?`·`[]`는 거부된다. 부정이 필요하면 `priority`로 푼다.
- **경로 규칙을 바꾸면 그 레포를 쓰는 프로젝트의 `policy_hash`가 갱신된다** → 이미 발급된 에이전트 토큰은
  즉시 401 `POLICY_STALE`이 된다(§4 B-9에서 확인).

### 프로젝트

| 메서드 | 경로 | 토큰 | 성공 | 주요 실패 |
|---|---|---|---|---|
| POST | `/api/orgs/:orgId/projects` | user(대표) | 201 | 422 `INVALID_AUTONOMY_PRESET`, 409 `REPO_IN_ACTIVE_PROJECT`, 404 `REPO_NOT_FOUND` |
| GET | `/api/projects/:projectId` | user(대표 또는 배정된 에이전트의 주인) | 200 | 403 `NOT_PROJECT_MEMBER`, 404 `PROJECT_NOT_FOUND` |
| POST | `/api/projects/:projectId/members` | user(대표) | 201 | 409 `ROLE_ALREADY_ASSIGNED` · `AGENT_ALREADY_ASSIGNED`, 403 `AGENT_NOT_IN_ORG` · `PROJECT_STARTED` |
| DELETE | `/api/projects/:projectId/members/:agentId` | user(대표) | 200 | 404 `MEMBER_NOT_FOUND`, 403 `PROJECT_STARTED` |
| POST | `/api/projects/:projectId/start` | user(대표) | 200 | 422 `PROJECT_START_INVALID`(태스크 없음·역할 공백), 409 `PROJECT_ALREADY_STARTED` |
| GET | `/api/agents/me/tasks` | agent | 200 | 403 `NOT_PROJECT_MEMBER` |

```bash
curl -s -X POST $BASE/orgs/$ORG_ID/projects -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json'   --data "{\"name\":\"p2\",\"autonomyPreset\":\"L2\",\"pmBudgetUsd\":40,\"repoIds\":[\"$REPO_API\"]}"

curl -s $BASE/projects/$PROJECT_ID -H "Authorization: Bearer $TOKEN"

curl -s -X POST $BASE/projects/$PROJECT_ID/members -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json'   --data "{\"agentId\":\"$AGENT_ID\",\"teamRole\":\"BACKEND\"}"

curl -s -X DELETE $BASE/projects/$PROJECT_ID/members/$AGENT_ID -H "Authorization: Bearer $TOKEN"

# 프로젝트 시작(G1). npm run seed는 이미 시작한 프로젝트를 만든다 — 시작 흐름을 보려면 npm run seed -- --planning
curl -s -X POST $BASE/projects/$PROJECT_ID/start -H "Authorization: Bearer $TOKEN"

# 에이전트가 지금 가져갈 수 있는 태스크(웹소켓 푸시와 같은 목록)
curl -s $BASE/agents/me/tasks -H "Authorization: Bearer $AGENT_TOKEN"
```

- **시작 전에는 에이전트가 태스크를 가져갈 수 없다**(claim 409 `PROJECT_NOT_STARTED`). 시작하면 서버가 역할별 담당 에이전트에게 태스크를 푸시한다.
- 시작 뒤에는 멤버 배정·해제가 403이다. 시작하기 전에 태스크가 쓰는 역할을 전부 배정해야 한다(아니면 422로 어느 역할이 비었는지 알려준다).
- 웹소켓은 `ws://localhost:3000/api/agents/stream`. 연결 뒤 첫 메시지로 `{"type":"auth","token":"<에이전트 access token>"}`를 보내면
  `ready` 뒤에 `{"type":"tasks","tasks":[...]}`가 오고, 프로젝트 상태가 바뀔 때마다 다시 온다. 브라우저 콘솔에서:
  `const ws = new WebSocket('ws://localhost:3000/api/agents/stream'); ws.onopen = () => ws.send(JSON.stringify({type:'auth', token:'…'})); ws.onmessage = (e) => console.log(e.data)`

- 생성은 한 트랜잭션에서 **프로젝트 · 레포 연결 · 정책 사본 17행 · 헌법 스냅샷 · `policy_hash`**를 함께 만든다.
  판정은 이후 `action_catalog`가 아니라 이 사본만 본다.
- **같은 레포를 두 활성 프로젝트가 쓸 수 없다**(409). 끝난(`completed`·`aborted`) 프로젝트의 레포는 다시 쓸 수 있다.
- ⚠️ **배정 뒤에는 그 에이전트의 토큰을 재발급해야 한다.** 배정 전 토큰에는 `project_id`가 없어
  태스크·노트 API가 403 `NOT_PROJECT_MEMBER`로 막힌다. 응답의 `notice`가 같은 안내를 준다.
- **G1(`started_at`) 이후에는 멤버를 바꿀 수 없다**(403). 역할 교체는 해제 후 재배정이다.

### 초대

| 메서드 | 경로 | 토큰 | 성공 | 주요 실패 |
|---|---|---|---|---|
| POST | `/api/orgs/:orgId/invites` | user(대표) | 201 | 403 `NOT_REPRESENTATIVE` |
| GET | `/api/invites/:token` | 없음 | 200 | — (무효해도 200 + `valid:false`) |
| POST | `/api/invites/:token/accept` | user | 200 | 410 `INVITE_EXPIRED` · `INVITE_ALREADY_USED`, 409 `ALREADY_IN_ORG` |

```bash
curl -s -X POST $BASE/orgs/$ORG_ID/invites -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data '{"teamRole":"FRONTEND","expiresInDays":7}'
curl -s $BASE/invites/$INVITE_TOKEN
curl -s -X POST $BASE/invites/$INVITE_TOKEN/accept -H "Authorization: Bearer $TOKEN"
```

무효한 토큰도 404가 아니라 200 + `valid:false`다. 토큰 존재 여부를 드러내지 않기 위해서다.
시드 계정으로 수락하면 409 `ALREADY_IN_ORG`가 정상 — 새 계정으로 가입해서 밟아야 한다(§4 B-6).

### GitHub OAuth (Device Flow)

| 메서드 | 경로 | 토큰 | 성공 | 주요 실패 |
|---|---|---|---|---|
| POST | `/api/auth/github/device/start` | user | 200 | 502 `GITHUB_UNAVAILABLE`(미설정) |
| POST | `/api/auth/github/device/poll` | user | 200 | 409 `GITHUB_ACCOUNT_TAKEN` |

```bash
curl -s -X POST $BASE/auth/github/device/start -H "Authorization: Bearer $TOKEN"
curl -s -X POST $BASE/auth/github/device/poll -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data '{"deviceCode":"<start 응답의 deviceCode>"}'
```

승인 전에는 `{"status":"pending"}`이 **200**으로 온다. `expired`·`denied`도 에러가 아니라 상태로 온다 —
폴링의 정상적인 중간 상태이기 때문이다. `GITHUB_CLIENT_ID`가 없으면 이 두 API만 502이고 나머지는 정상이다.

### 태스크 · 노트 (MCP 도구의 서버 쪽)

| 메서드 | 경로 | 토큰 | 성공 | 주요 실패 |
|---|---|---|---|---|
| POST | `/api/tasks/:taskId/claim` | agent | 200 | 409 `TASK_ALREADY_CLAIMED` · `TASK_DEPS_NOT_DONE`, 403 `TASK_ROLE_MISMATCH` |
| POST | `/api/tasks/:taskId/artifacts` | agent | 201 | 403 `FORBIDDEN_PATH` · `SCOPE_DENIED` · `NOT_TASK_ASSIGNEE`, 409 `TASK_STATE_INVALID` |
| POST | `/api/tasks/:taskId/notes` | agent | 201 | 422 `NOTE_INVALID`, 403 `NOT_TASK_ASSIGNEE` |
| GET | `/api/projects/:projectId/notes` | agent 또는 user | 200 | 403 `NOT_PROJECT_MEMBER` · `CROSS_ORG_ACCESS` |
| GET | `/api/projects/:projectId/tasks` | agent 또는 user | 200 | 403 `NOT_PROJECT_MEMBER` |
| GET | `/api/tasks/:taskId/briefing` | agent | 200 | 403 `TASK_ROLE_MISMATCH` |
| PATCH | `/api/tasks/:taskId/branch` | agent | 200 | 404 `TASK_NOT_FOUND` |
| GET | `/api/agents/me` | agent | 200 | 401 |

위 API 모두 **0a**(프로젝트 정지 → 403 `PROJECT_HALTED`)와 **0b**(정책 신선도 → 401 `POLICY_STALE`)를 먼저 통과한다.

```bash
curl -s -X POST $BASE/tasks/$TASK_ID/claim -H "Authorization: Bearer $AT"

curl -s -X POST $BASE/tasks/$TASK_ID/artifacts -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
  --data '{"commitSha":"a1b2c3d","changedPaths":["src/participation.ts","tests/participation.test.ts"]}'

curl -s -X POST $BASE/tasks/$TASK_ID/notes -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
  --data '{"kind":"IMPLEMENTED","headline":"participation API done","keyPoints":["409 on full study"]}'

curl -s "$BASE/projects/$PROJECT_ID/notes?limit=5&since_seq=0" -H "Authorization: Bearer $AT"
```

- `commitSha`는 소문자 hex 7~40자, `changedPaths`는 1개 이상.
- 제출 응답의 `gateMode`가 **적용된 승인 수준**, `triggeredActions`가 걸린 칸이다. 위 예시는
  `["artifact:submit","code:own_path","test:write"]` → 전부 AUTO이므로 `gateMode=AUTO`.
  `changedPaths`에 `migrations/010_x.sql`을 섞으면 `db:migration`이 걸려 L2에서 `gateMode=HUMAN`이 된다.
- 노트는 **제목을 서버가 조립해** 응답의 `title`에 담는다(`#1 - 백엔드 F-03 구현 완료 — …`).
  형식 위반은 자르지 않고 422 `details`에 **몇 번째 항목이 몇 자인지** 돌려준다.
- `kind`는 `IMPLEMENTED` · `DECIDED` · `GOTCHA` · `DEVIATION` 네 개뿐이고, `DEVIATION`은 `affects`가 필수다.

### 검증 (V1A~V4)

| 메서드 | 경로 | 토큰 | 성공 | 주요 실패 |
|---|---|---|---|---|
| GET | `/api/tasks/:taskId/artifacts` | agent(담당자) 또는 user | 200 | 403 `NOT_TASK_ASSIGNEE`(에이전트) · `NOT_PROJECT_MEMBER` |
| POST | `/api/artifacts/:artifactId/verifications` | agent(담당자) | 201 | 403 `VERIFICATION_STAGE_NOT_REPORTABLE`, 409 `VERIFICATION_ALREADY_RECORDED`, 400 사유 없는 SKIPPED |
| GET | `/api/artifacts/:artifactId/verifications` | agent 또는 user | 200 | — |

```bash
# 방금 제출한 산출물의 id (최신이 맨 앞)
ART=$(curl -s $BASE/tasks/$TASK_ID/artifacts -H "Authorization: Bearer $AT" \
      | python -c "import sys,json;print(json.load(sys.stdin)['data']['artifacts'][0]['id'])")

# 브릿지 단계 보고 — V2·V4만 받는다
curl -s -X POST $BASE/artifacts/$ART/verifications -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
  --data '{"stage":"V4","result":"PASS","detail":{"command":"npm run lint"}}'

# V3을 보고하려 하면 403 — 로컬을 믿지 않는 것이 V3의 전제다
curl -s -X POST $BASE/artifacts/$ART/verifications -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
  --data '{"stage":"V3","result":"PASS","detail":{}}'

curl -s $BASE/artifacts/$ART/verifications -H "Authorization: Bearer $AT"
```

- **제출 응답에 이미 `verification`이 들어 있다.** V1A·V1B·V3은 서버가 혼자 판정하므로 동기로 끝난다.
  브릿지가 보고하는 것은 작업공간이 있어야 돌 수 있는 V2·V4뿐이다.
- `verification.outcome` 읽는 법: `PENDING`(V2·V4 대기) · `DONE` · `AWAITING_APPROVAL`(gateMode가 AUTO가 아님) ·
  `RETRY`(FAIL — READY로 돌아가고 `retry_count`가 올랐다) · `ESCALATED`(3회째 FAIL).
- **`AWAITING_APPROVAL`은 지금 막다른 길이다.** approvals 테이블과 승인·반려 API가 아직 없어서
  그 상태에서 나올 경로가 없다. 응답의 `verification.notice`와 서버 경고 로그, `VERIFICATION_COMPLETED`
  이벤트의 `payload.notice`에 같은 문장이 남는다. 시드 태스크는 전부 AUTO라 여기 걸리지 않지만,
  `db:migration`처럼 게이트가 AUTO가 아닌 행동을 건드리는 태스크를 만들면 바로 멈춘다.
  풀려면 `UPDATE tasks SET state = 'DONE' WHERE id = ...`로 사람이 직접 옮긴다.
- **`SKIPPED`는 `PASS`가 아니다.** 사유(`detail.reason`) 없이는 DB가 받지 않는다.
  시드 상태에서 V1A는 `contracts 테이블 미구현 — ⑦ 이후 가능`, V1B는 `dev_base_url 미설정`으로 SKIPPED다.

---

## 4. B — 시나리오 대본

순서대로 밟는다. 각 단계 아래 **"남아야 하는 이벤트"**가 있으니 §5의 SQL로 확인하며 진행한다.

`npm run seed`로 초기화한 뒤 시작한다. **B-1~B-7은 새 계정으로 온보딩 전체를 API만으로 밟는다** —
가입부터 프로젝트 생성·멤버 배정까지 전부 된다. B-8부터는 시드가 만들어 둔 백엔드 에이전트로 작업 흐름을 밟는다.
태스크 생성 API만 아직 없어서(PM이 맡을 일) READY 태스크가 있는 시드 프로젝트가 필요하기 때문이다.

### B-1. 가입

```bash
curl -s -X POST $BASE/auth/signup -H 'Content-Type: application/json' \
  --data '{"loginId":"newbie","password":"manual-test-1234","nickname":"newbie"}'
```

응답의 `connectKey`를 저장한다. **평문은 이 응답에서 한 번만** 나온다.
→ 남아야 하는 이벤트: `USER_SIGNED_UP` (`org_id`는 **NULL** — 아직 조직이 없다)

### B-2. CLI 연결

```bash
export NEW_KEY=<B-1의 connectKey>
curl -s -X POST $BASE/agents/connect -H 'Content-Type: application/json' \
  --data "{\"connectKey\":\"$NEW_KEY\",\"agentName\":\"newbie-laptop\",\"harness\":\"claude-code@2.1.263\"}"
```

조직도 프로젝트도 없이 연결된다(`status=pending`). 토큰의 `project_id`·`policy_hash`는 `null`이다.
→ `AGENT_CONNECTED` (`org_id` NULL, `method: connect_key`)

브라우저 승인으로 해도 같다(위 "브라우저 승인" 절). 그때는 `AGENT_DEVICE_REQUESTED`(system:device-flow) →
`AGENT_DEVICE_DECIDED`(승인한 사람) → `AGENT_CONNECTED`(`method: device`) 순으로 남는다.

### B-3. 조직 생성

```bash
export NEW_TOKEN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  --data '{"loginId":"newbie","password":"manual-test-1234"}' | jq -r .data.accessToken)
curl -s -X POST $BASE/orgs -H "Authorization: Bearer $NEW_TOKEN" -H 'Content-Type: application/json' \
  --data '{"name":"Newbie Inc."}'
```

만든 사람이 대표가 된다. **이 순간 B-2에서 연결해 둔 에이전트의 `org_id`도 함께 채워진다.**
→ `ORG_CREATED` (payload의 `agentIds`에 B-2의 에이전트가 들어 있어야 한다)

확인:

```bash
npm run db:psql -- "SELECT u.login_id, u.org_id, a.name, a.org_id FROM users u JOIN agents a ON a.user_id = u.id WHERE u.login_id='newbie'"
```

두 `org_id`가 같아야 한다. 다르면 008 복합 FK가 막아야 하는 상태다.

### B-4. 레포 연결과 경로 소유권

```bash
export NEW_ORG=<B-3 응답의 orgId>
curl -s -X POST $BASE/orgs/$NEW_ORG/repos -H "Authorization: Bearer $NEW_TOKEN" \
  -H 'Content-Type: application/json' --data '{"repos":[{"fullName":"newbie/api"}]}'

export NEW_REPO=<위 응답의 repo id>
curl -s $BASE/repos/$NEW_REPO/paths -H "Authorization: Bearer $NEW_TOKEN" | jq '.data.paths | length'   # 15
```

기본 경로 규칙 **15개**가 자동 생성된다. 대표가 `**` 행의 소유 역할을 지정하는 것이 온보딩의 산출물이다.

```bash
export STAR=$(curl -s $BASE/repos/$NEW_REPO/paths -H "Authorization: Bearer $NEW_TOKEN" \
  | jq -r '.data.paths[] | select(.pathPattern=="**") | .id')
curl -s -X PATCH $BASE/repos/$NEW_REPO/paths/$STAR -H "Authorization: Bearer $NEW_TOKEN" \
  -H 'Content-Type: application/json' --data '{"ownerRole":"BACKEND"}'
```

→ `REPO_CONNECTED`(`seededPathCount: 15`), 이어서 `REPO_PATH_UPDATED`(payload에 before/after)

조직 상한 행은 못 바꾼다 — 확인해 볼 것:

```bash
export ENV_ROW=$(curl -s $BASE/repos/$NEW_REPO/paths -H "Authorization: Bearer $NEW_TOKEN" \
  | jq -r '.data.paths[] | select(.pathPattern=="**/.env*") | .id')
curl -s -X PATCH $BASE/repos/$NEW_REPO/paths/$ENV_ROW -H "Authorization: Bearer $NEW_TOKEN" \
  -H 'Content-Type: application/json' --data '{"ownerRole":"BACKEND"}'   # 409 IMMUTABLE_ORG_CEILING
```

### B-5. 프로젝트 생성과 멤버 배정

```bash
export NEW_PROJECT=$(curl -s -X POST $BASE/orgs/$NEW_ORG/projects -H "Authorization: Bearer $NEW_TOKEN"   -H 'Content-Type: application/json'   --data "{\"name\":\"newbie 프로젝트\",\"autonomyPreset\":\"L2\",\"pmBudgetUsd\":40,\"repoIds\":[\"$NEW_REPO\"]}"   | jq -r .data.project.id)

curl -s $BASE/projects/$NEW_PROJECT -H "Authorization: Bearer $NEW_TOKEN" | jq '.data.project.status, .data.repos'
```

`status`는 `planning`, `startedAt`은 `null`이다. 같은 요청에서 정책 사본 17행과 `policy_hash`가 함께 만들어진다.

→ `PROJECT_CREATED` (payload에 `autonomyPreset`·`repoIds`·`policyHash`·`constitutionHash`)

확인해 볼 것:

```bash
npm run db:psql -- "SELECT count(*) FROM project_policies WHERE project_id='$NEW_PROJECT'"   -- 17
npm run db:psql -- "SELECT policy_hash, constitution_hash FROM projects WHERE id='$NEW_PROJECT'"
```

같은 레포로 한 번 더 만들면 409다 — 활성 프로젝트끼리 레포를 공유할 수 없다.

**멤버 배정:**

```bash
export NEW_AGENT=<B-2에서 받은 agentId>
curl -s -X POST $BASE/projects/$NEW_PROJECT/members -H "Authorization: Bearer $NEW_TOKEN"   -H 'Content-Type: application/json'   --data "{\"agentId\":\"$NEW_AGENT\",\"teamRole\":\"BACKEND\"}"
```

→ `MEMBER_ASSIGNED` (`actor_agent_id`가 배정된 에이전트, `on_behalf_of`는 대표)

⚠️ **여기서 토큰을 재발급해야 한다.** B-2에서 받은 토큰에는 `project_id`가 없다.

```bash
export NEW_AT=$(curl -s -X POST $BASE/agents/token/refresh -H 'Content-Type: application/json'   --data "{\"refreshToken\":\"<B-2의 refreshToken>\"}" | jq -r .data.accessToken)
```

재발급 전 토큰으로 태스크 API를 부르면 403 `NOT_PROJECT_MEMBER`다. 한 번 눌러보면 이유가 분명해진다.

> **명세·태스크 생성 API는 아직 없다.** 그건 PM이 맡을 일(⑧)이라 `npm run seed`가 대신 만든다.
> 그래서 B-8부터는 시드가 만든 조직(`rep`/`be`/`fe`)으로 옮겨 탄다 — READY 태스크가 거기 있기 때문이다.
> 방금 만든 조직에서 이어가고 싶으면 `scripts/seed-manual.ts`의 ⑧절처럼 `specs`·`tasks`를 직접 INSERT하면 된다.

### B-6. 초대 발급

```bash
curl -s -X POST $BASE/orgs/$NEW_ORG/invites -H "Authorization: Bearer $NEW_TOKEN" \
  -H 'Content-Type: application/json' --data '{"teamRole":"BACKEND"}'
```

→ `INVITE_CREATED` (payload에 `teamRole`, `expiresAt`. **토큰은 payload에 없다** — 비밀값 금지)

미리보기는 인증 없이:

```bash
curl -s $BASE/invites/<token>      # 200 + valid:true
curl -s $BASE/invites/nope         # 200 + valid:false — 404가 아니다
```

### B-7. 합류

```bash
curl -s -X POST $BASE/auth/signup -H 'Content-Type: application/json' \
  --data '{"loginId":"joiner","password":"manual-test-1234","nickname":"joiner"}'
export JOIN_TOKEN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  --data '{"loginId":"joiner","password":"manual-test-1234"}' | jq -r .data.accessToken)
curl -s -X POST $BASE/invites/<token>/accept -H "Authorization: Bearer $JOIN_TOKEN"
```

→ `INVITE_ACCEPTED` + `MEMBER_JOINED`(`teamRole: BACKEND`)

같은 링크를 **다시 눌러도 성공**한다(멱등). 이미 다른 조직에 속한 사람은 409 `ALREADY_IN_ORG`.

### B-8. claim_task → submit_artifact → publish_note

여기서부터 **시드 계정**으로 옮겨 탄다. §2의 `$AT`(be-laptop)와 `$TASK_ID`(BACKEND 태스크)를 쓴다.

```bash
curl -s -X POST $BASE/tasks/$TASK_ID/claim -H "Authorization: Bearer $AT"
```

응답의 `state`가 `CLAIMED`, `assigneeAgentId`가 내 에이전트여야 한다.
한 번 더 부르면 409 `TASK_ALREADY_CLAIMED` — 경합에서 진 쪽이 받는 답이다.
FRONTEND 태스크를 잡으면 403 `TASK_ROLE_MISMATCH`.
→ `TASK_CLAIMED` (payload에 `teamRole`, `unrestricted:false`)

```bash
curl -s -X POST $BASE/tasks/$TASK_ID/artifacts -H "Authorization: Bearer $AT" \
  -H 'Content-Type: application/json' \
  --data '{"commitSha":"a1b2c3d","changedPaths":["src/participation.ts","tests/participation.test.ts"]}'
```

`gateMode=AUTO`, `attempt=1`, `triggeredActions=["artifact:submit","code:own_path","test:write"]`.
태스크는 `VERIFYING`으로 넘어간다(V1~V4는 아직 없다).
→ `ARTIFACT_SUBMITTED` (payload에 판정이 **고정**된다 — 나중에 정책이 바뀌어도 이 행은 그대로)

```bash
curl -s -X POST $BASE/tasks/$TASK_ID/notes -H "Authorization: Bearer $AT" \
  -H 'Content-Type: application/json' \
  --data '{"kind":"IMPLEMENTED","headline":"participation API done","keyPoints":["409 on full study"]}'
```

응답의 `title`이 `#1 - 백엔드 F-03 구현 완료 — participation API done`이어야 한다(서버가 조립).
→ `NOTE_PUBLISHED`

읽기도 해 본다. **이건 이벤트를 남기지 않는다:**

```bash
curl -s "$BASE/projects/$PROJECT_ID/notes?limit=5" -H "Authorization: Bearer $AT" | jq '.data.notes | length'
```

형식 위반도 확인:

```bash
curl -s -X POST $BASE/tasks/$TASK_ID/notes -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
  --data '{"kind":"DEVIATION","headline":"x","keyPoints":["y"]}'      # 422 — DEVIATION은 affects 필수
```

응답의 `error.details`에 위반이 **전부** 들어 있어야 한다(어느 필드의 몇 번째가 몇 자인지).
`code`와 `message`만 오면 에이전트가 무엇을 고쳐야 할지 알 수 없다:

```bash
curl -s -X POST $BASE/tasks/$TASK_ID/notes -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
  --data "{\"kind\":\"IMPLEMENTED\",\"headline\":\"x\",\"keyPoints\":[\"$(printf '가%.0s' $(seq 121))\"]}" \
  | jq '.error.details'
```

422는 **권한 거부가 아니므로 `TOOL_DENIED`가 남지 않는다.** 오타를 차단 지표에 섞지 않기 위해서다.

### B-9. 금지 경로 제출 → 403

두 번째 BACKEND 태스크를 잡고 비밀 파일을 제출해 본다.

```bash
export TASK2=<시드 출력의 두 번째 BACKEND task_id>
curl -s -X POST $BASE/tasks/$TASK2/claim -H "Authorization: Bearer $AT"
curl -s -X POST $BASE/tasks/$TASK2/artifacts -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
  --data '{"commitSha":"a1b2c3d","changedPaths":["api/.env"]}'
```

`403 FORBIDDEN_PATH` + `"**/.env* is denied"`. **`artifacts`에는 행이 생기지 않는다.**
→ `TOOL_DENIED` (`stage=forbidden_path`, `path_violation=false`)

`path_violation`이 `false`인 게 중요하다. `.env`는 **아무도 소유하지 않으므로** 소유권 위반이 아니다.
남의 소유 경로를 제출하면 같은 403이지만 `stage=ownership`, `path_violation=true`로 남는다.

### B-10. 경로 규칙 변경 → 401 policy_stale → 재발급 → 성공

대표가 경로 규칙을 바꾼다(사람 토큰):

```bash
export PATH_ID=$(curl -s $BASE/repos/$REPO_API/paths -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data.paths[] | select(.pathPattern=="tests/**") | .id')
curl -s -X PATCH $BASE/repos/$REPO_API/paths/$PATH_ID -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data '{"ownerRole":"BACKEND"}'
```

→ `REPO_PATH_UPDATED`. 이 시점에 `projects.policy_hash`가 갱신되고 **$AT은 옛 스냅샷 기준**이 된다.

옛 토큰으로 호출:

```bash
curl -s -X POST $BASE/tasks/$TASK2/artifacts -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
  --data '{"commitSha":"a1b2c3d","changedPaths":["src/quota.ts"]}'
```

```json
{ "error": { "code": "POLICY_STALE", "message": "policy snapshot changed; refresh the token",
             "reason": "policy_stale" } }
```

401이다. → `TOOL_DENIED` (`stage=policy_stale`)

재발급하고 **원 요청을 1회만** 재시도한다:

```bash
export AT=$(curl -s -X POST $BASE/agents/token/refresh -H 'Content-Type: application/json' \
  --data "{\"refreshToken\":\"$REFRESH\"}" | jq -r .data.accessToken)
curl -s -X POST $BASE/tasks/$TASK2/artifacts -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
  --data '{"commitSha":"a1b2c3d","changedPaths":["src/quota.ts"]}'     # 201
```

→ `ARTIFACT_SUBMITTED`

**재발급 후에도 stale이면 멈춰야 한다.** 브릿지는 두 번째 재발급을 하지 않고 사용자에게 알린다 —
무한 재시도가 이 흐름에서 가장 흔한 사고다. 서버 쪽은 그저 401을 계속 돌려준다.

### B-11. 프로젝트 정지 → 전부 거부

```bash
npm run db:psql -- "UPDATE projects SET status='halted', halt_reason='manual' WHERE id='$PROJECT_ID'"
curl -s -X POST $BASE/tasks/$TASK_ID/claim -H "Authorization: Bearer $AT"    # 403 PROJECT_HALTED
```

**토큰이 살아 있어도 막힌다** — 멈춤은 명령이 아니라 상태다. 정지 사유 없이 `halted`로 바꾸려 하면
DB가 거부한다(`projects_halt_chk`). 되돌리려면 `status='active', halt_reason=NULL`.
→ `TOOL_DENIED` (`stage=halted`)

---

### B-12. 실제 커밋으로 V3 밟기 — 신고 누락은 FAIL

V3는 **신고한 `changedPaths`가 아니라 커밋의 실제 diff**를 읽는다. 그 차이를 직접 만들어 본다.

전제: `~/.nomos/repos.json`에 데모 레포가 적혀 있고 `npm run seed`가 그 경로를 `repos.clone_url`에 넣었다.
비어 있으면 V3는 FAIL이 아니라 **SKIPPED**(`repos.clone_url 미설정`)로 남는다 — 확인해 볼 것.

```bash
npm run db:psql -- "SELECT full_name, clone_url FROM repos"
```

데모 레포에서 파일 두 개를 바꾸고 커밋한다.

```bash
cd ~/nomos-demo/study-api
git checkout -B verify-demo main
printf '\n// V3 데모\n' >> src/index.ts
printf '\n데모\n' >> README.md
git add -A && git commit -m "두 파일 변경"
git rev-parse HEAD          # ← SHA를 복사
```

하나만 신고하고 제출한다(서버로 돌아와서).

```bash
curl -s -X POST $BASE/tasks/$TASK_ID/claim -H "Authorization: Bearer $AT"
curl -s -X POST $BASE/tasks/$TASK_ID/artifacts -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
  --data '{"commitSha":"<위 SHA>","changedPaths":["src/index.ts"]}'
```

기대하는 답 — `V3: FAIL`, `outcome: RETRY`, `taskState: READY`, `retryCount: 1`.
사유는 `verifications.detail`에 그대로 남는다.

```bash
npm run db:psql -- "SELECT stage, result, detail FROM verifications ORDER BY stage"
#   V3 | FAIL | {"reason":"changed_paths가 커밋의 실제 diff와 다르다","undeclared":["README.md"], ...}
```

이번엔 둘 다 신고해 다시 제출하면 `V3: PASS`, `outcome: PENDING`(V2·V4를 기다린다), `attempt: 2`다.
위 검증 절의 curl로 V2·V4를 보고하면 `DONE`이 된다.

**세 번 연속 FAIL이면 `ESCALATED`**로 멈춘다 — 사람이 봐야 한다는 뜻이고 자동 재시도는 없다.

```bash
npm run db:psql -- "SELECT title, state, retry_count FROM tasks ORDER BY created_at"
```

데모 레포의 `package.json`이 없으므로 V2·V4는 Executor가 돌려도 사유와 함께 SKIPPED로 남는다
(`작업공간에 vitest가 설치돼 있지 않다` · `package.json에 lint 스크립트가 없다`). 이것이 정상 동작이다 —
못 돌린 것을 PASS로 적지 않는다.

## 5. MCP로 밟기

이 문서는 HTTP를 직접 부른다. **에이전트가 MCP 도구로 같은 일을 하는 경로**는
`docs/harness-claude-code.md`의 "로컬에서 MCP 경로 끝까지 밟기"에 있다.
`npm run seed`가 만드는 `.nomos-mcp.json`을 그대로 쓰면 된다(`npm run build`를 먼저).

---

## 6. 이벤트 확인

```bash
npm run db:psql -- "SELECT id, type, coalesce(payload->>'stage','-') AS stage, on_behalf_of, coalesce(path_violation::text,'-') AS pv FROM events ORDER BY id DESC LIMIT 10"
```

보는 법:

- **`on_behalf_of`는 절대 비어 있지 않다.** 모든 행동은 사람에게 귀속된다. 시스템이 주체면 `system:...` 형태다.
- 거부는 전부 `TOOL_DENIED`이고 `stage`로 어느 단계에서 막혔는지 구분한다:
  `halted` · `policy_stale` · `membership` · `unknown_action` · `forbidden_action` · `ownership` · `forbidden_path`
- `VERIFICATION_COMPLETED`는 단계별 결과를 그대로 담는다. `payload->>'outcome'`이 결론이고
  `payload->'stages'`에 `SKIPPED`가 몇 개인지가 M5를 읽을 때의 분모 단서다.
- `path_violation=true`는 **소유권 위반에만** 세운다. 비밀 파일 차단은 `false`다.
- 읽기(`GET .../notes`)와 형식 위반(422)은 이벤트를 남기지 않는다.

비밀값이 새지 않았는지 확인:

```bash
npm run db:psql -- "SELECT count(*) FROM events WHERE payload::text ~* '(connectKey|refreshToken|password|accessToken)'"
```

**0이어야 한다.** events는 지워지지 않으므로 비밀값이 한 번 들어가면 되돌릴 수 없다.
