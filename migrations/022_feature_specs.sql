-- Up Migration

-- 새 계획 흐름 1단계 — 기능 명세(대표 결정 2026-10-15).
--   대표의 자연어 요구 → PM이 **기능 명세**(화면·동작·수용 기준, 개발 용어 없이)를 쓰고 대표가 확정한다.
--   API 계약은 PM이 아니라 BE 에이전트가 BE 코드를 읽고 쓰고 BE 개발자가 확정한다(2단계, contracts).
--   태스크 분할은 대표가 누르면 PM이 확정된 기능 명세 + 계약으로 한다(3단계).
--
--   plans.kind   — 'feature'(기능 명세 초안) | 'tasks'(태스크 분할 초안). 초안·수정 요청·예산·중계는 같은 흐름을 탄다.
--                  이전 계획(명세+태스크를 한 번에)은 전부 'tasks'다.
--   specs.needs_api / api_needs — 이 기능에 API가 필요한가, 필요하면 어떤 데이터가 오가야 하는가(사람 말로).
--                  API가 필요한 기능만 계약 단계로 간다. 계약은 api_needs를 보고 BE가 정한다.

ALTER TABLE plans ADD COLUMN kind text NOT NULL DEFAULT 'tasks';
ALTER TABLE plans ADD CONSTRAINT plans_kind_chk CHECK (kind IN ('feature', 'tasks'));

ALTER TABLE specs ADD COLUMN needs_api boolean NOT NULL DEFAULT false;
ALTER TABLE specs ADD COLUMN api_needs text;
ALTER TABLE specs ADD CONSTRAINT specs_api_needs_chk
  CHECK ((needs_api = false AND api_needs IS NULL) OR (needs_api = true AND char_length(api_needs) BETWEEN 1 AND 2000));

-- Down Migration

ALTER TABLE specs DROP CONSTRAINT specs_api_needs_chk;
ALTER TABLE specs DROP COLUMN api_needs;
ALTER TABLE specs DROP COLUMN needs_api;
ALTER TABLE plans DROP CONSTRAINT plans_kind_chk;
ALTER TABLE plans DROP COLUMN kind;
