# DSCode Cloud Deployment

This directory records the bind-mounted Docker Compose layout used by the cloud
deployment. The Compose file is safe to commit: it contains variable references,
not concrete credentials. Secrets, persistent state, user files, generated asset
copies, and external binaries are excluded by the local `.gitignore`.

The deployment intentionally gives one full-access agent control of one writable
workspace. Treat the workspace URL and all writable bind mounts as sensitive.

## Repository and server files

The repository stores only the deployment definition:

```text
deploy/cloud/dscode/
├── .gitignore
├── README.md
└── docker/
    └── docker-compose.yml
```

Provision the following adjacent files and directories on the server before
starting the container:

```text
deploy/cloud/dscode/
├── bin/                    # externally provisioned binaries for optional skills
├── default-files/
│   ├── AGENTS.md
│   └── APPEND_SYSTEM.md
├── docker/
│   ├── .env
│   └── docker-compose.yml
├── home/                  # persistent /root/.dscode
├── home-config/           # persistent /root/.config
├── locked-workspace-pi/   # protected /workspace/.pi
├── models.json
├── prompt-profiles/
│   └── <profile>/
│       ├── SYSTEM.md
│       └── favicon.png
└── workspace/             # persistent agent workspace
```

All relative bind paths in `docker/docker-compose.yml` are resolved from the
`docker/` directory. Each source must exist because every bind mount sets
`create_host_path: false`.

## 1. Select the image

The deployment template defaults to the public full image for the current
release:

```text
docker.io/aclisp/dsagent:0.9.4
```

For a reproducible rollback, set `DSCODE_IMAGE` to an immutable release tag or
image digest in `docker/.env`. The lean image is available as
`docker.io/aclisp/dsagent:0.9.4-lean`, but the full image is the product default.

Maintainers who need to build locally can run these commands from the
repository root. The tool image is derived from the lean image, so the order
matters:

```sh
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker build -t dscode-server:lean .
docker build -f deploy/tools.Dockerfile --build-arg LEAN_IMAGE=dscode-server:lean -t dscode-server .
```

The build defaults use Debian's public CDN, which is also used by GitHub Actions.
For a local build from mainland China, configure the lean image with the faster
Tsinghua mirror and the connection workaround before building the derived image:

```sh
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker build \
  --build-arg DSCODE_APT_MIRROR=mirrors.tuna.tsinghua.edu.cn \
  --build-arg DSCODE_APT_PIPELINE_DEPTH=0 \
  -t dscode-server:lean .
docker build -f deploy/tools.Dockerfile --build-arg LEAN_IMAGE=dscode-server:lean -t dscode-server .
```

When the container starts, `deploy/docker-entrypoint.sh` switches runtime APT
to the Tsinghua mirror and keeps `Pipeline-Depth=0` by default. Override
`DSCODE_RUNTIME_APT_MIRROR` or `DSCODE_RUNTIME_APT_PIPELINE_DEPTH` when a
different runtime network is preferred. The entrypoint does not run
`apt-get update` during startup.

`DOCKER_DEFAULT_PLATFORM` is only needed when building the AMD64 image on a host
with a different architecture. On an AMD64 server, a normal `docker build` is
sufficient.

## 2. Provision the server layout

From `deploy/cloud/dscode`, create the writable directories and copy the
version-controlled prompt assets into the deployment layout:

```sh
mkdir -p home home-config workspace bin prompt-profiles default-files locked-workspace-pi
cp -a ../../prompt-profiles/. prompt-profiles/
cp -a ../../default-files/. default-files/
cp -a ../../locked-workspace-pi/. locked-workspace-pi/
cp ../../models.json.example models.json
```

Edit `models.json` for the deployed models. The model selected by `VISION_MODEL`
(exported to the container as `DSCODE_VISION_MODEL`) must declare both text and
image input.

Repeat the three asset-copy commands after changing the canonical prompt files
or adding a product profile under `deploy/`.

The `bin/` directory is reserved for externally provisioned binaries used by
optional skills. Keep those files outside Git and provision them separately on
the deployment host.

The container runs as UID 0 with all Linux capabilities dropped. UID 0 must
therefore have ordinary filesystem permission to write the three persistent
directories; it cannot rely on `CAP_DAC_OVERRIDE` to bypass host permissions.
A restrictive server-side setup is:

```sh
sudo chown -R 0:0 home home-config workspace
sudo chmod -R u+rwX,go-rwx home home-config workspace
```

Use a shared group or host ACL instead if a non-root host account must edit these
directories directly.

## 3. Create the environment file

Create `docker/.env` with permissions that prevent other host users from reading
it:

```sh
touch docker/.env
chmod 0600 docker/.env
```

Use the following structure and replace every placeholder:

```dotenv
DSCODE_INSTANCE_NAME=dscode
DSCODE_IMAGE=docker.io/aclisp/dsagent:0.9.4
DSCODE_HOST_PORT=<host-port>

WORKSPACE_ID=<random-high-entropy-id>
TZ=Asia/Shanghai
OPENROUTER_API_KEY=<openrouter-api-key>
MODEL=<openrouter-model-id>
VISION_MODEL=<vision-capable-openrouter-model-id>

DSCODE_PROMPT_PROFILE=<profile-directory-name>
CHAT_AGENT_NAME=<display-name>

# Optional WeCom smart-bot provider (the three required values enable it)
# IM_WECOM_BOT_ID=<wecom-bot-id>
# IM_WECOM_SECRET=<wecom-bot-secret>
# IM_WECOM_BOT_NAME=<display-name-used-in-@-mentions>
# IM_WECOM_WS_URL=wss://openws.work.weixin.qq.com
```

Generate a suitable workspace ID with:

```sh
openssl rand -hex 16
```

The workspace ID is a bearer credential embedded in the chat URL. Anyone who
knows it can reach the full-access agent, so distribute it only through a trusted
channel.

`TZ` must be an explicit valid IANA timezone. It controls recurring schedules and is required even
when no tasks currently exist; changing it changes the wall-clock interpretation of every Cron
task.

When the three required `IM_WECOM_*` values are present, the container opens the WeCom smart-bot
WebSocket long connection. `IM_WECOM_SECRET` is a credential and must
be kept in the private `docker/.env` file; `IM_WECOM_BOT_NAME` is the exact display name used to
find and remove the `@BOT_NAME` mention from group messages. Direct messages do not require a mention.

## 4. Start or update the service

Run Compose from its own directory so it automatically loads `docker/.env`:

```sh
cd deploy/cloud/dscode/docker
docker compose config --quiet
docker compose up -d
docker compose ps
```

After changing `DSCODE_IMAGE` or rebuilding `dscode-server`, run `docker compose up -d`
again to recreate the container from the selected image. To stop and remove only
the container and network:

```sh
docker compose down
```

The persistent data remains in the bind-mounted host directories.

## 5. Reverse proxy and network exposure

The current Compose archive publishes `${DSCODE_HOST_PORT}` on every host
interface. A production firewall must restrict that port. When Nginx is the only
intended entry point, the safer Compose mapping is:

```yaml
ports:
  - "127.0.0.1:${DSCODE_HOST_PORT:?set DSCODE_HOST_PORT in .env}:8899"
```

The Nginx upstream should point to `127.0.0.1:<host-port>`, terminate TLS, accept
the configured upload size, and disable proxy buffering for SSE responses. Keep
a long `proxy_read_timeout` so idle chat streams are not closed prematurely.

The user-facing chat URL is:

```text
https://<public-host>/chat/<WORKSPACE_ID>
```

## Backups and security notes

Back up `home/`, `home-config/`, and `workspace/` as persistent runtime state.
Store `docker/.env` and `models.json` in a separate secret backup. The copied
prompt assets can be restored from their canonical versions under `deploy/`.

The agent runs with `--permission full`, network access, and
`danger-full-access` inside the container. `cap_drop: ALL`,
`no-new-privileges`, protected read-only prompt mounts, and host directory
permissions are therefore part of the deployment boundary. Do not mount any
additional host path unless the agent is intended to read and modify it.
