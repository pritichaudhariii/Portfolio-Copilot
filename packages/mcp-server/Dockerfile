# Build context: repository root
#   docker build -f packages/mcp-server/Dockerfile -t portfolio-mcp .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/mcp-server/package.json packages/mcp-server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace=@portfolio-copilot/mcp-server --include-workspace-root=false
COPY packages/mcp-server packages/mcp-server
RUN npm run build --workspace=@portfolio-copilot/mcp-server

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/mcp-server/package.json packages/mcp-server/package.json
RUN npm ci --omit=dev --workspace=@portfolio-copilot/mcp-server --include-workspace-root=false \
    && npm cache clean --force
COPY --from=build /repo/packages/mcp-server/dist packages/mcp-server/dist
COPY packages/mcp-server/data/seed packages/mcp-server/data/seed
RUN mkdir -p /data && chown -R node:node /data /repo
USER node
ENV PORT=3001 DATA_DIR=/data
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "packages/mcp-server/dist/index.js", "--http"]
