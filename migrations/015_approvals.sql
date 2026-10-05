-- Up Migration
-- 승인 대기열. 지금 범위는 ACTION 게이트 하나다 — 검증은 통과했지만 정책 판정이 AUTO가 아니라(HUMAN·PM_REVIEW)
-- AWAITING_APPROVAL에 들어간 산출물. G1(시작)은 직접 호출하는 API(POST /projects/:id/start)라 카드가 없고,
-- G2(계약 협상)·G3(완료 보고)는 그 기능이 생길 때 같은 테이블을 쓴다(gate 값은 ERD대로 미리 허용한다).
--
-- 승인은 대표만 한다(서비스가 확인). 결정은 한 번뿐 — 결정된 행은 다시 바뀌지 않는다(조건부 UPDATE).
-- 카드 내용(payload)은 **요청 시점의 스냅샷**이다. 태스크·산출물이 나중에 바뀌어도 "무엇을 승인했나"가 남아야 한다.

CREATE TABLE approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id),
  gate          text NOT NULL,
  -- ERD의 action_key 칸. ACTION이면 걸린 행동 키가 여럿일 수 있어 목록은 payload.triggeredActions에 두고, 여기는 비워 둔다.
  action_key    text,
  -- 무엇에 대한 승인인가. ACTION이면 태스크 id.
  subject_id    uuid NOT NULL,
  -- ACTION: 승인 대상 산출물과 그 판정(HUMAN | PM_REVIEW). PM_REVIEW는 PM 리뷰가 생길 때까지 대표가 대신 처리한다.
  artifact_id   uuid REFERENCES artifacts(id),
  gate_mode     text,
  payload       jsonb NOT NULL,
  decision      text,
  decided_by    uuid REFERENCES users(id),
  reason        text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  CONSTRAINT approvals_gate_chk CHECK (gate IN ('G1', 'G2', 'G3', 'ACTION')),
  CONSTRAINT approvals_decision_chk CHECK (decision IS NULL OR decision IN ('APPROVE', 'REJECT')),
  -- 결정·결정자·결정 시각은 함께 채워지거나 함께 비어 있다.
  CONSTRAINT approvals_decided_chk CHECK (
    (decision IS NULL) = (decided_at IS NULL) AND (decision IS NULL) = (decided_by IS NULL)
  ),
  -- 반려는 사유가 필수다 — 다음 시도의 브리핑에 그대로 들어간다.
  CONSTRAINT approvals_reject_reason_chk CHECK (
    decision IS DISTINCT FROM 'REJECT' OR (reason IS NOT NULL AND char_length(reason) BETWEEN 1 AND 2000)
  ),
  CONSTRAINT approvals_action_chk CHECK (
    gate <> 'ACTION' OR (artifact_id IS NOT NULL AND gate_mode IN ('HUMAN', 'PM_REVIEW'))
  )
);

-- 한 대상에 대기 중인 승인은 하나. 같은 산출물이 두 번 대기열에 오르지 않게 하는 마지막 방어선이다.
CREATE UNIQUE INDEX uq_approvals_pending_subject ON approvals(subject_id) WHERE decision IS NULL;
CREATE INDEX idx_approvals_project ON approvals(project_id, decision, requested_at);

-- 백필 — 이 마이그레이션 전부터 AWAITING_APPROVAL에 멈춰 있던 태스크(승인 경로가 없어 사람이 DB를 고쳐야 했다).
-- 요청 시점의 스냅샷은 없으므로 지금 DB에서 알 수 있는 값(최신 산출물)으로만 카드를 만들고 backfilled: true로 표시한다
-- (화면이 "정보 일부 없음"을 보여 줄 수 있게). 이벤트(APPROVAL_REQUESTED)는 남기지 않는다 — events에 쓰는 경로는 appendEvent 하나다.
INSERT INTO approvals (project_id, gate, subject_id, artifact_id, gate_mode, payload, requested_at)
SELECT t.project_id, 'ACTION', t.id, a.id, a.gate_mode,
       jsonb_build_object(
         'backfilled', true,
         'taskTitle', t.title,
         'artifactId', a.id,
         'attempt', a.attempt,
         'commitSha', a.commit_sha,
         'changedPaths', to_jsonb(a.changed_paths),
         'triggeredActions', to_jsonb(a.triggered_actions),
         'gateMode', a.gate_mode
       ),
       a.created_at
  FROM tasks t
  JOIN LATERAL (SELECT * FROM artifacts WHERE task_id = t.id ORDER BY attempt DESC LIMIT 1) a ON true
 WHERE t.state = 'AWAITING_APPROVAL' AND a.gate_mode IN ('HUMAN', 'PM_REVIEW');

-- Down Migration
DROP TABLE IF EXISTS approvals;
