-- Up Migration

-- 해제·삭제(대표 결정 2026-10-14). 행은 지우지 않는다 — events·tasks·노트가 이 행들을 가리키고(P5 기록이 끊긴다), 다시 연결할 수 있어야 한다.
--   agents.disconnected_at   — 에이전트 연결 해제(주인·대표). refresh token을 모두 폐기하고, 남은 access token은 인증에서 거부한다.
--                              같은 노트북(같은 사용자·같은 이름)으로 다시 connect하면 그 행이 되살아난다(upsert가 비운다).
--   repos.disconnected_at    — 조직에서 레포 연결 해제(대표, 진행 중 프로젝트가 쓰지 않을 때만). 경로 규칙은 남는다 — 같은 레포를 다시 연결하면 되살아난다.
--   invites.revoked_at       — 초대 취소(대표). 취소한 링크로는 가입할 수 없다.
-- 조직에서 빠진 사람은 users.org_id를 NULL로 되돌린다(계정은 유지, 다른 조직에 다시 들어갈 수 있다) — 새 컬럼이 필요 없다.

ALTER TABLE agents ADD COLUMN disconnected_at timestamptz;
ALTER TABLE repos ADD COLUMN disconnected_at timestamptz;
ALTER TABLE invites ADD COLUMN revoked_at timestamptz;

-- Down Migration

ALTER TABLE invites DROP COLUMN revoked_at;
ALTER TABLE repos DROP COLUMN disconnected_at;
ALTER TABLE agents DROP COLUMN disconnected_at;
