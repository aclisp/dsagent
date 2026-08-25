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
COPY src ./src
RUN pnpm install --frozen-lockfile
# Build all server packages, the bundled web server, and the standalone vision CLI.
RUN pnpm build

FROM node:22 AS prod-deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
COPY packages/core/package.json packages/core/package.json
COPY packages/http-adapter/package.json packages/http-adapter/package.json
COPY packages/chat-client/package.json packages/chat-client/package.json
COPY packages/wecom/package.json packages/wecom/package.json
COPY packages/web-ui/package.json packages/web-ui/package.json
RUN pnpm install --prod --frozen-lockfile

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV HOST=0.0.0.0 PORT=8899

# Lean image: only what the agent needs to run. Office/PDF tools are added by the
# derived image deploy/tools.Dockerfile on the live env server, so the distributed
# artifact stays small.
# apt's sandbox drops to the _apt user (setgroups/setegid/seteuid), which fails under
# --cap-drop ALL; pinning the sandbox user to root lets apt run in the locked-down
# running container without opening any capabilities. Tsinghua mirror = faster in CN.
# Retry transient mirror failures, and disable HTTP pipelining because some Nginx
# mirrors intermittently reset pipelined connections.
RUN echo 'APT::Sandbox::User "root";' > /etc/apt/apt.conf.d/01sandbox-disable \
    && echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries \
    && echo 'Acquire::http::Pipeline-Depth "0";' > /etc/apt/apt.conf.d/99nopipelining \
    && sed -i 's|deb.debian.org/debian|mirrors.tuna.tsinghua.edu.cn/debian|' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep procps \
    && rm -rf /var/cache/apt/archives/* /var/lib/apt/lists/*

# The runtime contains only the bundled server, standalone discovery command, and vision CLI,
# public static assets, package metadata needed by Node's resolver, and production dependencies.
# Source, tests, declarations, and source maps never cross into this stage.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/wecom/node_modules ./packages/wecom/node_modules
COPY --from=prod-deps /app/packages/web-ui/node_modules ./packages/web-ui/node_modules
COPY --from=build /app/packages/wecom/package.json ./packages/wecom/package.json
COPY --from=build /app/packages/wecom/dist/wecom-discover.js ./packages/wecom/dist/wecom-discover.js
COPY --from=build /app/packages/web-ui/package.json ./packages/web-ui/package.json
COPY --from=build /app/packages/web-ui/dist/server.js ./packages/web-ui/dist/server.js
COPY --from=build /app/packages/web-ui/static ./packages/web-ui/static
COPY --from=build /app/dist/vision-cli.js ./dist/vision-cli.js
RUN chmod 0555 /app/dist/vision-cli.js \
    && ln -s /app/dist/vision-cli.js /usr/local/bin/dscode-vision
# Bundled skills and prompt files live outside /root/.dscode (a named volume) and are
# seeded by the entrypoint on every start, so existing volumes pick them up without being clobbered.
COPY deploy/docker-entrypoint.sh /usr/local/bin/dscode-entrypoint.sh
COPY deploy/default-skills /usr/local/share/dscode/default-skills
COPY deploy/default-files /usr/local/share/dscode/default-files
RUN chmod +x /usr/local/bin/dscode-entrypoint.sh
EXPOSE 8899
ENTRYPOINT ["/usr/local/bin/dscode-entrypoint.sh"]
CMD ["node", "packages/web-ui/dist/server.js"]
