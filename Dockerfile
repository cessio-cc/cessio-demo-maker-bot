# syntax=docker/dockerfile:1.7

# Node 24 executes the TypeScript sources natively (strip-only mode), so there
# is no build step. The only runtime dependency is `ws` (the maker stream
# authenticates via upgrade headers, which the built-in WebSocket cannot send).
FROM node:24-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src src
# Pre-create the state mountpoint owned by node: a fresh named volume inherits
# this ownership, so the identity file is writable without running as root.
RUN mkdir /data && chown -R node:node /data /app

USER node
ENV BOT_STATE_FILE=/data/identity.json
CMD ["node", "src/index.ts"]
