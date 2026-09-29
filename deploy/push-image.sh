#!/usr/bin/env bash
# 대표 노트북(Git Bash)에서 실행한다: bash deploy/push-image.sh <태그>
# 이미지를 빌드해 ECR에 올린다. 그다음 EC2에서 bash deploy.sh <같은 태그>.
#
# 태그는 날짜.순번처럼 매번 새로 짓는다. ECR 리포지토리를 "태그 변경 불가"로 만들었으므로
# 같은 태그를 두 번 올리면 거부된다 — 롤백할 때 그 태그가 가리키는 이미지가 바뀌지 않게 하기 위해서다.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:?사용법: bash deploy/push-image.sh <태그>   예) bash deploy/push-image.sh 2026-09-28.1}"

if [ ! -f deploy/deploy.env ]; then
  echo "deploy/deploy.env가 없다. deploy/deploy.env.example을 복사해 채워라." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source deploy/deploy.env
set +a

IMAGE="${ECR_REPO}:${TAG}"

echo "▶ ECR 로그인 (aws configure로 설정한 대표 계정)"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${ECR_REPO%%/*}" >/dev/null

# EC2가 t3(x86)이므로 amd64로 고정한다. ARM 맥에서 빌드해도 서버에서 돈다.
echo "▶ 빌드: $IMAGE"
docker build --platform linux/amd64 -t "$IMAGE" .

echo "▶ 푸시"
docker push "$IMAGE"
echo "✓ 올렸다. EC2에서: bash deploy.sh $TAG"
