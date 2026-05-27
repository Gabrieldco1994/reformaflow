# ---- Builder ----
FROM node:20-bookworm-slim AS builder

WORKDIR /repo

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy manifests and lock first for better caching
COPY package.json package-lock.json* turbo.json tsconfig*.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/

# Workspaces install (full, we need devDeps for build)
RUN npm ci --no-audit --no-fund --include=dev

# Now copy the rest of the sources we need
COPY prisma ./prisma
COPY packages/domain ./packages/domain
COPY apps/api ./apps/api

# Build domain first (referenced by api at runtime via path mapping/transpile)
RUN npm --workspace @reformaflow/domain run build

# Generate Prisma client (sqlite) and build NestJS
RUN npx prisma generate --schema=prisma/schema.prisma
RUN npm --workspace @reformaflow/api run build


# ---- Runtime ----
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    DATABASE_URL="file:/data/dev.db" \
    UPLOADS_DIR=/data/uploads

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Copy only what's needed for runtime
COPY --from=builder /repo/package.json /repo/package-lock.json* ./
COPY --from=builder /repo/apps/api/package.json apps/api/package.json
COPY --from=builder /repo/apps/api/dist apps/api/dist
COPY --from=builder /repo/packages/domain/package.json packages/domain/package.json
COPY --from=builder /repo/packages/domain/dist packages/domain/dist
COPY --from=builder /repo/prisma prisma

# Install ONLY production deps for api workspace
RUN npm ci --omit=dev --no-audit --no-fund --workspaces --include-workspace-root \
    --workspace @reformaflow/api \
    --workspace @reformaflow/domain \
  && npx prisma generate --schema=prisma/schema.prisma \
  && npm cache clean --force

# Entrypoint: ensure data dir exists, run migrations, then start
RUN printf '#!/bin/sh\nset -e\nmkdir -p /data/uploads\nnpx prisma migrate deploy --schema=prisma/schema.prisma\nexec node apps/api/dist/main.js\n' > /entrypoint.sh \
  && chmod +x /entrypoint.sh

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3001/api/docs-json || exit 1

CMD ["/entrypoint.sh"]
