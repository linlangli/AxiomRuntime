FROM node:22.19.0-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev \
    && node --input-type=module --eval \
        "import Database from 'better-sqlite3'; const db = new Database(':memory:'); db.close();"

FROM node:22.19.0-bookworm-slim AS production
ARG CODEX_VERSION=0.145.0
ARG CLAUDE_CODE_VERSION=2.1.129
ENV NODE_ENV=production \
    AI_GATEWAY_HOME=/var/lib/ai-gateway \
    AI_GATEWAY_SERVER_HOST=0.0.0.0 \
    AI_GATEWAY_SERVER_PORT=8080
WORKDIR /app
RUN groupadd --gid 10001 ai-runtime \
    && useradd --uid 10001 --gid 10001 --home-dir /var/lib/ai-gateway --create-home ai-runtime
RUN npm install --global --no-audit --no-fund \
    "@openai/codex@${CODEX_VERSION}" \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER 10001:10001
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/server/index.js"]
