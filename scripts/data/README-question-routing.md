# 질문 라우터 평가 데이터셋

에이전트가 작업 중에 AskUserQuestion으로 한 질문을 **누구 소관인지** 판정하는 라우터(`src/domain/question/router.ts`)를 비교하기 위한 데이터다.
빈 틀은 `question-routing.template.json`. 실행은 `scripts/eval-question-router.ts` 머리 주석 참고.

```bash
npx tsx scripts/eval-question-router.ts --check --data 내파일.json      # 형식만 검사
npx tsx scripts/eval-question-router.ts claude:sonnet --data 내파일.json --repeat 2
```

## 구조 — v2 (기본)

항목마다 **운영 서버의 라우터가 받는 입력과 같은 모양**(`RoutingInputSnapshot`, `src/domain/question/router.ts`)을 그대로 담는다.
평가는 이 `input`을 **다시 조립하지 않고 그대로** 라우터에 넣는다 — 운영과 같은 입력으로 비교하기 위해서다.
운영에서 모은 실제 질문은 `GET /api/projects/:id/routing-dataset`(대표) 응답을 파일로 저장해 그대로 넣는다(`{ data: { items } }`도 읽는다).

| 칸 | 필수 | 뜻 |
|---|---|---|
| `version` | | 데이터셋 버전. **정답을 고치면 올린다** — 결과 파일에 함께 남아 섞이지 않는다 |
| `items[]` | ✅ | 문항 |
| ├ `id` | ✅ | 겹치지 않는 아이디(운영 내보내기는 질문 id) |
| ├ `input.stage` | | 질문이 나온 단계 `implementation`(구현 중) · `feature_spec`(PM이 기능 명세 초안을 쓰는 중) · `contract`(BE가 API 계약 초안을 쓰는 중). 생략하면 `implementation` |
| ├ `input.askerRole` | ✅ | 묻는 쪽 `FRONTEND` · `BACKEND` · `PM`(기능 명세 초안) |
| ├ `input.roles` | ✅ | 프로젝트에 있는 역할 |
| ├ `input.task` | ✅ | `{ title, kind }` 또는 `null`(기획 단계) |
| ├ `input.spec` | ✅ | `{ featureKey, title, content }` 또는 `null` |
| ├ `input.repo` | ✅ | `{ fullName }` 또는 `null` |
| ├ `input.questions` | ✅ | AskUserQuestion 형식 `[{ question, options: [{ label }] }]`(1~4개) |
| ├ `input.contract` | | 그 기능의 확정한 API 계약 요약 `{ featureKey, summary }` — `implementation`에서만, 아니면 `null` |
| ├ `accept` | ✅ | 정답으로 인정하는 판정: `FRONTEND` · `BACKEND` · `PM` · `SELF`. **애매하면 둘 이상**. 빈 배열이면 평가에서 건너뛴다(라벨 전 내보내기) |
| ├ `source` | | `real-run`(운영 실행) · `real-transcript`(개발 기록) · `transplanted`(다른 맥락에 옮겨 심음) · `human` · `llm` — 보고서에 출처별 정확도가 나온다 |
| ├ `difficulty` | | `clear` · `ambiguous` · `trap` |
| └ `note` | | 메모 |

내보내기 항목에는 `stage`(= `input.stage`)·`asked_at`·`primary`(실제로 보낸 판정)·`gold_labeled`도 있다 — 평가는 `stage`만 확인하고(다르면 형식 오류) 나머지는 무시한다.

## 구조 — v1 (옛 형식, 계속 읽는다)

`contexts`(상황) + 항목이 `context` 이름을 참조한다(`question-routing.json`의 초기 20문항). 읽을 때 v2 입력으로 바꾼다 —
`stage`는 `implementation`, `roles`는 데이터셋의 `roles`(생략하면 `["FRONTEND", "BACKEND"]`), `contract`는 `null`, 질문의 `options`는 빈 배열.

| 칸 | 필수 | 뜻 |
|---|---|---|
| `version` | ✅ | 데이터셋 버전 |
| `roles` | | 프로젝트의 역할 |
| `contexts.<이름>` | ✅ | `{ askerRole, task: { title, kind? }, repo?, spec? }` |
| `items[]` | ✅ | `{ id, context, question | questions, accept, source?, labeledBy?, note? }` |

## 정답을 붙이는 기준

- **답을 정할 권한이 누구에게 있나**로 고른다. 그 정보를 누가 알고 있나가 아니다.
  - FE가 "API 응답 형식은?" → `BACKEND` (계약은 BE가 정한다)
  - BE가 "화면에 어떤 필드가 필요한가?" → `FRONTEND` (화면 요구는 FE가 정한다)
  - FE가 "날짜를 화면에 어떤 형식으로?" → `SELF` (자기 화면 결정)
- 팀마다 다를 수 있는 질문(예: 에러 문구를 서버가 주나 화면이 정하나)은 `accept`에 둘 다 넣고 `note`에 이유를 적는다.
- `questions` 묶음은 "묶음 전체를 한 사람에게 보낸다면 누구에게"로 고른다. 섞여 있어 정할 수 없으면 둘 다 넣고 `note`에 적는다.

## 지표

| 지표 | 뜻 |
|---|---|
| `accuracy` | 판정이 `accept`에 든 비율 |
| `bySource` | 출처(`source`)별 정확도 — LLM이 만든 문항은 LLM 라우터가 잘 맞혀 점수가 부풀 수 있어 따로 본다 |
| `byStage` | 단계(`stage`)별 정확도 |
| `selfRecall` | 정답이 `SELF`뿐인 문항을 `SELF`로 돌려보낸 비율(자기 소관을 남에게 묻지 않게 하는 능력) |
| `wronglyKept` | `SELF`가 정답에 없는데 `SELF`로 막은 비율(물어야 할 걸 못 묻게 한 비율 — 낮아야 한다) |
| `unstable` | `--repeat 2` 이상에서 같은 문항의 판정이 갈린 문항 수 |
| `avgMs`·`totalCostUsd` | 지연·비용(Claude 라우터는 구독 사용량 환산값) |
