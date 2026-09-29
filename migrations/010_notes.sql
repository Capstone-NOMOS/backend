-- Up Migration
-- 인계 노트. 대화 채널이 아니라 기록이다.
--
-- 본문 text 컬럼을 두지 않는다 — 칸을 주면 길게 채우고, 그러면 노트가 채팅이 된다.
-- 수신자 지정(to_agent)도 reply_to도 만들지 않는다. 브로드캐스트이고, 정정은 새 행(supersedes)이다.
--
-- 검증은 두 층으로 나뉜다:
--   DB  — 구조로 표현되는 것(개수·총량·어휘·줄바꿈·머리표). 어떤 경로로 들어와도 막힌다.
--   앱  — 위반 지점을 되돌려줘야 하는 것(몇 번째 항목이 몇 자인지)과 DB 조회가 필요한 것(과실 주장).
-- CHECK 안에서는 서브쿼리를 쓸 수 없어 배열 원소별 길이는 여기서 검사할 수 없다. 그건 앱이 422로 답한다.
CREATE TABLE notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq             integer NOT NULL,
  task_id         uuid REFERENCES tasks(id),
  spec_id         uuid REFERENCES specs(id),
  repo_id         uuid REFERENCES repos(id),
  kind            text NOT NULL,
  headline        text NOT NULL,
  key_points      text[] NOT NULL,
  affects         text[] NOT NULL DEFAULT '{}',
  author_agent_id uuid NOT NULL REFERENCES agents(id),
  on_behalf_of    text NOT NULL,
  supersedes      uuid REFERENCES notes(id),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notes_kind_chk CHECK (kind IN ('IMPLEMENTED', 'DECIDED', 'GOTCHA', 'DEVIATION')),
  CONSTRAINT notes_key_points_count_chk CHECK (cardinality(key_points) BETWEEN 1 AND 5),
  CONSTRAINT notes_affects_count_chk CHECK (cardinality(affects) <= 10),
  -- 명세를 벗어났다고 알리면서 어디가 영향받는지 안 적으면 받는 쪽이 할 수 있는 게 없다.
  CONSTRAINT notes_deviation_affects_chk CHECK (kind <> 'DEVIATION' OR cardinality(affects) > 0),
  CONSTRAINT notes_headline_len_chk CHECK (length(headline) <= 60),
  -- 700자는 headline + key_points 합계다. affects는 포함하지 않는다.
  CONSTRAINT notes_budget_chk CHECK (length(headline) + length(array_to_string(key_points, '')) <= 700),
  -- 줄바꿈을 허용하면 한 항목에 문단을 밀어넣어 길이 제한을 우회한다.
  CONSTRAINT notes_no_newline_chk CHECK (
    headline !~ '[\n\r]' AND array_to_string(key_points, '') !~ '[\n\r]'
  ),
  -- 마크다운 머리표(#)를 허용하면 노트가 문서가 된다. 원소를 줄로 이어 각 항목의 시작을 본다.
  CONSTRAINT notes_no_heading_chk CHECK (
    headline !~ '^[ \t]*#' AND array_to_string(key_points, E'\n') !~ '(^|\n)[ \t]*#'
  ),
  CONSTRAINT uq_notes_seq UNIQUE (project_id, seq)
);
CREATE INDEX idx_notes_project_spec ON notes(project_id, spec_id);
CREATE INDEX idx_notes_author ON notes(author_agent_id);

-- Down Migration
DROP TABLE IF EXISTS notes;
