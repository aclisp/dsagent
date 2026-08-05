# DSCode chat server — lean image (Node + app only).
# Build the derived image with the office/PDF tools on the live env server:
#   docker build -f deploy/tools.Dockerfile -t dscode-server .
FROM node:22 AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
# The root postinstall references scripts/postinstall.mjs.
COPY scripts ./scripts
COPY packages ./packages
RUN pnpm install --frozen-lockfile
# Build web-ui and its workspace deps (core, http-adapter) in topological order.
RUN pnpm --filter @thinkany/dscode-web-ui... build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV HOST=0.0.0.0 PORT=8899

# Lean image: only what the agent needs to run. Office/PDF tools are added by the
# derived image deploy/tools.Dockerfile on the live env server, so the distributed
# artifact stays small.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
EXPOSE 8899
CMD ["node", "packages/web-ui/dist/server.js"]