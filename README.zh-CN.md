<p align="center">
  <img src="assets/dscode-logo.svg" width="144" alt="DSCode 方块鲸 Logo">
</p>

# DSCode

<p align="center">
  基于 Pi 深度定制的编程智能体。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="LICENSE">MIT License</a> ·
  <a href="docs/COMPARISON.md">产品对比</a>
</p>

## 为什么选择 DSCode

- **可审查、可掌控的 Agent harness。** DSCode 是开源的 Agent harness：你可以审查和修改提示词、
  工具、权限与运行时行为，使用自己选择的 LLM API，无需依赖由模型提供商掌控的 Agent harness。
- **企业微信中的个人与团队 Agent。** 私聊 DSCode 或在群聊中 @它，交办任务、交换文件并安排周期性工作。

## DSCode 对 Pi 的增强与定制

- **权限与沙箱：** `ask`、`auto`、`full` 权限模式控制审批，命令沙箱与网络设置分别控制执行边界；
  `auto` 模式下，潜在破坏性命令需要审批。
- **长任务与进程管理：** 通过 `exec_command` 和 `write_stdin` 启动、查看、交互和终止托管进程。
- **修改检查点与撤销：** `apply_patch` 支持增加、修改、删除和移动文件，为成功的补丁保存检查点；
  `/undo` 恢复前会检查冲突。
- **DeepSeek 与图片适配：** 使用官方 `deepseek-flash` Responses 接口时，可通过 `file_id` 复用
  已上传的图片，避免重复发送图片内容。
- **联网研究：** 配置 DeepSeek 凭据并允许联网后，所有聊天模型供应商均可按需使用基于 DeepSeek 的
  `web_search` 和 `web_fetch`。
- **共享运行时：** CLI/TUI、REST+SSE API 和 Web UI 共用 Core 运行时，提供 Agent 实时活动以及
  交互式确认和选项选择。
- **交互与诊断：** 全屏 TUI 将已完成的执行过程分组折叠；`/status` 和 `/doctor` 提供运行状态信息。

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

使用 Node.js 26.x 和 pnpm 12.x。

```bash
git clone https://github.com/aclisp/dsagent.git
cd dsagent
npm install --global pnpm@12
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
