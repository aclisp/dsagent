<p align="center">
  <img src="assets/dscode-logo.svg" width="144" alt="DSCode 方块鲸 Logo">
</p>

# DSCode

<p align="center">
  部署在你自己的服务器上的 AI 编程与运维搭档。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="LICENSE">MIT License</a> ·
  <a href="docs/COMPARISON.md">产品对比</a>
</p>

## 为什么选择 DSCode

- **以 DeepSeek 为先，自由切换。** DSCode 为 DeepSeek Flash 配备专用 Responses adapter 和原生
  freeform patch；也可切换到 Codex、OpenAI、Anthropic、OpenRouter、Z.AI、
  Kimi、MiniMax、Grok 或 OpenCode Zen Go，同时沿用原有工具和会话。
- **就在服务器上的 AI 运维搭档。** 将 DSCode 直接安装在你负责的 Linux 服务器上，通过 TUI 检查
  服务与工作区、运行并跟进命令，还能应用可审阅、可撤销的 patch。精简的四工具工作流——`read`、
  `exec_command`、`write_stdin` 和 `apply_patch`——覆盖检查、执行命令、管理运行中的进程和应用 patch。
- **从终端到集成，一个运行时全部打通。** 可在 CLI/TUI 中工作，通过 REST+SSE 嵌入同一套 Core，
  或使用自托管 Web UI。实时的 Agent 与工具动态、交互请求和持久会话，让不同入口都能融入同一套
  工作流。
- **内置企业微信接入，把对话变成实际工作。** 团队成员可以直接私聊，或在群聊中 @机器人，分享上下文
  和支持的媒体，还可安排后续工作并在原对话中接收结果。

DSCode 默认取舍鲜明、核心轻量，并在关键之处保持灵活：你可以选择适合任务的模型，并通过终端、
REST+SSE API、自托管 Web UI 或企业微信使用同一套运行时。

## 快速开始

### 终端应用（CLI/TUI）

运行一键安装脚本。它会把 DSCode 安装到 `~/.local/share/dscode`，完成构建，并在 `~/.local/bin`
创建 `dscode` 启动器。

```bash
curl -fsSL https://raw.githubusercontent.com/aclisp/dsagent/main/scripts/install.sh | sh
```

登录、首次运行及 CLI/运行时说明见[CLI 与运行时参考](docs/CLI_REFERENCE.zh-CN.md)。

### 开发者：从源码构建

```bash
git clone https://github.com/aclisp/dsagent.git
cd dsagent
corepack enable
pnpm install
pnpm check
```

仓库中的 npm 包是私有 workspace 包，目前不会发布到 npm。

## Web UI

DSCode 还内置自托管的 Web 聊天服务器（`packages/web-ui`）。公开的 Docker Hub 镜像
（`docker.io/aclisp/dsagent`）即为该服务器的云部署打包。运行与配置见
[web UI README](packages/web-ui/README.md)；Compose 模板与部署说明见
[deploy/cloud/dscode](deploy/cloud/dscode/README.md)。

## 项目缘起

DSCode 最初 fork 自 [dscode](https://github.com/thinkany-ai/dscode)，目前作为独立项目开发。
上游集成说明见[docs/UPSTREAM.md](docs/UPSTREAM.md)。

## License

[MIT](LICENSE)
