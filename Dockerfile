FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS production
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
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER 10001:10001
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/server/index.js"]
