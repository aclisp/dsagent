<p align="center">
  <img src="assets/dscode-logo.svg" width="144" alt="DSCode block-whale logo">
</p>

# DSCode

[English](README.md) | 简体中文

DSCode 是面向本地仓库的 DeepSeek V4 Flash coding agent。它把 Pi 的成熟 TUI、树形会话和扩展体系，
与 V4 Flash 的 Responses API、1M 上下文、`max` 推理、原生 `apply_patch` 和低成本并行能力组合
在一起。

当前 `0.3.0` 已经不是简单聊天壳，而是一套完整 coding-agent runtime：

- 多行编辑、输入历史、排队/打断、工具折叠、思考折叠、实时工具输出和状态栏；
- 自动保存、resume、命名、fork、tree、compact、导入导出；
- 原子多文件 patch、逐文件审批、持久 checkpoint、冲突保护 `/undo` 和 transcript diff；
- `plan`、`ask`、`auto`、`full` 权限策略，以及独立的 OS sandbox 与默认禁网；
- `AGENTS.md`/`CLAUDE.md`、Agent Skills、hooks、MCP、项目 trust；
- 可重连后台命令、JSONL/CI、完整 RPC、VS Code 入口和语言诊断；
- explorer / implementer / reviewer / tester 多 agent，最多四路并行，implementer 使用独立 Git
  worktree；
- DeepSeek Responses 无状态回放、自动前缀缓存友好的稳定 prompt、`low/high/max` thinking 和服务端
  Web Search。

完整产品取舍与竞争优势见 [产品策略](docs/PRODUCT_STRATEGY.md)。
与 Claude Code / Codex 的逐项对比见 [对比文档](docs/COMPARISON.md)
（[English](docs/COMPARISON.en.md)）。

## 安装

普通用户要求 Node.js 22.19+ 和 `rg`。macOS 直接使用 Seatbelt 沙箱；Linux/Windows 的隔离执行需要
Docker，并设置可信镜像。

### 方式一：curl 一键安装（自动获取依赖）

用类似 Claude Code 的 curl 管道方式安装（自动检测 Node、通过 corepack 准备 pnpm、用 Homebrew
补装 ripgrep，源码装到 `~/.local/share/dscode`，`dscode` 命令装到 `~/.local/bin`）：

```bash
curl -fsSL https://raw.githubusercontent.com/thinkany/dscode/main/scripts/install.sh | sh
```

只要求已有 Node.js 22.19+ 和 `git`；脚本会顺带准备 pnpm 和 ripgrep。卸载：

```bash
rm -rf ~/.local/share/dscode ~/.local/bin/dscode
```

### 方式二：npm 全局安装

```bash
npm install -g @thinkany/dscode
dscode -C /path/to/project
```

### 首次启动与密钥

第一次启动会自动引导输入 DeepSeek API key：输入内容只显示圆点，DSCode 使用官方 `/models`
接口验证后，保存到 `~/.dscode/agent/auth.json`，文件权限为 `0600`。也可以提前配置：

```bash
# 推荐：安全输入、在线验证并保存
dscode login

# 或者仅对当前 shell 生效；不会写入磁盘
export DEEPSEEK_API_KEY="sk-..."
```

进入 TUI 后可用 `/login`（兼容 `/login deepseek`）直接替换 DeepSeek API key；不会显示 Pi 的其他
provider 或账号登录入口，输入和提交记录同样会被遮罩。`dscode auth status`
只显示配置来源，不显示密钥；`dscode logout` 删除本地保存的凭据。

从源码开发或本地验证：

```bash
# 首次安装并构建
pnpm install
pnpm build

# 运行上一次 build 的产物
pnpm start

# 传参数时，pnpm 会把参数直接转发给 DSCode；不要再插入单独的 `--`
pnpm start -C /path/to/project

# 直接运行最新源码，改代码后无需先 build
pnpm dev -C /path/to/project

# 发布前完整检查
pnpm check
```

## 最常用的启动方式

```bash
# 新的交互会话
dscode -C ./my-project

# 继续当前工作区最近的会话
dscode -C ./my-project --continue

# 选择、命名或 fork 会话
dscode -C ./my-project --resume
dscode -C ./my-project --name "fix auth race"
dscode -C ./my-project --fork <session-id>

# 一次性输出 / JSONL CI / IDE RPC
dscode -C ./my-project -p "解释认证流程"
dscode -C ./my-project --mode json -p "修复 lint 并运行测试"
dscode -C ./my-project --mode rpc
```

默认配置是：

```text
model       deepseek-v4-flash
transport   responses
thinking    max
harness     minimal
permission  auto
sandbox     workspace-write
network     blocked
```

`minimal` 只给 V4 Flash 暴露高杠杆工具：沙箱命令、后台进程交互、freeform patch 和并行
delegation。`--harness safe` 额外提供文件读取、文件搜索和自动语言诊断，适合更强审计需求。

## 交互体验

新会话会显示使用 DeepSeek 蓝（`#4E6BFE`）的方块鲸 Logo 和 DSCode 欢迎卡。终端中会自动使用同轮廓的像素字符版；输入区采用无边框面板和原生闪烁块状光标，空输入时光标覆盖占位文字的首字符。默认状态行只保留模型、
thinking effort 和当前目录；权限放大或上下文超过 70% 时才追加警示。累计 token、
缓存命中率和费用不常驻占空间，需要时用 `/status` 查看。

在输入框键入 `/` 可查看全部命令，`/hotkeys` 可查看快捷键。常用操作：

| 操作 | 作用 |
| --- | --- |
| `Enter` / `Alt+Enter` | 工作中追加 steering / follow-up 消息 |
| `Escape` | 中断当前执行 |
| `quit` / `exit` / `退出` / `/quit` / `Ctrl+D` | 不调用模型，直接安全退出 DSCode |
| `Ctrl+O` / `Ctrl+T` | 折叠工具输出 / 思考内容 |
| `Ctrl+G` | 使用外部编辑器编辑长 prompt |
| `Shift+Tab` | 切换 thinking level |
| `/resume` `/name` `/fork` `/tree` | 恢复、命名、分支和时间线导航 |
| `/compact [prompt]` | 手动压缩上下文 |
| `/status` | 查看模型、权限、上下文、缓存命中、token、费用和会话信息 |
| `/session` | 查看 Pi 的底层会话统计与会话文件 |
| `/plan` `/permissions` | 切换结构化规划模式或权限策略；`/plan show` 查看当前计划 |
| `/effort low\|high\|max` | 切换 DeepSeek thinking effort |
| `/diff` `/checkpoints` `/undo` | 查看改动、checkpoint 和安全撤销 |
| `/jobs` | 查看仍在运行或等待收取结果的后台命令 |
| `/mcp` `/agents` `/doctor` | 查看扩展、子 agent 和运行诊断 |

`apply_patch` 成功后会立即生成持久 checkpoint。`/undo` 只在文件仍与 checkpoint 的 after
快照一致时恢复；如果用户随后改过文件，会拒绝覆盖。确认确实要覆盖时才使用 `/undo --force`。

`/plan` 会进入真正的只读规划模式。模型完成仓库调查后必须调用 `update_plan`，TUI 会显示
`pending / in_progress / completed` 步骤卡片，并让用户选择“执行计划 / 保持规划 / 继续细化”。
执行时写工具和原权限恢复，计划状态会随验证结果更新并随会话持久化；`/plan clear` 可清空它。

## 权限与沙箱不是一回事

权限决定“是否需要人批准”，沙箱决定“即使批准后，进程实际能访问什么”。

| 权限 | 行为 |
| --- | --- |
| `plan` | 隐藏写入、delegate 和 MCP；命令强制降为只读 sandbox |
| `ask` | 读取自动；命令、delegate、MCP 和写入要确认；patch 按文件逐一 review |
| `auto` | 工作区 patch 和沙箱命令自动；外部 MCP 仍确认 |
| `full` | 不弹审批；不会自动关闭 OS sandbox |

| sandbox | 行为 |
| --- | --- |
| `read-only` | 命令不能写文件 |
| `workspace-write` | 只能写工作区、系统临时目录和必要设备；默认值 |
| `danger-full-access` | 使用当前用户的宿主机权限，仅用于可信环境 |

命令和 `!` 用户 shell 默认禁网；显式传 `--network` 才开放。`DEEPSEEK_API_KEY` 会从命令、
hooks 和 MCP stdio 子进程的默认环境删除。模型 API 和显式配置的远程 MCP transport 不受命令
沙箱网络规则约束。

macOS 使用系统 Seatbelt。其他平台设置 Docker 后端：

```bash
export DSCODE_SANDBOX_IMAGE="your-reviewed-image:tag"
dscode -C ./project --sandbox workspace-write
```

如果没有可用后端，DSCode 会 fail closed，不会悄悄退化为宿主机执行。

## 项目规则与 Skills

Pi 会分层读取当前目录及父目录中的 `AGENTS.md` 或 `CLAUDE.md`。DSCode 还要求 agent 在修改
更深目录前发现并遵守更具体的嵌套规则。

Skills 可放在：

```text
~/.dscode/agent/skills/
~/.agents/skills/
<project>/.pi/skills/
<project>/.agents/skills/
```

使用 `/skill:name` 显式调用，或让模型按描述自动加载。项目 skills、settings、extensions、hooks
和 MCP 只应在信任仓库后启用；交互模式使用 `/trust`，非交互模式显式传 `--approve`。

## Hooks

全局配置在 `~/.dscode/hooks.json`，可信项目配置在 `.dscode/hooks.json`。项目配置追加到全局配置：

```json
{
  "hooks": {
    "sessionStart": [
      { "command": "node", "args": ["scripts/session-start.mjs", "{cwd}"] }
    ],
    "beforeTool": [
      { "command": "node", "args": ["scripts/policy.mjs", "{tool}", "{payload}"] }
    ],
    "afterTool": [],
    "agentEnd": []
  }
}
```

`beforeTool` 非零退出会阻止工具。可用占位符为 `{cwd}`、`{tool}`、`{payload}`。Hook 同样运行在
所选 OS sandbox 内并遵守 `--network`。

## MCP

全局配置在 `~/.dscode/mcp.json`，可信项目配置在 `.dscode/mcp.json`：

```json
{
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["./tools/mcp-server.mjs"],
      "env": { "TOKEN": "${MY_MCP_TOKEN}" }
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_MCP_TOKEN}" }
    }
  }
}
```

工具会注册为 `mcp__<server>__<tool>`。使用 `/mcp` 查看连接与错误。`auto` 和 `ask` 模式下，
每次外部 MCP 调用都需要批准；无 UI 的自动化若需要 MCP，应在可信环境明确使用 `full`。

## 多 agent 与后台任务

模型可通过 `delegate` 一次运行最多八个任务，同时最多四个：

- `explorer`：只读仓库调查；
- `reviewer`：只读独立审查；
- `tester`：沙箱化测试和故障诊断；
- `implementer`：从当前 `HEAD` 创建 detached worktree，返回候选 diff。

主 agent 始终负责集成和最终验证。Implementer worktree 默认保留，输出中会给出路径，避免在用户
尚未 review 时自动删除或合并。

`exec_command` 在 10 秒后仍未结束会返回 `process_id`，模型可用 `write_stdin` 轮询、输入或终止；
`/jobs` 显示当前 registry。

## IDE 与自动化

VS Code 扩展位于 [editors/vscode](editors/vscode/README.md)，支持打开集成 TUI、发送当前选区和
把 VS Code language diagnostics 交给 agent 修复。`safe` harness 的
`language_diagnostics` 还会自动发现本地已安装的 TypeScript、Pyright、Rust、Go 和 Swift checker。

更深的 IDE 集成使用：

```bash
dscode -C ./project --mode rpc
```

RPC 是 stdin/stdout JSONL，支持流式事件、状态查询、prompt/steer/follow-up、会话操作、模型和
thinking 切换、扩展 UI 审批。普通 CI 使用 `--mode json --print --no-session`，需要项目资源时加
`--approve`。

## 怎么验收

不消耗模型额度的发布检查：

```bash
pnpm check
```

它会执行类型检查、完整测试套件和生产构建；其中包括真实 Pi JSONL 启动、模拟 DeepSeek Responses
SSE、请求 payload 检查、Seatbelt 写入边界、checkpoint 冲突保护和后台任务重连。

使用真实 DeepSeek API 做完整“发现规则 → 修改 → 跑测试 → 验证”：

```bash
export DEEPSEEK_API_KEY="sk-..."
pnpm smoke:live
```

失败时临时 fixture 会保留并打印路径；成功后默认清理。设置 `DSCODE_KEEP_SMOKE=1` 可始终保留。

发布前的真实 API 全量验收还会验证会话命名/恢复、模型驱动 MCP、密钥隔离，以及 explorer +
implementer 并行 delegation 和独立 Git worktree：

```bash
pnpm acceptance:live
```

`features:live` 可只运行上述真实功能验收；完整 TUI 仍建议在 PTY 中人工确认输入、流式渲染、
状态栏、审批弹窗、工具/思考折叠和退出行为。

人工验收建议在一个干净 Git 仓库依次测试：

```text
1. /plan 后要求修改文件，确认出现 Updated Plan 卡片、写工具不可用，并选择 Execute the plan
2. 执行过程中确认只有一个 in_progress，验证通过后步骤才变为 completed
3. /diff、/checkpoints、/undo，随后手改文件再验证冲突保护
4. 运行超过 10 秒的测试并观察 process_id、/jobs、write_stdin
5. /name、退出、--continue、/fork、/tree、/compact
6. 配置一个 MCP 和 hook，分别测试 trusted / untrusted 项目
7. 让 explorer、reviewer、tester、implementer 并行处理独立任务
8. 用 --mode json 跑 CI，再用 --mode rpc 接一个最小客户端
```

## 打包与发布

包名和 CLI 入口已经配置为 `@thinkany/dscode` / `dscode`。发布账号需要拥有 npm 的 `thinkany`
scope，然后执行：

```bash
pnpm check
npm pack --dry-run
npm publish --access public
```

`prepack` 会重新构建 `dist`，`prepublishOnly` 会阻止测试或类型检查失败的版本发布。发布后可在一个
干净目录验证 `npm install -g @thinkany/dscode`、`dscode --version`、`dscode login` 和首次启动引导。

## V4 Flash 专用适配

- Responses API 无状态：完整会话、reasoning item 和工具结果由本地 JSONL 树回放；
- system prompt、工具顺序和工程约定保持稳定，尽量提高 DeepSeek 自动前缀缓存命中；
- thinking 开启时移除无效 `temperature`/`top_p`，默认 `max`，也可切换 `low/high`；
- 去掉 DeepSeek 不支持的 OpenAI store、cache retention 和 include 语义；
- `apply_patch` 使用 V4 Flash 的 freeform custom-tool 形态，避免大 patch JSON 转义；
- 1M context 仍按“先 rg 定位、再定点读取、接近预算时 compact”使用，而不是盲目灌入仓库；
- `--web` 加入 DeepSeek 服务端 Web Search；它适合需要最新资料的任务，不代替本地代码搜索。

## 已知边界

- V4 Flash Responses 当前是文本输入，图片任务需要外部视觉工具或 MCP；
- `danger-full-access`、项目 extensions 和用户安装的 skills 本质上可执行任意代码；
- Docker 后端的工具链取决于你选择的镜像；
- VS Code 扩展是本地薄集成，尚未发布到 Marketplace；
- “和 Claude Code/Codex 完美对齐”只能通过你们真实任务集的成功率、耗时、成本和人工接管率证明，
  不能由功能清单证明。仓库已经具备跑这种对比评测所需的 JSONL、隔离和可重复会话基础。
