# 질문 라우팅 실험 계획

> 상태: 계획(2026-10-29) · 맥락 저장·내보내기·데이터셋 v2 추가(2026-11-02). 나머지는 아래 "만들 것".
> 관련 문서: [`plan-router-api.md`](plan-router-api.md)(라우팅을 서버 API로 분리 — 이 실험의 전제).

## 1. 무엇을 비교하나

에이전트가 AskUserQuestion으로 물은 질문을 **누구에게 보낼지(FE · BE · PM · 자기 소관 SELF)** 정하는 라우터 두 개를 같은 질문으로 비교한다.

| 조건 | 라우터 |
|---|---|
| NOMOS + LLM | `llm` — Claude가 판정(`question/llm-router.ts`, 프롬프트 `router.ts` v2) |
| NOMOS + Decision AI | `decision` — 외부 결정 모델을 HTTP로 호출(`question/http-router.ts`, `DECISION_ROUTER_URL`) |
| 기준선 A | `baseline:asker` — 질문한 사람이 스스로 정함(SELF). 지금 보고서에 이미 있다 |

**지표**

| 지표 | 정의 | 비고 |
|---|---|---|
| 라우팅 정확도 | 판정이 정답(`accept`)에 들어간 비율 | 전체 + **정답 담당자별(FE·BE·PM·SELF)** + **혼동표**(정답 × 판정) + **출처별**(아래 2절) |
| 비용 | 질문 하나 판정의 USD | LLM은 토큰 × 가격표(`pm/pricing.ts`). Decision AI는 응답의 `costUsd` — 없으면 "비용 없음"으로 나온다 |
| 지연 | 요청 시작 ~ 응답 끝(ms) | **LLM은 API 모드로 잰다**(아래 9절). 중계 모드는 노트북 대기·CLI 기동이 섞인다 |
| 실패율 | 라우터가 실패해 대표에게 넘어간 비율(`fallback:representative`) | |

## 2. 질문 데이터셋

### 지금 있는 것
`scripts/data/question-routing.json` — **20문항**(BE 7 · SELF 6 · FE 4 · 정답 둘 3). 초기 실험에서 만든 것이고 **PM 정답이 없다**(PM 대상은 025에서 생겼다).
`scripts/data/`는 커밋하지 않는다(실험 데이터).

### 목표
**100~150문항**, 정답 담당자마다 25~35문항. 난이도를 섞는다.
- 명확: "목록 API 페이지 크기는?" → BE
- 애매: "에러 메시지는 서버가 줄까 화면이 정할까?" → 정답 둘
- 함정: BE에게 물을 것처럼 보이지만 정책 → PM

### 출처 — 실제 질문(a)을 최대로
사람이 쓰거나 LLM이 만든 질문은 "에이전트가 실제로 막혀서 하는 질문"과 분포가 다르다. **실제 질문을 주력으로**, 나머지는 빈 칸을 채우는 데만 쓴다.

| 출처 | 방법 | 비용 | 비고 |
|---|---|---|---|
| **a-1 개발 기록 캐기** | 팀원 노트북의 Claude Code 세션 기록(`~/.claude/projects/**/*.jsonl`)에서 AskUserQuestion 호출을 뽑는다(질문·선택지·직전 맥락) | 0 | 원래 본인에게 한 질문이라 "누가 정할 일인가"를 다시 라벨링. 개인 기록이므로 **본인이 돌리고 검토(비밀값·개인 내용 제거) 뒤 넘긴다** |
| **a-2 반복 실행** | 실제 레포에서 같은 기능을 FE·BE 태스크로 여러 번 돌려 에이전트가 실제로 막혀 묻게 한다. **계약을 건너뛰거나 명세에 빈칸을 심지 않는다**(대표 결정 2026-11-02) — 방식·스크립트는 다음 PR에서 정한다 | 태스크 실행마다 각자 구독 | 질문에 답하고 계속 진행시키면 후속 질문이 나온다. 중복은 나중에 제거. 다음 PR에서 기획 단계 질문(기능 명세·계약 초안)도 같은 라우터로 보낸다(stage) |
| **a-3 운영 질문 내보내기** | a-2로 운영 DB(`agent_questions`)에 쌓인 질문을 맥락(태스크·명세·묻는 역할·레포)과 함께 데이터셋 형식으로 뽑는다. 정답은 화면에서 붙인 라벨(`gold`) | 0 | 같은 실제 질문으로 라우터를 몇 번이든 다시 비교할 수 있다 |
| b 팀원이 직접 작성 | 실제 앱 명세를 보고 "개발하다 막힐 만한 것" | 0 | 보조 |
| c LLM 초안 | 명세·분류표로 후보를 만들고 사람이 거른다 | 소액 | 보조. **Claude가 만든 질문은 Claude 라우터가 잘 맞혀 점수가 부풀 수 있다** — 출처별로 따로 보고 |

### 라벨링
- 두 사람이 **각자 따로** 정답 담당자를 붙인다. 일치한 것만 확정하고, 갈린 것은 정답 둘(`accept` 두 개)로 둔다.
- **두 사람의 일치율 자체가 발표 숫자다**("사람도 X%만 일치하는 과제").
- 항목에 `source`(real-transcript · real-run · human · llm)와 `difficulty`(clear · ambiguous · trap)를 단다.

## 3. 실험 방법

앞단(기능 명세 → API 계약 → 태스크 나누기)은 실험에서 뺀다. 질문을 많이 만드는 데는 비효율이고 측정 대상이 아니다.

### 방법 1 — 오프라인 라우터 평가 (있음, 보강 필요)
데이터셋을 라우터에 바로 넣어 정확도·지연·비용을 잰다. 에이전트·프로젝트 불필요, 수백 문항도 몇 분.
```bash
npx tsx scripts/eval-question-router.ts api:claude-sonnet-5-5 --data team.json     # LLM (API — 보강 후)
npx tsx scripts/eval-question-router.ts https://<decision-ai>/route --data team.json # Decision AI
npx tsx scripts/eval-question-router.ts --check --data team.json                     # 형식 검사만
```
같은 입력으로 비교하므로 **두 라우터 비교가 가장 공정하다.** 결과는 `scripts/data/router-runs/`(커밋하지 않음).

### 방법 2 — 운영 서버에 질문 주입 (새로 만듦)
스크립트가 실험용 봇 계정(FE봇·BE봇)의 에이전트로 데이터셋 질문을 **실제 서버 API**(`POST /tasks/:id/questions`)에 올린다. Claude는 돌리지 않는다.
- 확인되는 것: 실제 라우팅(그림자 라우터 포함) → 담당자 화면·알림 → 상담 초안 → 답 → `GET /projects/:id/routing-report`.
- 데이터셋 정답으로 **정답 라벨(`POST /questions/:id/gold`)을 자동으로 붙인다.**
- 질문은 "그 태스크를 잡은 에이전트"만 올릴 수 있으므로 스크립트가 준비한다: 봇 계정 가입 → 대표가 초대·역할 배정 → 연결 키로 에이전트 연결 → 질문마다 태스크 생성·수령. 실제 팀원의 노트북·자격 증명은 건드리지 않는다.
- 레포는 진행 중 프로젝트 하나에만 쓸 수 있다 — 실험용 프로젝트·레포를 따로 둔다.

### 방법 3 — 실제 에이전트가 자연스럽게 묻게 하기
a-2와 같다. 발표 시연("에이전트가 실제로 막히면 묻는다")용으로 10개 안팎. 지금의 `npm run probe:questions`는 명세에 "누가 정한다" 힌트가 있어 **라우팅이 너무 쉬우므로 성능 비교에는 쓰지 않는다**(파이프라인 동작 확인용).

### 권하는 조합
| 목적 | 방법 |
|---|---|
| 라우터 성능 비교(발표 숫자) | 1 + 2 — 1로 대량 비교, 2로 같은 질문을 실제 서버 경로로 |
| 질문이 담당자 화면에 뜨고 답이 돌아오는가 | 2 |
| 에이전트가 실제로 묻는다 | 3 소수 |

## 4. 맥락 저장과 재사용

**프로젝트(에이전트 실행)는 질문을 모을 때 한 번만 돌리고, 라우터 비교는 저장된 입력으로 몇 번이든 한다.**

- 라우터가 보는 맥락은 `RoutingInput`(`src/domain/question/router.ts`) 하나다 — 단계·묻는 쪽·프로젝트 역할·태스크(제목·종류)·명세(키·제목·본문)·레포·질문·확정한 계약 요약.
  서버 전용 `context`(orgId)를 뺀 모양이 **`RoutingInputSnapshot`**이고, 서버 저장·내보내기·오프라인 평가가 이 타입 하나를 쓴다.
- **단계(`stage`)** — 같은 라우터로 기획 단계 질문도 보내려고 맥락을 단계에 맞게 넓혔다(프롬프트 v3).

  | stage | 묻는 쪽 | task | spec | contract | SELF |
  |---|---|---|---|---|---|
  | `implementation` | FE·BE 개발 에이전트 | 태스크 | 확정한 기능 명세 | 확정한 계약 요약 | 묻는 역할 자기 소관 |
  | `feature_spec` | PM 에이전트(기능 명세 초안) | null | 쓰고 있는 초안 | null | **없다** — PM 소관이면 대상 PM(대표가 확정). SELF로 답해도 PM으로 본다 |
  | `contract` | BE 에이전트(API 계약 초안) | null | 확정한 기능 명세 | null(쓰는 중) | BE 자기 소관 |

  세 단계 모두 실제로 생긴다(기획 단계는 033 — 5절). 단계별 프롬프트 분기는 단위 테스트(`tests/question-router.test.ts`)로 고정했다.
- **저장**(마이그레이션 032): 질문을 올리는 순간(질문 INSERT와 같은 트랜잭션) 라우터에 넣은 입력을 `agent_questions.routing_input`에 그대로 남긴다.
  명세·계약은 나중에 바뀌므로 다시 조립하면 그때의 맥락이 아니다 — 그래서 조립하지 않고 저장한다. 032 이전 질문은 입력이 없어 빠진다.
- **내보내기**: `GET /api/projects/:id/routing-dataset`(대표, `?labeledOnly=true`면 정답 라벨이 붙은 것만) — 데이터셋 v2 항목
  `{ id, stage, input, accept(gold 라벨, 없으면 []), source: 'real-run', askedAt, primary: { router, target }, goldLabeled, answerSource }`.
  `answerSource`가 `auto_first_option`이면 실험 모드 자동 답이다 — 답은 정답이 아니다(정답은 `accept`, 사람이 붙인다). `?stage=`로 단계를 거른다.
  응답을 파일로 저장해 그대로 넣는다:
  ```bash
  curl -H "Authorization: Bearer $TOKEN" "$SERVER/api/projects/$ID/routing-dataset?labeledOnly=true" > scripts/data/run-1.json
  npx tsx scripts/eval-question-router.ts claude:sonnet --data scripts/data/run-1.json --repeat 2
  npx tsx scripts/eval-question-router.ts https://<decision-ai>/route --data scripts/data/run-1.json
  ```
- **오프라인 데이터셋 v2**는 항목마다 같은 `input`을 담는다(형식은 `scripts/data/README-question-routing.md`). 평가는 `input`을 **그대로** 라우터에 넣는다 —
  운영과 다른 입력으로 비교하지 않게. 옛 형식(v1, contexts 참조 — 초기 20문항)도 읽고, 읽을 때 v2 입력으로 바꾼다(roles는 FE·BE, contract는 null).
  보고서에 출처별(`bySource`)·단계별(`byStage`) 정확도가 나온다(stage가 없는 항목·옛 형식은 `implementation`). `--check`는 두 형식 모두 검사한다.
- 운영 보고서(`GET /projects/:id/routing-report`)에도 단계별 일치율(`byStage`)이 나온다.

## 5. 기획 단계 질문

구현 단계(에이전트가 코드를 쓰다 묻는다)만 있던 질문을 **기능 명세 초안**(PM)과 **API 계약 초안**(BE 에이전트)으로 넓혔다(마이그레이션 033).
통합 테스트에서 PM이 대표도 정하지 않은 정책을, BE 에이전트가 FE가 정할 화면 요구를 임의로 정했다 — 기획 단계에서 정한 것이 그대로 계약·태스크가 된다.

- **형식**: 초안에 `questions: [{ question, header?, options(2개 이상, 추천안 맨 앞), multiSelect? }]`(기능 명세는 `featureKey`로 어느 기능인지).
  지침: "혼자 정하지 말고, 추측한 것은 가정이 아니라 질문으로". 형식 판정은 코드다(같은 질문·같은 선택지·없는 기능 → 교정 1회).
- **저장·라우팅**: 질문 하나 = `agent_questions` 한 행(`stage`, `plan_id` 또는 `contract_id`, `task_id` 없음). 초안을 저장하는 트랜잭션에서 만들고 구현 단계와 같은 라우터로 보낸다
  (라우팅은 트랜잭션 밖에서 먼저 — LLM 라우터가 수 초 걸린다). 기능 명세 질문은 PM이 묻는 쪽이라 SELF가 없다. 라우터가 실패하면 대표에게 — 구현 단계와 같다.
- **답 → 다시 쓰기**: 그 초안의 질문이 전부 답해지면 답을 붙여 **새 단발 호출**로 다시 쓴다(기능 명세 = 같은 체인의 새 계획 `revisionCause: answers`,
  계약 = 다음 회차가 저절로 열림). 다시 쓴 초안이 또 질문하면 반복된다. 답 회차는 대표·BE 담당의 수정 요청 한도(`PM_MAX_REVISIONS`·`CONTRACT_MAX_REVISIONS`)와 따로 센다.
- **확정 막기**: 답 대기 질문이 남은 초안은 적용·확정이 409 `QUESTIONS_PENDING`. `{ acceptAssumptions: true }`면 남은 질문을 만료로 닫고(`QUESTION_EXPIRED.reason = confirmed_with_assumptions`) 확정한다.
- **상한(일반 모드)**: 초안당 `PLANNING_QUESTIONS_MAX`(5)개, 답에 따른 재작성 `PLANNING_QUESTION_ROUNDS`(2)회. 넘는 질문은 첫 선택지를 가정으로 옮긴다(`가정: 질문 → 추천안`).
- **결정 전달**: 답은 인계 노트와 같은 "같은 명세" 기준으로 태스크에 간다 — 기능 명세 질문은 그 기능 키의 명세가 생긴 뒤 그 명세의 태스크, 계약 질문은 그 계약의 명세의 태스크, PM 대상은 전부.
- 계약의 옛 문자열 `openQuestions`(CLI 0.1.17 이하)는 기록만 하고 라우팅하지 않는다.

## 6. 실험 모드(자동 답 — 첫 번째 선택지, 발표 때 밝힌다)

질문 발생률·라우팅을 재려면 질문이 많이 나와야 하고, 사람이 매번 답하면 반복 실행이 멈춘다. 그래서 프로젝트 단위 스위치를 둔다.

- `projects.question_mode = experiment` — `PATCH /projects/:id/settings { questionMode }`, **시작(G1) 전에만**, 질문 중계가 켜져 있어야 한다(아니면 422 `QUESTION_MODE_INVALID`).
- **상한 없음**(초안당 질문 수·답 회차). 비용 상한은 PM 예산이다.
- **자동 답 = 첫 번째 선택지(`options[0].label`)**: 실제 라우팅(primary)을 기록하고 그림자 라우터까지 시도한 **뒤에** 답한다 — 라우팅 지표는 일반 모드와 같은 조건이다.
  명의 `system:experiment`, `answer_source = auto_first_option`, `answered_by` 없음. PM 대상도 대표 확정 없이 바로 답한다.
- **상담 실행·PM 답 초안을 돌리지 않는다**(구독·API 비용이 질문 수만큼 든다).
- 사람 지표에서 뺀다: 알림·처리할 일에 나오지 않고, 결정으로 다른 태스크에 전달하지 않으며, 보고서의 "답까지 걸린 시간"에서 뺀다. 정답 라벨(gold)은 여전히 사람이 붙인다.
- **발표 때 밝힐 것**: 실험 모드의 답은 추천안(첫 선택지)이지 사람의 판단이 아니다. 그래서 이 모드로 잰 것은 **질문이 얼마나 나오고 누구에게 가는가**(발생률·라우팅)이지,
  답의 품질이나 답을 받은 뒤 결과물의 품질이 아니다. 추천안이 늘 맞는다는 가정 위에서 다음 단계가 진행된다.

## 7. 반복 실행으로 발생률 재기

같은 태스크 묶음을 N번 새로 넣어 에이전트가 같은 일을 N번 하게 하고, 그때 나온 질문을 센다(`scripts/question-harvest.ts`).
계약을 건너뛰거나 빈칸을 심지 않는다 — 기능 명세·계약을 정상 흐름으로 확정한 실험 모드 프로젝트에서 돈다.

```bash
# 1) 실험 모드 프로젝트: 시작 전에 questionMode=experiment → 기능 명세 확정 → 계약 확정 → 멤버 배정 → 시작, 각 노트북에서 connect
# 2) 확인만
npm run harvest:questions -- --project <id> --login <대표> --tasks scripts/examples/question-harvest.json --repeat 5 --dry-run
# 3) 실행 — 회차마다 "[harvest <run> r<n>]" 꼬리표를 붙여 새로 만들고, 끝나면(DONE·ESCALATED·BLOCKED) 멈춘 것은 취소하고 다음 회차
npm run harvest:questions -- --project <id> --login <대표> --tasks <파일> --repeat 5
#    끊기면 출력된 --run <이름>으로 다시 실행하면 이어 간다(만든 회차는 건너뜀)
# 4) 보고 — 단계별 질문 수, 회차·태스크별 발생률(질문한 태스크 비율·태스크당 질문), 라우터별 판정 분포
npm run harvest:questions -- --project <id> --login <대표> --report --run <이름>
```

- 대표 권한(HTTP)만 쓴다. 회차가 `--round-timeout`(90분) 안에 끝나지 않으면 남은 태스크를 알리고 멈춘다(자동 재시도 없음).
- 승인 대기(AWAITING_APPROVAL)에 멈춘 태스크는 취소할 수 없어 그대로 두고 알린다 — 질문은 이미 다 나왔다.
- 보고의 회차·태스크 매칭은 데이터셋 `input.task.title`(라우터가 본 태스크 제목)의 꼬리표로 한다. 기획 단계 질문은 회차가 없어 단계별 수에만 든다.

## 8. 만들 것 (순서대로)

1. **개발 기록 캐기 스크립트**(a-1) — 각자 노트북에서 실행, 후보를 데이터셋 형식으로.
2. ~~반복 실행 스크립트~~(a-2) — `npm run harvest:questions`(7절). 실험 모드(6절)에서 같은 태스크 묶음을 N회.
3. ~~운영 질문 내보내기~~(a-3) — `GET /projects/:id/routing-dataset`(4절).
4. **오프라인 평가 보강** — `api:<모델>` 라우터, 담당자별 정확도·혼동표·출처별 점수, 데이터셋 형식 확장(PM 정답, `source`·`difficulty`) — 기존 20문항 호환. ([`plan-router-api.md`](plan-router-api.md)의 구현 범위에 포함)
5. **방법 2 주입 스크립트** — 봇 계정 준비·질문 주입·정답 라벨·보고서 출력.
   ```bash
   npm run experiment:questions -- --project <id> --data team.json --login <대표>
   ```
6. **Decision AI 응답 규칙 합의**: `{ target, confidence?, reason?, costUsd? }` (`http-router.ts`가 이미 이 형식을 읽는다).

## 9. 공정성 조건

- **LLM은 API 모드로 잰다.** 지금 운영(중계)에서는 라우팅이 대표 노트북의 `pm-worker`로 가서(3초 폴링 + Claude CLI 기동) 지연이 부풀고 비용이 "API로 했다면"의 환산값이다.
  → [`plan-router-api.md`](plan-router-api.md)로 라우팅만 서버 API로 분리한 뒤 잰다.
- 두 라우터는 **같은 프롬프트·같은 입력**을 받는다(운영은 그림자 라우터, 오프라인은 같은 데이터셋).
- Decision AI가 `costUsd`를 주지 않으면 비용 계산 방식(호스팅 비용 ÷ 요청 수 등)을 먼저 정하고 보고서에 적는다.
- 오분류는 지금 되돌릴 길이 없다("다른 담당자에게 넘기기" 미구현) — 질문-답 왕복 시간 지표는 이번 범위에서 빼거나 오분류를 따로 센다.

## 10. 비용 어림 (코드의 가격표 기준 — 결제 전에 실제 가격 확인)

Sonnet 5.5: 입력 $2 · 출력 $10 / 100만 토큰(`pm/pricing.ts`).
- 질문 1개 판정: 입력 2~3천 + 출력 ~200 토큰 → 약 $0.01 미만
- 오프라인 150문항 × 몇 회 + 운영 주입 수백 문항(그림자 포함 2배): 합쳐 수 달러 → **$10~20 충전이면 충분**
- a-2(실제 실행)는 API가 아니라 각자 구독 사용량이 든다.

## 11. 미정 사항

- Decision AI 담당자와 비용 산정 방식
- Anthropic API 키(결제 전 — [`plan-router-api.md`](plan-router-api.md) 3절)
- a-2에 쓸 실제 레포와 기능 목록
- 라벨링할 두 사람
