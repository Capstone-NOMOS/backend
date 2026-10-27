#!/bin/bash
# Claude Code 클라우드 환경(claude.ai/code) 설정 스크립트 — 환경의 "Setup script" 칸에 `bash scripts/cloud-setup.sh` 한 줄.
# CI(.github/workflows/ci.yml)와 같은 조건을 만든다: Node 22+, 테스트용 PostgreSQL(localhost:55432/nomos_test, postgres/postgres), git 신원.
# 비밀값은 필요 없다 — 테스트는 vitest.config.ts의 test.env만 쓴다. 운영 값(.env·SSM·AWS·ANTHROPIC_API_KEY)을 클라우드 환경에 넣지 말 것.
# 여러 번 돌려도 된다(이미 있는 클러스터·DB는 건너뛴다).
set -euo pipefail

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

log() { echo "[cloud-setup] $*"; }

# --- Node 22+ (package.json engines, CLI가 Node 22 전역 WebSocket을 쓴다) ---
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  log "Node ${NODE_MAJOR} — 22 이상이 필요하다. nodesource로 설치한다"
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  $SUDO apt-get install -y -qq nodejs
fi
log "node $(node -v)"

# --- 테스트용 PostgreSQL: vitest.config.ts와 같은 포트·DB 이름·비밀번호 ---
if ! ls /usr/lib/postgresql/*/bin/postgres >/dev/null 2>&1; then
  log "PostgreSQL 설치"
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq postgresql
fi
PGVER=$(ls /usr/lib/postgresql | sort -V | tail -1)
log "PostgreSQL ${PGVER} (운영·CI는 16)"
# postgres 사용자로 실행(root면 runuser, 아니면 sudo).
as_pg() { if [ "$(id -u)" -eq 0 ]; then runuser -u postgres -- "$@"; else sudo -u postgres "$@"; fi; }
if ! $SUDO pg_lsclusters -h | awk '{print $2}' | grep -qx test; then
  # 한국어 데이터가 있으므로 UTF8(테스트 컨테이너 postgres:16-alpine과 같다). C 로캘이면 기본이 SQL_ASCII다.
  $SUDO pg_createcluster "$PGVER" test -p 55432 -e UTF8 --locale C.UTF-8
fi
if ! $SUDO pg_lsclusters -h | awk '$2 == "test" {print $4}' | grep -qx online; then
  $SUDO pg_ctlcluster "$PGVER" test start
fi
as_pg psql -p 55432 -qc "ALTER USER postgres PASSWORD 'postgres'"
if ! as_pg psql -p 55432 -tAc "SELECT 1 FROM pg_database WHERE datname = 'nomos_test'" | grep -q 1; then
  as_pg createdb -p 55432 -E UTF8 -T template0 nomos_test
fi
log "DB 준비됨 — localhost:55432/nomos_test"

# --- 테스트 일부가 임시 git 저장소에 커밋한다(mirror 검사기·브릿지 push) — CI와 같은 신원 ---
if ! command -v git >/dev/null 2>&1; then $SUDO apt-get install -y -qq git; fi
git config --global user.name >/dev/null 2>&1 || git config --global user.name ci
git config --global user.email >/dev/null 2>&1 || git config --global user.email ci@localhost
git config --global init.defaultBranch main

# --- 의존성: 이 스크립트가 레포 안에서 돌면 설치까지 ---
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$REPO_ROOT/package-lock.json" ]; then
  log "npm ci (${REPO_ROOT})"
  (cd "$REPO_ROOT" && npm ci --no-audit --no-fund)
fi

log "완료 — 확인: npm run typecheck && npm test"
