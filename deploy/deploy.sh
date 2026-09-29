#!/usr/bin/env bash
# EC2에서 실행한다: bash deploy.sh <이미지 태그>
#
# 순서가 핵심이다: pull → migrate → 서버 교체 → 헬스체크.
#   - migrate가 실패하면 여기서 멈춘다. 떠 있던 이전 서버는 그대로 돈다.
#   - migrate를 건너뛰고 서버를 올리면 서버가 스스로 기동을 거부한다(스키마 버전 검사) —
#     그래서 이 스크립트를 쓰지 않고 compose를 직접 올려도 틀린 스키마로 뜨지는 않는다.
#
# 롤백: bash deploy.sh <이전 태그>. 마이그레이션은 앞으로만 간다. 이전 이미지는 DB가 자기보다
# 앞서 있어도 뜬다(검사는 "이미지에 있는데 DB에 없는 것"만 본다) — 새 스키마가 추가형이어야 성립한다.
set -euo pipefail
cd "$(dirname "$0")"

TAG="${1:?사용법: bash deploy.sh <이미지 태그>   예) bash deploy.sh 2026-09-28.1}"

if [ ! -f deploy.env ]; then
  echo "deploy.env가 없다. deploy.env.example을 복사해 채워라." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source ./deploy.env
set +a

export NOMOS_IMAGE="${ECR_REPO}:${TAG}"
COMPOSE=(docker compose --env-file deploy.env)

echo "▶ ECR 로그인 (EC2 인스턴스 역할)"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${ECR_REPO%%/*}" >/dev/null

echo "▶ 이미지 받기: $NOMOS_IMAGE"
docker pull "$NOMOS_IMAGE"

echo "▶ 마이그레이션"
"${COMPOSE[@]}" run --rm app migrate

echo "▶ 서버 교체"
"${COMPOSE[@]}" up -d app caddy

echo "▶ 헬스체크 (최대 60초)"
for _ in $(seq 1 30); do
  if "${COMPOSE[@]}" exec -T app node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "$TAG" > .deployed-tag
    echo "✓ 배포 완료: $NOMOS_IMAGE"
    echo "  확인: curl https://$DOMAIN/health"
    exit 0
  fi
  sleep 2
done

echo "✗ 서버가 60초 안에 정상 응답하지 않았다. 최근 로그:" >&2
"${COMPOSE[@]}" logs --tail 50 app >&2
exit 1
