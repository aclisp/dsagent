<p align="center">
  <img src="assets/dscode-logo.svg" width="144" alt="DSCode 方块鲸 Logo">
</p>

# DSCode

<p align="center">
  基于 Pi 深度定制的编程智能体，也是 Linux 服务器运维助手。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="LICENSE">MIT License</a> ·
  <a href="docs/COMPARISON.md">产品对比</a>
</p>

## 为什么选择 DSCode

- **在自己掌控的基础设施上运行编程智能体。** 将 DSCode 部署在你的 Linux 服务器上，通过 SSH
  管理项目：检查服务、运行命令并查看输出，还可审阅或撤销文件变更。
- **一个运行时，多种使用方式。** 选择你习惯的入口：CLI/TUI、REST+SSE API 或 Web UI。三种入口
  共用同一套 Core，均可查看 Agent 实时活动，也可按提示确认操作或选择选项。
- **把团队聊天接入工作流。** 在企业微信中，团队成员可以直接私聊 DSCode，或在群聊中 @它来交办任务、
  发送图片和文件，并接收回复和生成的文件。他们还可以让 DSCode 安排一次性或周期性任务；DSCode
  会把每次结果发送回提出任务的会话。

## 快速开始

### 独立可执行文件（推荐）

推荐新用户下载独立可执行文件，无需安装 Node.js、Bun、包管理器，也无需从源码构建。

1. 打开 [GitHub Releases](https://github.com/aclisp/dsagent/releases)，在 **Assets** 中下载适合你电脑的压缩包：

   | 电脑 | 下载文件 |
   | --- | --- |
   | Apple Silicon Mac（M1 或更新芯片） | `dscode-v<version>-darwin-arm64.tar.gz` |
   | Linux x86_64 / AMD64 | `dscode-v<version>-linux-x64.tar.gz` |

2. 解压压缩包，在解压后的文件夹中打开终端。
3. 启动 DSCode：

```bash
./dscode
```

运行时只需要 `dscode` 这一个可执行文件，可以将它移动到任意文件夹。随附的 `dscode.sha256`
是校验和文件。独立可执行文件目前支持上表中的两个平台。macOS 版本尚未公证，系统可能要求你在
**系统设置 → 隐私与安全性** 中允许打开。

登录、首次运行及 CLI/运行时说明见[CLI 与运行时参考](docs/CLI_REFERENCE.zh-CN.md)。

### 一键安装脚本

也可以运行一键安装脚本。它会把 DSCode 安装到 `~/.local/share/dscode`，完成构建，并在
`~/.local/bin` 创建 `dscode` 启动器。

```bash
curl -fsSL https://raw.githubusercontent.com/aclisp/dsagent/main/scripts/install.sh | sh
```

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
