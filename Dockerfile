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
# apt's sandbox drops to the _apt user (setgroups/setegid/seteuid), which fails under
# --cap-drop ALL; pinning the sandbox user to root lets apt run in the locked-down
# running container without opening any capabilities. Tsinghua mirror = faster in CN.
# Disable HTTP pipelining because some Nginx mirrors intermittently reset pipelined connections.
RUN echo 'APT::Sandbox::User "root";' > /etc/apt/apt.conf.d/01sandbox-disable \
    && echo 'Acquire::http::Pipeline-Depth "0";' > /etc/apt/apt.conf.d/99nopipelining \
    && sed -i 's|deb.debian.org/debian|mirrors.tuna.tsinghua.edu.cn/debian|' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep procps \
    && rm -rf /var/cache/apt/archives/* /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
# Bundled skills and prompt files live outside /root/.dscode (a named volume) and are
# seeded by the entrypoint on every start, so existing volumes pick them up without being clobbered.
COPY deploy/docker-entrypoint.sh /usr/local/bin/dscode-entrypoint.sh
COPY deploy/default-skills /usr/local/share/dscode/default-skills
COPY deploy/default-files /usr/local/share/dscode/default-files
RUN chmod +x /usr/local/bin/dscode-entrypoint.sh
EXPOSE 8899
ENTRYPOINT ["/usr/local/bin/dscode-entrypoint.sh"]
CMD ["node", "packages/web-ui/dist/server.js"]
