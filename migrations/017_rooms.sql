-- Up Migration

-- 룸(프로젝트 × 역할)의 피드 재료 두 가지. 룸 자체는 테이블이 없다 — 역할당 에이전트가 하나라 구성이 저절로 정해진다.

-- ① 서버(PM)가 "이 태스크를 실행해 주세요"를 보낸 기록. 가져갈 수 있게 된 순간(READY·담당 없음·선행 완료·시작됨) 한 번씩.
--    재시도로 다시 READY가 되면 attempt(=그때의 retry_count)가 달라 다시 보낸다. PK가 중복을 막는다 —
--    tasksChanged는 여러 번·동시에 불릴 수 있으므로 "한 번만"을 DB가 보장해야 한다. 이벤트(TASK_DISPATCHED)는 INSERT된 행에만 남긴다.
CREATE TABLE task_dispatches (
  task_id       uuid NOT NULL REFERENCES tasks(id),
  attempt       integer NOT NULL CHECK (attempt >= 0),
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, attempt)
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

-- Down Migration

DROP TABLE IF EXISTS agent_activity;
DROP TABLE IF EXISTS task_dispatches;
