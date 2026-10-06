-- Up Migration

-- 에이전트의 질문(실험 — exp/question-relay). 실행 중인 에이전트가 다른 역할 소관의 결정을 AskUserQuestion으로 물으면
-- 브릿지가 여기에 올리고, 그 역할의 사람이 답한다. 에이전트 실행은 답이 올 때까지(또는 만료까지) 기다린다.
--
-- questions·answers는 Claude Code의 AskUserQuestion 형식을 그대로 담는다 — answers의 키는 질문 문장과 정확히 같아야
-- 모델이 답으로 받아들인다(실험 E3: 키가 다르면 "답하지 않음"으로 처리됐다).
-- 대상 역할(target_role)은 서버가 정한다(지금은 "묻는 쪽의 반대 역할" 규칙, 나중에 결정 모델로 대체) — routed_by에 근거를 남긴다.
CREATE TABLE agent_questions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id),
  task_id          uuid NOT NULL REFERENCES tasks(id),
  asked_by_agent   uuid NOT NULL REFERENCES agents(id),
  asker_role       text NOT NULL,
  target_role      text NOT NULL,
  routed_by        text NOT NULL,
  questions        jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  answers          jsonb,
  answered_by      uuid REFERENCES users(id),
  answered_at      timestamptz,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_questions_status_chk CHECK (status IN ('pending', 'answered', 'expired')),
  CONSTRAINT agent_questions_roles_chk CHECK (asker_role IN ('FRONTEND', 'BACKEND') AND target_role IN ('FRONTEND', 'BACKEND')),
  CONSTRAINT agent_questions_questions_chk CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) BETWEEN 1 AND 4),
  -- 답이 있으면 답한 사람과 시각도 있다. 없으면 셋 다 없다.
  CONSTRAINT agent_questions_answered_chk CHECK (
    (status = 'answered') = (answers IS NOT NULL AND answered_by IS NOT NULL AND answered_at IS NOT NULL)
  )
);

CREATE INDEX idx_agent_questions_project ON agent_questions (project_id, created_at DESC);
CREATE INDEX idx_agent_questions_pending ON agent_questions (project_id) WHERE status = 'pending';

-- Down Migration

DROP TABLE IF EXISTS agent_questions;
