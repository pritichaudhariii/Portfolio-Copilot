# Build context: repository root
#   docker build -f apps/web/Dockerfile -t portfolio-web .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/mcp-server/package.json packages/mcp-server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace=@portfolio-copilot/web --include-workspace-root=false
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT_STANDALONE=1
RUN npm run build --workspace=@portfolio-copilot/web

FROM node:22-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
# Standalone output includes a pruned node_modules and the workspace layout.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
