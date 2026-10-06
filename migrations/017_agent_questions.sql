-- Up Migration

-- 에이전트의 질문(실험 — exp/question-relay). 실행 중인 에이전트가 다른 역할 소관의 결정을 AskUserQuestion으로 물으면
-- 브릿지가 여기에 올린다. 답은 두 길로 온다(C안):
--   ① 대상 역할 에이전트의 **상담 실행**(읽기 전용)이 초안(draft)을 올린다. 질문 전부가 코드·명세에 이미 정해져 있으면(decided)
--      그 답을 바로 쓴다 — agent_answered(사람 미확인). 사람은 나중에 확인하거나 뒤집는다.
--   ② 아직 정해지지 않은 결정이 섞였거나 상담이 없으면 대상 역할의 사람(또는 대표)이 답한다 — answered.
-- 묻는 쪽 실행은 정한 시간만 기다리고, 그 뒤 태스크는 BLOCKED(QUESTION)로 내려놓는다. 답이 오면 READY로 돌아간다.
--
-- questions·answers는 Claude Code의 AskUserQuestion 형식을 그대로 담는다 — answers의 키는 질문 문장과 정확히 같아야
-- 모델이 답으로 받아들인다(실험 E3: 키가 다르면 "답하지 않음"으로 처리됐다).
-- 대상 역할(target_role)은 서버의 질문 라우터가 정한다(domain/question/router.ts — 구현을 바꿔 끼운다). routed_by에 구현 이름을 남긴다.
-- self_owned: 라우터가 "묻는 쪽 자기 소관"이라고 판정해 넘기지 않고 돌려보낸 질문(target_role = asker_role).
CREATE TABLE agent_questions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id),
  task_id          uuid NOT NULL REFERENCES tasks(id),
  asked_by_agent   uuid NOT NULL REFERENCES agents(id),
  asker_role       text NOT NULL,
  target_role      text NOT NULL,
  routed_by        text NOT NULL,
  -- 라우터 판정 상세 — {confidence, reason, latencyMs, fallback}. 라우터 구현을 바꿔 가며 비교하는 근거다.
  routing          jsonb NOT NULL DEFAULT '{}',
  questions        jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  -- 상담 실행의 초안 — {answers, decided, basis}. 사람이 답할 때 함께 보여 준다.
  draft            jsonb,
  drafted_by_agent uuid REFERENCES agents(id),
  drafted_at       timestamptz,
  answers          jsonb,
  -- 답의 출처: agent(상담 실행이 코드로 찾음, 사람 미확인) · human(사람이 직접) · agent_confirmed(사람이 에이전트 답을 확인) · human_override(사람이 에이전트 답을 뒤집음)
  answer_source    text,
  answered_by      uuid REFERENCES users(id),
  answered_at      timestamptz,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_questions_status_chk CHECK (status IN ('pending', 'agent_answered', 'answered', 'expired', 'self_owned')),
  CONSTRAINT agent_questions_roles_chk CHECK (asker_role IN ('FRONTEND', 'BACKEND') AND target_role IN ('FRONTEND', 'BACKEND')),
  CONSTRAINT agent_questions_questions_chk CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) BETWEEN 1 AND 4),
  CONSTRAINT agent_questions_source_chk CHECK (answer_source IS NULL OR answer_source IN ('agent', 'human', 'agent_confirmed', 'human_override')),
  -- 답이 있는 상태에만 답과 출처가 있다. 사람이 답한(answered) 경우에만 답한 사람이 있다.
  CONSTRAINT agent_questions_answer_chk CHECK (
    (status IN ('agent_answered', 'answered')) = (answers IS NOT NULL AND answer_source IS NOT NULL AND answered_at IS NOT NULL)
  ),
  CONSTRAINT agent_questions_answered_by_chk CHECK ((status = 'answered') = (answered_by IS NOT NULL)),
  CONSTRAINT agent_questions_agent_answer_chk CHECK (status <> 'agent_answered' OR (answer_source = 'agent' AND drafted_by_agent IS NOT NULL)),
  CONSTRAINT agent_questions_draft_chk CHECK ((draft IS NULL) = (drafted_by_agent IS NULL AND drafted_at IS NULL))
);

CREATE INDEX idx_agent_questions_project ON agent_questions (project_id, created_at DESC);
CREATE INDEX idx_agent_questions_pending ON agent_questions (project_id) WHERE status = 'pending';
CREATE INDEX idx_agent_questions_task ON agent_questions (task_id);

-- Down Migration

DROP TABLE IF EXISTS agent_questions;
