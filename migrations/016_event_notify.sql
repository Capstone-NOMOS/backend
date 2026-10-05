-- Up Migration

-- 사람용 실시간 스트림(/api/stream)의 신호원. events에 행이 들어가면 같은 트랜잭션에서 NOTIFY를 건다.
--
-- 왜 트리거인가: 모든 상태 변화는 반드시 events에 남는다(P5). 서비스마다 "알림" 호출을 넣으면 빠뜨린 경로가 조용히 생기지만,
-- events INSERT에 걸면 어떤 경로(API·PM·seed:tasks 스크립트)든 빠짐없이 잡힌다.
-- 왜 NOTIFY인가: Postgres는 NOTIFY를 **커밋할 때만** 전달하고 롤백되면 버린다. "커밋 뒤에 알린다"를 DB가 보장한다
-- (dry-run으로 ROLLBACK하는 계획 검증도 신호를 내지 않는다). 서버를 여러 대로 늘려도 각 서버가 같은 채널을 LISTEN하면 된다.
--
-- 싣는 것은 식별자뿐이다(payload 제외) — NOTIFY는 8000바이트 제한이 있고, 받는 쪽은 "무엇이 바뀌었는지"만 알면 API로 다시 읽는다.
CREATE FUNCTION nomos_notify_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'nomos_events',
    json_build_object('id', NEW.id, 'orgId', NEW.org_id, 'projectId', NEW.project_id, 'type', NEW.type)::text
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_events_notify
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION nomos_notify_event();

-- Down Migration

DROP TRIGGER IF EXISTS trg_events_notify ON events;
DROP FUNCTION IF EXISTS nomos_notify_event();
