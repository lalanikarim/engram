# pi-durable project-brain agent (Week 1 MVP core).
# Node 24 runs the TypeScript sources natively (type stripping) — no build step, no native deps.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY roles.json tools.json ./
COPY kb ./kb

# Storage and workspaces are volumes; the API binds to the LAN with bearer-token auth.
ENV DATA_DIR=/data \
    WORK_ROOT=/work \
    KB_DIR=/kb \
    CONFIG_DIR=/app \
    HOST=0.0.0.0 \
    PORT=8791

EXPOSE 8791
VOLUME ["/data", "/work", "/kb"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- --header="Authorization: Bearer $API_TOKEN" "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "src/main.ts"]
