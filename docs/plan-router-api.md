# 질문 라우팅을 서버 API로 분리

> 상태: 결정됨, **미구현**(2026-10-29). Anthropic API 키 없음(결제 전).
> 관련 문서: [`experiment-question-routing.md`](experiment-question-routing.md)(이 변경이 실험의 전제).

## 1. 결정

질문 라우팅(실제 라우터 + 그림자 LLM 라우터)은 **서버가 Anthropic API로 직접** 부른다. PM의 다른 일(기능 명세 · 태스크 나누기 · PM 답 초안)은 지금처럼 **대표 구독(중계, `PM_PROVIDER=relay`)** 에 둔다.

| 일 | 누가 부르나 | 비용 |
|---|---|---|
| 질문 라우팅 (실제 + 그림자 LLM) | **서버 → Anthropic API** | NOMOS API 키(질문당 약 $0.01 미만) |
| Decision AI 라우팅 | 서버 → Decision AI API | Decision AI 응답의 `costUsd` |
| 기능 명세 · 태스크 나누기 · PM 답 초안 · 교정 | 대표 노트북 `pm-worker`(중계) | 대표 구독 |

## 2. 이유

- **서비스 구조와 같다.** 라우팅은 질문마다 즉시·짧게 서버가 부르는 일이다. Decision AI도 API로 부르므로 LLM도 API로 불러야 실제 도입 모습과 같다.
- **공정한 비교.** 지금은 라우팅이 PM 모델(`getPmModel`)을 따라가 중계 모드에서 대표 노트북으로 간다 — 지연에 작업 대기(3초 폴링)와 Claude CLI 기동이 섞이고, 비용은 구독 사용량을 API 가격으로 환산한 값이다.
- **노트북 의존 제거.** 지금은 대표 노트북이 꺼져 있으면 30초 뒤 대표에게 넘어간다(`fallback:representative`) — LLM 라우팅이 사실상 꺼진다.
- 기획(명세·태스크 나누기)은 길고 드문 일이라 대표 구독으로 두는 편이 싸다(API로 하면 계획 하나 약 $0.8).

## 3. 결제와 키

- **개발에는 키가 필요 없다** — 테스트는 가짜 모델로 돈다(CI도 같다). 클라우드 PR → 병합까지 키 없이 된다.
- 키 없이 배포하면 라우팅은 실패 → 대표에게 넘어간다(서비스는 깨지지 않지만 LLM 라우팅은 꺼진 상태). **배포와 키 등록은 같은 날.**
- 실험 직전에 소액 결제(**$10~20 충전이면 충분**, [`experiment-question-routing.md`](experiment-question-routing.md) 6절).
- 결제할 때:
  - **사용 한도**를 건다(예: 월 $20).
  - **키를 둘로 나눈다** — 운영 서버용(SSM에만), 오프라인 평가용(실행자 노트북 환경변수에만). 사용량이 따로 보이고 하나가 새도 다른 하나는 안전하다.
  - 키는 코드·`.env` 커밋·채팅·이벤트 어디에도 남기지 않는다.

## 4. 운영 설정 (배포 때)

| 설정 | 값 | 비고 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 운영 서버용 키 | SSM Parameter Store. **지금 운영에 있는지 확인 필요** |
| `PM_PROVIDER` | `relay` **유지** | 키가 생겨도 PM이 API로 바뀌지 않게 — 아래 구현의 분리가 필요하다 |
| `QUESTION_ROUTER_LLM_MODEL` | (선택) 기본 `claude-sonnet-5-5` | 라우팅 전용 모델 |

## 5. 구현 범위

- **설정**: `QUESTION_ROUTER_LLM_MODEL` 추가. 라우팅 LLM은 `PM_PROVIDER`와 무관하게 항상 API(`ANTHROPIC_API_KEY`).
  키가 없으면 LLM 라우터는 실패(지금의 대표 fallback) + 기동 시 경고 로그 한 번. **`ANTHROPIC_API_KEY`가 있다고 PM이 API 모드로 바뀌지 않게** — PM 모드는 `PM_PROVIDER`로만 정한다(테스트로 고정).
- **`question/llm-router.ts`**: `getPmModel()` 대신 라우팅 전용 API 모델. 중계 분기·pm-worker 오프라인 검사를 라우팅에서 뺀다. `pm/model.ts`의 Anthropic 호출을 재사용하되
  모델·`max_tokens`·effort는 라우팅용(짧은 출력). 프롬프트·해석은 `router.ts` v2 그대로. `routedBy = 'llm:api:<모델>:v2'`.
- **그림자 LLM 라우터**(`routing-eval.ts`)도 같은 모델.
- **비용**은 실제 usage × `pm/pricing.ts` — 이제 실제로 나간 돈. **프로젝트 PM 예산(`pm_budget_usd`)에서 깎지 않는다**(기획 예산과 별개). 기록은 지금처럼 `routing.costUsd`·`QUESTION_ASKED.payload.costUsd`·`question_routing_runs`.
- 중계의 `purpose: 'route'`는 서버가 더 보내지 않는다(옛 CLI 호환 코드는 두되 CLI 변경 없음).
- **오프라인 평가**: `api:<모델>` 라우터(서버와 같은 프롬프트·해석·가격표, 키는 실행자 환경변수 — `.env` 안 읽음), 보고서에 담당자별 정확도·혼동표·`source`별 정확도,
  데이터셋 형식 확장(PM 정답, `source`·`difficulty` — 기존 20문항 호환).
- **운영 보고서**(`GET /projects/:id/routing-report`)에도 라우터별 담당자별 정확도·혼동표(openapi 함께).
- **바꾸지 않는 것**: PM 기획·PM 답 초안의 경로(relay), 라우터 실패 시 대표에게 보내는 규칙.

## 6. 테스트 (실제 API를 부르지 않는다 — 라우팅 모델 테스트 훅으로 가짜를 끼운다)

- `PM_PROVIDER=relay` + 키 있음 → PM 기획은 relay, 라우팅은 API 모델, `routedBy`가 `llm:api:…`
- 키 없음 → 라우팅 실패 → `fallback:representative`, 경고 로그
- 그림자 LLM도 API 모델, `question_routing_runs`에 비용·지연
- `routing-report`의 담당자별 정확도·혼동표
- 오프라인 평가: api 라우터(가짜 fetch), 혼동표·출처별 집계, 옛 데이터셋 형식 호환

## 7. 진행 순서

1. 아래 지시문으로 클라우드 세션에서 구현 → `dev` PR → 검토·병합(키 불필요)
2. 결제 → 키 둘 발급 → 운영 키를 SSM에 등록
3. 운영 배포(`dev → main`) — 키 등록과 같은 날
4. 첫 질문에서 `routedBy`가 `llm:api:…`인지, 비용·지연이 기록되는지 확인

## 부록 — 클라우드 지시문

```text
bash scripts/cloud-setup.sh 실행 후 아래 작업을 해줘. PR 하나.

# 배경 (대표 결정)
질문 라우팅(LLM 라우터·그림자 LLM 라우터)이 지금은 PM 모델(getPmModel)을 써서, 운영의 중계 모드(PM_PROVIDER=relay)에서는
대표 노트북의 pm-worker(구독, headless Claude CLI)가 판정한다. 그래서 (1) 노트북이 꺼지면 라우팅이 대표 fallback이 되고,
(2) 지연에 작업 대기(3초 폴링)·CLI 기동이 섞여 Decision AI(HTTP API)와 공정하게 비교할 수 없고, (3) 비용이 환산값이다.
실제 서비스에서도 라우팅은 서버가 API로 직접 부르는 일이다. 그래서 라우팅만 서버가 Anthropic API로 직접 부르게 분리한다.
기능 명세·태스크 나누기·PM 답 초안(question_draft)·교정은 지금처럼 PM_PROVIDER(운영은 relay)를 그대로 쓴다.

# 설정 (src/config/env.ts)
- QUESTION_ROUTER_LLM_MODEL: 기본 'claude-sonnet-5-5'. 라우팅 전용 모델.
- 라우팅 LLM은 항상 API다 — ANTHROPIC_API_KEY를 쓴다. PM_PROVIDER와 무관하다.
- 키가 없으면 LLM 라우터는 실패(지금의 fallback:representative 경로 그대로)이고, 서버 기동 시 QUESTION_ROUTER=llm 또는 QUESTION_SHADOW_ROUTERS에 llm이 있는데
  키가 없으면 경고 로그를 한 번 남긴다(기동은 막지 않는다).
- ANTHROPIC_API_KEY가 있다고 PM이 API 모드로 바뀌지 않게 할 것 — PM 모드는 PM_PROVIDER로만 정한다(지금 키 유무로 정하는 곳이 있으면 고친다). 이 분리를 테스트로 고정.

# 코드
- question/llm-router.ts: getPmModel() 대신 라우팅 전용 API 모델(예: getRouterModel())을 쓴다. 중계(relay) 분기·pm-worker 오프라인 검사(RELAY_STALE)를 라우팅에서 뺀다.
  pm/model.ts의 Anthropic 호출 구현을 재사용하되 모델 이름·max_tokens·effort는 라우팅용(짧은 출력, 생각 끔 또는 최소)으로 따로.
  프롬프트·해석은 지금 그대로(router.ts의 v2 — 오프라인 평가와 같은 것). routedBy는 'llm:api:<모델>:v2'.
- 그림자 LLM 라우터(routing-eval.ts)도 같은 라우팅 전용 모델을 쓴다.
- 지연(latencyMs)은 API 호출 시작~응답 끝(지금과 같은 정의). 비용(costUsd)은 pm/pricing.ts 가격표로 실제 usage를 계산 — 이제 실제로 나간 돈이다.
- 라우팅 비용은 프로젝트 PM 예산(pm_budget_usd)에서 깎지 않는다(대표 구독 기획 예산과 별개). 대신 지금처럼 routing.costUsd·QUESTION_ASKED.payload.costUsd·
  question_routing_runs에 남는다. 이 판단을 주석·CLAUDE.md에.
- 중계 relay의 purpose 'route'는 더 쓰지 않는다 — pm-worker 쪽 코드에서 route 처리가 남아 있으면 옛 서버 호환을 위해 두되 서버는 보내지 않는다(CLI 변경 불필요하면 건드리지 말 것).
- 테스트는 실제 API를 부르지 않는다 — setPmModel처럼 라우팅 모델을 끼우는 테스트 훅(setRouterModel 등)을 두고 tests/setup-invariants.ts의 기존 기본 라우터 설정과 충돌하지 않게.

# 오프라인 평가 (scripts/eval-question-router.ts, scripts/lib/question-routers.ts)
- 'api:<모델>' 라우터 추가: 서버와 같은 프롬프트·해석·가격표로 Anthropic API를 직접 부른다(키는 실행자의 환경변수 ANTHROPIC_API_KEY — .env를 읽지 않는다).
  예: npx tsx scripts/eval-question-router.ts api:claude-sonnet-5-5 --data team.json
- 보고서에 추가: 정답 담당자별(FE·BE·PM·SELF) 정확도, 혼동표(정답 × 판정), 데이터 항목의 source(예: real·human·llm)별 정확도.
  데이터셋 형식(scripts/data/README-question-routing.md·template)에 accept에 PM 허용, source·difficulty 칸(선택) 추가 — 기존 20문항이 그대로 읽혀야 한다.
- 운영 보고서(GET /projects/:id/routing-report)에도 라우터별 정답 담당자별 정확도와 혼동표를 추가(openapi 함께).

# 하지 말 것
- PM 기획·PM 답 초안의 경로(relay) 변경 없음. 라우터 실패 시 대표에게 보내는 규칙 변경 없음.
- 비밀값을 이벤트·로그에 넣지 않는다. main push·배포 없음.

# 테스트
- PM_PROVIDER=relay + 키 있음 → PM 기획은 relay, 라우팅은 API 모델(가짜)로 판정, routedBy가 'llm:api:…'
- 키 없음 → 라우팅 실패 → fallback:representative(지금과 같음), 경고 로그
- 그림자 LLM도 API 모델을 씀, question_routing_runs에 비용·지연 기록
- routing-report의 담당자별 정확도·혼동표
- 오프라인 평가: api 라우터를 가짜 fetch로, 혼동표·source별 집계, 옛 데이터셋 형식 호환

# 문서
- CLAUDE.md "질문 중계" 절의 라우터 단락을 고친다(라우팅은 항상 서버 API, PM은 PM_PROVIDER — 이유: 서비스 구조·공정한 비교·노트북 의존 제거).
- docs/plan-router-api.md 상단 상태를 "구현됨(PR #번호)"으로 고친다.

# 마무리
npm run typecheck && npm test 통과 후 Feat: 접두어로 커밋하고 dev 대상 PR. PR 본문에 운영 설정 안내:
SSM에 ANTHROPIC_API_KEY 필요, PM_PROVIDER=relay 유지, QUESTION_ROUTER_LLM_MODEL(선택).
```
