# 질문 라우터 평가 데이터셋

에이전트가 작업 중에 AskUserQuestion으로 한 질문을 **누구 소관인지** 판정하는 라우터(`src/domain/question/router.ts`)를 비교하기 위한 데이터다.
빈 틀은 `question-routing.template.json`. 실행은 `scripts/eval-question-router.ts` 머리 주석 참고.

```bash
npx tsx scripts/eval-question-router.ts --check --data 내파일.json      # 형식만 검사
npx tsx scripts/eval-question-router.ts claude:sonnet --data 내파일.json --repeat 2
```

## 구조

| 칸 | 필수 | 뜻 |
|---|---|---|
| `version` | ✅ | 데이터셋 버전(숫자나 문자열). **정답을 고치면 올린다** — 결과 파일에 함께 남아 섞이지 않는다 |
| `roles` | | 프로젝트의 역할. 생략하면 `["FRONTEND", "BACKEND"]` |
| `contexts.<이름>` | ✅ | 질문이 나온 상황. 여러 문항이 같은 상황을 공유한다 |
| ├ `askerRole` | ✅ | 질문한 에이전트의 역할 |
| ├ `task.title` | ✅ | 태스크 제목 (`kind`는 생략하면 IMPLEMENT) |
| ├ `repo.fullName` | | 레포 이름. 없으면 `null` |
| └ `spec` | | `{ featureKey, title, content }` 명세. 없으면 `null` |
| `items[]` | ✅ | 문항 |
| ├ `id` | ✅ | 겹치지 않는 아이디 |
| ├ `context` | ✅ | 위 `contexts`의 이름 |
| ├ `question` / `questions` | ✅ 둘 중 하나 | 질문 하나면 `question`, 한 번의 AskUserQuestion에 여러 개였으면 `questions`(최대 4) |
| ├ `accept` | ✅ | 정답으로 인정하는 판정: `FRONTEND` · `BACKEND` · `SELF`(묻는 쪽 자기 소관). **애매하면 둘 이상** |
| ├ `source` | | `real`(실제 에이전트 질문) · `synthetic`(만든 것) 등 |
| ├ `labeledBy` | | 정답을 붙인 사람 |
| └ `note` | | 메모 |

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
| `selfRecall` | 정답이 `SELF`뿐인 문항을 `SELF`로 돌려보낸 비율(자기 소관을 남에게 묻지 않게 하는 능력) |
| `wronglyKept` | `SELF`가 정답에 없는데 `SELF`로 막은 비율(물어야 할 걸 못 묻게 한 비율 — 낮아야 한다) |
| `unstable` | `--repeat 2` 이상에서 같은 문항의 판정이 갈린 문항 수 |
| `avgMs`·`totalCostUsd` | 지연·비용(Claude 라우터는 구독 사용량 환산값) |
