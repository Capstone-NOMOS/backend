# NOMOS 서버 이미지. 사용법은 docs/deploy-aws.md.
#
#   docker build -t nomos-server .
#   docker run --rm <env> nomos-server migrate   # 마이그레이션만 돌리고 끝난다
#   docker run      <env> nomos-server           # 서버 (기본 명령)
#
# 마이그레이션은 자동으로 돌리지 않는다. 서버는 기동 시 스키마가 뒤처져 있으면 뜨지 않는다
# (src/config/migrations.ts). deploy.sh가 migrate → server 순서를 지킨다.

# ── 빌드 ─────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── 실행 ─────────────────────────────────────────────────────────────
# 프로덕션 의존성만. tsx·vitest·typescript는 들어가지 않는다.
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# boot.js migrate가 읽는다. 서버의 기동 검사도 이 목록과 DB를 비교한다.
COPY migrations ./migrations
# Swagger(DOCS_ENABLED=true일 때)가 읽는다. 손으로 쓴 문서라 빌드 산출물이 아니다.
COPY docs/openapi.yaml ./docs/openapi.yaml

# RDS PostgreSQL 15+는 SSL을 강제한다. DATABASE_URL에 sslmode=verify-full을 쓰려면 Amazon RDS CA가
# Node 신뢰 저장소에 있어야 한다 — 없으면 "self-signed certificate in certificate chain"으로 연결이 끊긴다.
# 검증을 끄는(sslmode=no-verify) 대신 CA를 넣는다. ADD로 받은 파일은 기본 600이라 node 사용자가 못 읽으므로 644.
# 디렉터리를 먼저 만든다 — ADD --chmod는 새로 만드는 부모 디렉터리에도 같은 모드(644, 실행 비트 없음)를
# 적용해서 node 사용자가 디렉터리에 들어가지 못한다(실제로 그렇게 막혔다).
RUN mkdir -p /app/certs
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem

# EC2 부트스트랩용. 서버에 git 배포 키를 두지 않으려고 배포 파일을 이미지에 함께 싣는다
# (docker cp로 꺼낸다 — docs/deploy-aws.md). Windows에서 빌드해도 줄바꿈이 LF가 되게 정리한다.
COPY deploy ./deploy
RUN sed -i 's/\r$//' deploy/*.sh deploy/Caddyfile deploy/*.yml deploy/*.example

# root로 돌지 않는다. node 이미지에 있는 비특권 사용자.
USER node
EXPOSE 3000

# slim 이미지에는 curl이 없다. Node 22의 fetch로 본다. /health는 DB까지 닿는지 확인한다.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "dist/boot.js"]
CMD ["server"]
