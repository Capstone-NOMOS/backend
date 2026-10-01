# 하네스: Claude Code

`HarnessAdapter`(`src/harness/harness-adapter.ts`)의 Claude Code 구현을 만들 때 알아야 할 것.
스파이크(`spike/`, 로컬 전용 — 저장소에 올리지 않는다)에서 실측한 내용이다. 스파이크 코드를 지워도 이 문서는 남긴다.

측정 환경: Windows 11 / Node v24.15.0 / Claude Code 2.1.263 / `@modelcontextprotocol/sdk` 1.30

---

## 실행

```bash
claude -p "<프롬프트>" \
  --output-format stream-json --verbose \
  --mcp-config <설정 파일> --strict-mcp-config \
  --allowedTools "mcp__<서버명>__<도구명>" ...
```

- `--verbose` — `--output-format stream-json`과 함께 쓸 때 필요하다.
- `--strict-mcp-config` — 넘긴 설정의 MCP 서버만 쓴다. 없으면 사용자의 개인 MCP 설정이 함께 로드되어
  실험 조건이 오염된다.
- `--allowedTools` — MCP 도구 이름은 **`mcp__<서버명>__<도구명>`**. 헤드리스에서는 권한 프롬프트를 띄울 수
  없으므로 여기 없으면 호출이 막힌다.

### ⚠️ Windows: `spawn('claude', args, { shell: true })` 금지

Windows의 `claude`는 `.cmd` 셰이퍼라 `shell` 없이는 실행되지 않는다. 그런데 `shell: true`는
**인자를 이스케이프 없이 이어붙이기만 한다.** 프롬프트의 따옴표·대괄호가 셸에 먹혀 모델이 엉뚱한 문자열을
받았고, 도구를 한 번도 호출하지 않은 채 끝났다(`num_turns: 1`). 겉보기엔 "MCP가 안 된다"로 보여서 원인을
찾기 어렵다.

→ CLI 진입점을 node로 직접 실행한다.

```ts
spawn(process.execPath, [`${process.env.APPDATA}\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs`, ...args], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

### ⚠️ stdin은 즉시 닫는다

`spawn` 기본값은 stdin을 파이프로 연다. claude가 파이프 입력을 기다리며
`Warning: no stdin data received in 3s`를 찍고 **태스크마다 3초를 버린다.** `stdio: ['ignore', 'pipe', 'pipe']`.

---

## 스트림 (NDJSON)

stdout은 한 줄에 JSON 하나. 청크 경계에서 줄이 잘리므로 **개행 기준 버퍼링이 필수**다.

### 최상위 블록 타입 5종

| type | subtype | 내용 |
|---|---|---|
| `system` | `init` | 세션 시작. `mcp_servers`(연결 상태), `tools`(사용 가능한 도구명 전체), `session_id`, `model` |
| `assistant` | — | 모델 턴. `message.content[]`, `message.usage` |
| `user` | — | 도구 실행 결과가 돌아오는 턴. `message.content[]`에 `tool_result` |
| `result` | `success` | 마지막에 1회. 누적 비용·사용량·턴 수 |
| `rate_limit_event` | — | `rate_limit_info` |

### 콘텐츠 블록 타입 3종 (`message.content[]`)

`text`, `tool_use`, `tool_result`

### ⚠️ 순서에 의존하는 파싱 금지

**`rate_limit_event`는 위치를 가정할 수 없다.** 실측에서 맨 첫 줄로 나온 적도, 중간에 나온 적도 있다.
"첫 줄은 `system/init`"이라고 가정하면 깨진다. 파서는 `type`으로만 분기한다.

---

## 비용

**`result.total_cost_usd`를 쓴다.** 토큰 수로 직접 계산하지 않는다.

```json
{"type":"result","subtype":"success","total_cost_usd":0.1846875,"num_turns":4,"duration_ms":7316,
 "usage":{"input_tokens":8,"cache_creation_input_tokens":40213,"cache_read_input_tokens":119529,"output_tokens":325}}
```

### ⚠️ `input_tokens`만 보면 크게 틀린다 — 캐시가 지배한다

위 실측에서 `input_tokens`는 **8**, `cache_read_input_tokens`는 **119,529**였다.
비용 대부분이 캐시 토큰이다.

턴 단위가 필요하면 `assistant.message.usage`에 턴마다 실린다.
`result`에는 `modelUsage`, `permission_denials`, `ttft_ms`도 있다 — `permission_denials`는 정책 위반 계측 후보.

매핑: `events.token_cost` ← `result.total_cost_usd`, `events.latency_ms` ← `result.duration_ms`

**프롬프트 설계 시사점:** 캐시가 비용을 지배하므로 안정적인 내용(헌법·계약서·명세)을 앞에, 태스크별로 바뀌는
내용(수용기준·경로 제약)을 맨 뒤에 둔다. 가변 내용이 앞에 오면 캐시가 매번 깨진다.

---

## MCP 도구 호출

헤드리스 Claude Code는 `--mcp-config`로 넘긴 MCP 서버의 도구를 **실제로 호출한다.** 확인 완료.
(`system/init`의 `mcp_servers`에 `connected`, 서버 프로세스 쪽 호출 로그, `tool_result`로 핸들러 반환값 확인)

### ⚠️ ToolSearch 1턴 고정 오버헤드

모델이 우리 도구를 바로 부르지 않고 **먼저 `ToolSearch`를 한 번** 호출해 스키마를 가져온다.

```
tool_use ToolSearch {"query":"select:mcp__nomos__claim_task,mcp__nomos__submit_artifact"}
tool_use mcp__nomos__claim_task {...}
```

MCP 도구가 지연 로드 대상이기 때문으로 보인다. **태스크마다 턴 1개와 그만큼의 비용이 고정으로 붙는다.**
태스크당 턴 수·비용을 계측할 때 이 몫을 감안한다.

### MCP 서버 구현 시

- **stdout에 로그를 쓰면 안 된다.** stdout은 JSON-RPC 전용이라 한 줄만 섞여도 클라이언트 파싱이 깨진다.
  로그는 stderr로.
- 한글 경로 주의: `new URL(..., import.meta.url).pathname`은 퍼센트 인코딩된 경로를 돌려준다.
  `fileURLToPath()`를 쓸 것.

---

## 브릿지 ↔ 서버 WebSocket

### ⚠️ `ws`는 `'error'` 핸들러가 없으면 프로세스가 죽는다

연결 실패가 uncaught exception이 된다. `'close'`만 처리하면 안 된다. 재연결은 `'close'`에서 한다.

### 재연결 시 중복 전달

재접속하면 서버가 같은 태스크를 다시 보낼 수 있다. `events.id`가 bigserial이므로
"마지막으로 받은 id 다음부터" 요청하는 방식으로 막는다.

---

## 확인하지 않은 것

- 여러 태스크 동시 실행
- 자식 프로세스 중단(abort)
- `result.subtype`이 `success`가 아닌 경우(에러·중단)
- 대용량 출력의 백프레셔

## 서버 401 `policy_stale` 처리

경로 규칙·정책이 바뀌면 서버가 발급해 둔 에이전트 토큰은 옛 정책 기준이 된다. 서버는 그 요청을
401 `POLICY_STALE`(`{ reason: 'policy_stale' }`)로 거부한다. 브릿지의 대응은 하나뿐이다:

```
401 policy_stale
  → refresh token으로 access token 재발급
  → 원 요청 1회 재시도
  → 재시도도 policy_stale이면 즉시 중단하고 사용자에게 알린다
```

**재발급 후에도 stale이면 루프다.** 서버가 `projects.policy_hash` 갱신을 빠뜨렸거나 정책이 매우 빠르게
바뀌고 있다는 뜻이며, 계속 재시도하면 폴링 폭풍이 된다. 무한 재시도가 이 흐름에서 가장 흔한 사고다.

정상 운영에서는 거의 일어나지 않는다. G1 승인 이후(`projects.started_at IS NOT NULL`)에는 정책 변경이
금지되므로 `policy_hash`는 사실상 불변이고, stale은 온보딩·G1 전 단계에서만 발생한다.

## MCP를 Claude Code에 등록하는 방법 3가지

**브릿지가 쓰는 것은 (3)번이다.**

1. **프로젝트 설정** — 저장소 루트의 `.mcp.json`. 팀과 공유되지만 **처음 한 번 사용자 승인이 필요하다**
   (승인 전에는 `claude mcp get <이름>`에 `⏸ Pending approval`). 무인 실행에는 맞지 않는다.
2. **CLI 등록** — `claude mcp add [--scope local|project|user] <이름> -- <명령>`. `--` 뒤가 실행할 명령이고,
   빼면 플래그가 claude 자신의 것으로 해석된다. 사용자 설정에 흔적이 남는다.
3. **헤드리스 실행** — `claude -p ... --mcp-config <파일> --strict-mcp-config --allowedTools "mcp__<서버>__<도구>" ...`.
   승인 절차가 없고 사용자 설정에 아무것도 남기지 않는다. `--allowedTools`를 안 주면 헤드리스에서 권한 프롬프트를
   띄울 수 없어 호출이 막히고, `--output-format stream-json`에는 `--verbose`가 필요하다.

## MCP 격리 — 두 플래그는 함께 간다

브릿지가 Claude Code를 띄울 때 우리 MCP 서버만 보이게 만든다.

```
--mcp-config <경로>      우리 서버 하나만 담은 설정
--strict-mcp-config      그 외 모든 MCP 설정을 무시
```

`--strict-mcp-config`를 빠뜨리면 사용자의 `~/.claude.json`에 등록된 MCP 서버가 함께 로드된다.
GitHub MCP가 살아 있으면 에이전트가 `submit_artifact`를 건너뛰고 직접 push할 수 있고, 그러면
**제출 시점 경로 검증(V3)이 아무것도 막지 못한다.** 방어선이 조용히 사라지는 종류의 실수라
`src/bridge/claude-args.ts`의 순수 함수로 뽑고 `tests/bridge-args.test.ts`로 고정했다.

설정에 담기는 것은 우리 서버 하나뿐이고, 토큰은 `env`로 넘긴다:

```json
{
  "mcpServers": {
    "nomos": {
      "command": "<node 실행 파일>",
      "args": ["<dist/bridge/mcp-server.js>"],
      "env": {
        "NOMOS_BASE_URL": "...",
        "NOMOS_ACCESS_TOKEN": "...",
        "NOMOS_REFRESH_TOKEN": "..."
      }
    }
  }
}
```

`spike/mcp-server.ts`는 호출 여부만 확인하던 버린 코드다. 실제 구현은 `src/bridge/mcp-server.ts`.

## 로컬에서 MCP 경로 끝까지 밟기

에이전트가 우리 도구로만 일하는 경로를 손으로 확인하는 절차. **아래 상태 표시는 실측이다.**

### 준비

```bash
npm run build     # MCP 설정이 dist/bridge/mcp-server.js를 가리킨다. 먼저 빌드해야 한다
npm run seed      # 계정·프로젝트·READY 태스크 + .nomos-mcp.json 생성
npm run dev       # 포트 3000
```

`npm run seed`가 **`.nomos-mcp.json`을 함께 만든다.** be-laptop의 access·refresh 토큰이 들어 있고
`.gitignore`에 있다. 토큰을 손으로 옮겨 적지 않게 하려고 시드가 만든다 — 옮겨 적으면 틀린다.

### 1. 연결 확인 — 모델 호출 없이 (✅ 실측)

```bash
claude mcp add nomos-probe -s local \
  -e NOMOS_BASE_URL=http://localhost:3000 \
  -e NOMOS_ACCESS_TOKEN=<시드 출력> -e NOMOS_REFRESH_TOKEN=<시드 출력> \
  -- node "<절대경로>/dist/bridge/mcp-server.js"

claude mcp list      # nomos-probe: ... - ✔ Connected
claude mcp remove nomos-probe -s local
```

`claude mcp list`는 등록된 서버에 실제로 붙어 health check를 한다. **모델을 부르지 않으므로 비용이 없다.**
Claude Code가 우리 서버를 spawn하고 MCP 핸드셰이크까지 끝낸다는 것이 여기서 증명된다.

> `claude mcp list`에는 `--mcp-config`가 없다. 그건 전역 실행 옵션이라 `claude` 본 실행에만 붙는다.
> 그래서 health check만 하려면 위처럼 임시 등록 → 확인 → 제거가 필요하다.

### 2. 도구 목록과 호출 (✅ 실측, MCP 클라이언트로)

서버가 노출하는 도구는 **4개**다.

| 도구 | 인자 |
|---|---|
| `claim_task` | `task_id` |
| `submit_artifact` | `task_id`, `commit_sha`, `changed_paths[]` |
| `publish_note` | `task_id`, `kind`, `headline`, `key_points[]`, `affects[]?`, `supersedes?` |
| `read_notes` | `project_id`, `spec_id?`, `since_seq?`, `limit?` |

MCP SDK 클라이언트로 직접 붙여 네 개 모두 호출했고, 정상 경로와 거부 경로가 모두 기대대로 나왔다:

```
claim_task        isError=false  → state=CLAIMED
submit_artifact   isError=false  → triggeredActions=[artifact:submit, code:own_path, …], gateMode=AUTO
publish_note      isError=false  → title="#1 - 백엔드 F-03 구현 완료 — …"
read_notes        isError=false  → 목록
submit_artifact   isError=true   → "**/.env* is denied"     ← 금지 경로
```

**거부는 예외가 아니라 `isError: true`인 도구 결과로 돌아간다.** 모델이 이유를 읽고 다음 행동을 고를 수 있어야
하기 때문이다. 다만 `policy_stale` 루프만은 "재시도하지 말고 사람에게 알리라"는 문구로 돌려준다.

### 3. Claude Code로 실행 (✅ 실측, 구독으로 실행)

```bash
claude --mcp-config .nomos-mcp.json --strict-mcp-config   --allowedTools "mcp__nomos__claim_task,mcp__nomos__submit_artifact,mcp__nomos__publish_note,mcp__nomos__read_notes"   -p "태스크 <task_id> (T-001 …)을 claim_task로 받아라. …"
```

**세 도구가 모두 실제로 호출됐다.** 모델이 `claim_task` → `submit_artifact` → `publish_note` 순서로 부르고
서버에는 `TASK_CLAIMED` · `ARTIFACT_SUBMITTED`(gateMode=AUTO) · `NOTE_PUBLISHED`가 남았다.
태스크는 `VERIFYING`으로 넘어갔고 `artifacts` 행에 `triggered_actions`가 고정됐다.

돌려보고 알게 된 두 가지 — 둘 다 빠뜨리면 **도구를 못 찾는 것과 증상이 비슷해 원인 찾기가 어렵다.**

**① `--allowedTools`가 없으면 "승인 대기"에서 멈춘다.**
플래그 없이 돌렸더니 모델이 도구를 고르기는 했는데 이렇게 답하고 끝났다:

> "T-001 클레임 요청이 권한 승인 대기 상태입니다. 승인해주시면 이어서 진행하겠습니다."

`-p`(헤드리스)에는 승인할 사람이 없다. 도구 이름은 `mcp__<서버명>__<도구명>` 형식이어야 한다.
`buildClaudeArgs`가 이제 이 플래그를 항상 붙이고, `tests/bridge-args.test.ts`가 설정의 서버 이름과
접두사가 갈라지지 않는지까지 검사한다.

**② 태스크 id를 프롬프트에 넣어야 한다.**
`"T-001 태스크를 받아서 처리해줘"`로 돌렸더니 모델이 `claim_task("T-001")`— **제목**으로 부르려 했다.
목록을 주는 도구가 없으므로 **id는 Executor가 프롬프트에 주입해야 한다.** 지금은 Executor가 없어 사람이 넣는다.

> 이 단계만 모델을 호출하므로 비용이 든다. 위 실측은 구독으로 돌렸다
> (`ANTHROPIC_API_KEY`가 환경변수에 있으면 Claude Code가 그걸 먼저 쓰므로 API 과금으로 빠진다 — 비우고 돌릴 것).

### 4. 서버 쪽에서 결과 확인

```bash
npm run db:psql -- "SELECT type, coalesce(payload->>'stage','-') AS stage FROM events ORDER BY id DESC LIMIT 8"
```

`TASK_CLAIMED` · `ARTIFACT_SUBMITTED` · `NOTE_PUBLISHED`가 남고, 금지 경로 제출은
`TOOL_DENIED`(`stage=forbidden_path`)로 남는다. **거부도 남아야 M5′의 분모가 성립한다.**

### spike/와의 관계

`spike/mcp-server.ts`는 "헤드리스 Claude Code가 MCP 도구를 진짜 호출하는가"만 확인하려고 만든 **버려진 코드**다.
호출 사실을 파일에 기록하고 성공을 반환할 뿐 서버를 부르지 않는다. 실제 구현은 `src/bridge/mcp-server.ts`이고,
그 안의 도구는 `src/bridge/nomos-client.ts`를 통해 HTTP로 NOMOS 서버를 부른다. 둘을 섞지 말 것.

### Executor — 브릿지 본체

팀원 노트북에서 도는 프로그램. npm 패키지 `@capstone-nomos/cli`(bin `nomos`)로 배포되고, 팀원은
`npx @capstone-nomos/cli@latest connect` 한 줄로 로그인 → 배정 대기 → 폴링까지 간다.
서버 주소는 `~/.nomos/credentials`의 `baseUrl`에서 온다. 이 레포에서 소스로 돌릴 때:

```bash
npm run executor -- connect --server http://localhost:3000   # --를 빼면 npm이 플래그를 가져간다
npm run executor once     # READY 태스크 하나만 처리하고 종료 (개발·데모용)
npm run executor start    # 10초 폴링
npm run executor clean    # worktree 정리
```

노트북에 두는 것:

| 파일 | 내용 |
|---|---|
| `~/.nomos/credentials` (0600) | `{ baseUrl, accessToken, refreshToken, agentId }` — `connect`·`login`이 쓴다(`npm run seed`도 만든다) |
| `~/.nomos/repos/<조직>/<레포>` | 태스크의 레포. 없으면 CLI가 브리핑의 `repo.cloneUrl`(NULL이면 `github.com/{fullName}`)에서 받고, 태스크마다 fetch해 `origin/<기본 브랜치>`에서 분기한다 |
| `~/.nomos/repos.json` (선택) | `{ "acme/study-api": "C:/path/to/repo" }` — 이미 받아 둔 레포를 쓰고 싶을 때만. 적혀 있으면 그 경로가 우선이고 fetch하지 않는다 |

한 태스크의 흐름:

1. `GET /projects/:id/tasks?state=READY` — 에이전트 토큰이라 서버가 **자기 역할로 강제 필터**한다
2. `GET /tasks/:id/briefing` — 명세·인계 노트·수정 가능 경로·`.claude/settings.json` 재료를 한 번에
3. `git worktree add`로 `~/.nomos/workspaces/{projectId}/{taskId}/`에 분기.
   **레포 자체와 분리되므로 사용자의 작업 트리를 건드리지 않는다.** 브랜치가 없으면 `task/{taskId}`로 만들고 서버에 알린다
4. `.claude/settings.json` 배치 — **이게 로컬 방어선이다.** 생성에 쓴 `policy_hash`를 `.claude/.nomos-policy.json`에 함께 남긴다
5. `buildClaudeArgs`로 Claude Code 실행 (타임아웃 30분)
6. 결과 처리 — 정상 종료 + 커밋 있음이면 그대로 두고, 나머지는 로그만 남긴다.
   **자동 재시도는 하지 않는다.** `tasks.retry_count`는 서버가 관리하는 값이고 Executor가 멋대로 돌리면 M4(재작업률)가 오염된다

worktree는 끝나도 **남긴다.** 실패 원인은 로그보다 남은 파일에서 드러나는 경우가 많다. 정리는 `executor clean`으로만.

수령 부분은 `TaskSource` 인터페이스로 분리돼 있다. 지금은 폴링이고, 이벤트 스트림이 생기면 구현체만 갈아끼운다.

### 실측으로 확인한 것 (모델 없이)

```bash
npm run verify:settings
```

worktree에 **실제로 깔린** `.claude/settings.json`을 서버 판정과 대조한다.
`path-golden.test.ts`가 생성기의 출력을 검사한다면, 이쪽은 디스크의 파일을 검사한다 — 다른 질문이다.

```
① 현재 규칙으로 재생성한 것과 동일한가: 예
② 골든 fixture 22개 중 불일치: 0
③ 경로 300개 — 파일이 더 느슨: 0 / 더 엄격: 0
결과: 통과
```

자격 증명 갱신도 확인했다. 경로 규칙을 바꿔 토큰을 stale로 만든 뒤:

```
1회차  재발급 1회 → 도구 성공. 파일의 토큰이 갱신됨
2회차  재발급 0회 — 401 없이 시작
```

> **이 과정에서 결함을 하나 찾았다.** 클라이언트가 `POLICY_STALE`에만 재발급을 걸어서,
> access token이 **만료**(1시간)되면 재발급 없이 그냥 실패했다. Executor가 한 시간 뒤부터 조용히 죽는다는 뜻이다.
> `UNAUTHENTICATED`도 재발급 대상에 넣고, 재발급 후에도 같은 이유로 막히면 멈추는 루프 방지는 그대로 뒀다.

### 아직 없는 것

| 빠진 것 | 결과 |
|---|---|
| **태스크 생성 API** | PM(⑧)이 맡을 일이라 `npm run seed`가 대신 만든다 |
| **G1 승인 경로** | `projects.started_at`을 채우는 API가 없어 프로젝트가 계속 `planning`이다 |
| **검증 V1~V4** | 제출은 받지만 커밋 존재·diff 대조를 하지 않는다. `commit_sha`는 형식만 본다 |
| **워크트리 정리 자동화** | `executor clean`이 전부 지운다. 태스크별 선택 삭제는 없다 |
