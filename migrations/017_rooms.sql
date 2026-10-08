-- Up Migration

-- 룸(프로젝트 × 역할)의 피드 재료 두 가지. 룸 자체는 테이블이 없다 — 역할당 에이전트가 하나라 구성이 저절로 정해진다.

-- ① 서버(PM)가 "이 태스크를 실행해 주세요"를 보낸 기록. 가져갈 수 있게 된 순간(READY·담당 없음·선행 완료·시작됨) 한 번씩.
--    재시도로 다시 READY가 되면 attempt(=그때의 retry_count)가, 대표가 재개하면 resumes(=TASK_RESUMED 수)가 달라 다시 보낸다. PK가 중복을 막는다 —
--    tasksChanged는 여러 번·동시에 불릴 수 있으므로 "한 번만"을 DB가 보장해야 한다. 이벤트(TASK_DISPATCHED)는 INSERT된 행에만 남긴다.
CREATE TABLE task_dispatches (
  task_id       uuid NOT NULL REFERENCES tasks(id),
  attempt       integer NOT NULL CHECK (attempt >= 0),
  resumes       integer NOT NULL DEFAULT 0 CHECK (resumes >= 0),
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, attempt, resumes)
);

-- ② 에이전트가 실행 중에 쓴 도구 한 줄씩("src/a.ts 읽는 중", "npm test 실행"). Executor가 Claude 출력에서 뽑아 보낸다.
--    상태 변화가 아니라서 events에 넣지 않는다(양이 많고, P5의 대상이 아니다). 파일 내용·명령 결과·모델 설명은 받지 않는다 —
--    도구 종류와 대상(경로·명령)만. 설명은 인계 노트의 몫이다.
CREATE TABLE agent_activity (
  id         bigserial PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id    uuid NOT NULL REFERENCES tasks(id),
  agent_id   uuid NOT NULL REFERENCES agents(id),
  kind       text NOT NULL,
  target     text NOT NULL,
  ts         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_activity_kind_chk CHECK (kind IN ('read', 'edit', 'write', 'run', 'search', 'other')),
  CONSTRAINT agent_activity_target_chk CHECK (char_length(target) BETWEEN 1 AND 300)
);
CREATE INDEX idx_agent_activity_project ON agent_activity(project_id, id);

-- ③ 에이전트가 제출 없이 멈춘 태스크는 BLOCKED(AGENT_STOPPED)로 둔다 — CLAIMED로 남으면 아무도 다시 가져가지 못하고(운영 테스트에서 영구 정체),
--    READY로 되돌려 재시도 횟수를 깎으면 권한·환경 탓을 에이전트 실패로 센다. 대표가 원인을 해결하고 재개하면 READY.
ALTER TABLE tasks DROP CONSTRAINT tasks_blocked_reason_chk;
ALTER TABLE tasks ADD CONSTRAINT tasks_blocked_reason_chk CHECK (blocked_reason IS NULL OR blocked_reason IN
  ('DISPUTE', 'DEPENDENCY', 'QUESTION', 'AGENT_STOPPED'));

-- ④ 마지막 수령 시각. 화면의 "수령 후 경과"와, 응답이 끊긴 에이전트를 찾는 감시(watchdog)가 쓴다. 이미 잡혀 있는 태스크는 updated_at으로 채운다.
ALTER TABLE tasks ADD COLUMN claimed_at timestamptz;
UPDATE tasks SET claimed_at = updated_at WHERE state IN ('CLAIMED', 'IN_PROGRESS');

-- Down Migration

ALTER TABLE tasks DROP COLUMN IF EXISTS claimed_at;
ALTER TABLE tasks DROP CONSTRAINT tasks_blocked_reason_chk;
ALTER TABLE tasks ADD CONSTRAINT tasks_blocked_reason_chk CHECK (blocked_reason IS NULL OR blocked_reason IN
  ('DISPUTE', 'DEPENDENCY', 'QUESTION'));

DROP TABLE IF EXISTS agent_activity;
DROP TABLE IF EXISTS task_dispatches;
