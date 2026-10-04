# CLI 与运行时参考

## 终端应用

要求 Node.js 22.19+ 和 Git。DSCode 运行时也使用 `rg`。

从本地源码 checkout 启动 DSCode：

```bash
dscode -C /path/to/project
```

全新安装进入 TUI 后输入 `/login` 选择供应商。认证成功后 DSCode 会选择该 provider 的默认模型；
非交互命令和未显式指定 provider 的配置仍默认使用 DeepSeek。

| 供应商 | ID | 认证方式 |
| --- | --- | --- |
| DeepSeek | `deepseek` | API key |
| OpenAI Codex | `openai-codex` | 符合条件的 ChatGPT 套餐（旧版） |
| OpenAI | `openai` | ChatGPT 账号或 API key |
| Anthropic | `anthropic` | Claude 账号或 API key |
| OpenRouter | `openrouter` | OpenRouter 账号或 API key |
| Z.AI Coding Plan | `zai` | API key |
| Kimi For Coding | `kimi-coding` | Kimi Code 账号或 API key |
| MiniMax | `minimax` | API key |
| xAI / Grok | `xai` | Grok/X 账号或 API key |
| OpenCode Zen Go | `opencode-go` | API key |

`/login` 和 `--provider` 也接受 `kimi`、`grok` 这两个易记别名。

配置 DeepSeek 时，DSCode 会遮罩 API key，然后提供可选的 API base URL；直接回车使用
`https://api.deepseek.com`，也可以填写兼容 DeepSeek/OpenAI 的第三方网关。默认优先把凭证保存到
操作系统钥匙串；无 UI 进程或钥匙串不可用时回退到权限为 `0600` 的 `~/.dscode/auth.json`。
endpoint 保存到权限为 `0600` 的 `~/.dscode/config.json`。
优先级为 `--base-url`、`DEEPSEEK_BASE_URL`、本地保存值、DeepSeek 官方地址。如果不希望保存密钥：

```bash
export DEEPSEEK_API_KEY="sk-..."
export DEEPSEEK_BASE_URL="https://api.deepseek.com"
dscode -C /path/to/project
```

也可以在进入 TUI 前完成认证：

```bash
dscode login deepseek      # DeepSeek API key
dscode login openai-codex  # 浏览器 OAuth，ChatGPT 套餐限额（旧版）
dscode login openai        # ChatGPT 账号（浏览器 OAuth）或 OpenAI API key
dscode login anthropic     # Claude 账号或 Anthropic API key
dscode login openrouter    # OpenRouter 账号或 API key
dscode login opencode-go   # OpenCode Zen Go API key
```

选择的 provider 和模型会保存供后续启动使用，也可以随时覆盖：

```bash
dscode --provider openai-codex --model gpt-5.6-sol -C /path/to/project
dscode --provider deepseek --model deepseek-flash -C /path/to/project
```

DSCode 的全局数据统一保存在 `~/.dscode`：

```text
~/.dscode/settings.json    TUI 与运行时偏好
~/.dscode/config.json      存储策略与 DeepSeek endpoint
~/.dscode/auth.json        仅当前用户可读的凭证回退
~/.dscode/credential-metadata.json  不含密钥的钥匙串索引
~/.dscode/state.sqlite     会话元数据与桌面运行状态
~/.dscode/skills/          全局 skills
~/.dscode/extensions/      全局 extensions
~/.dscode/mcp.json         全局 MCP servers
~/.dscode/hooks.json       全局 hooks
~/.dscode/sessions/YYYY/MM/DD/  JSONL 会话正文
~/.dscode/archived_sessions/   已归档会话
```

顶层的 `sessions/*.jsonl` 是为当前终端运行时保留的硬链接兼容入口，与日期目录中的正文指向
同一个 inode，不会重复占用空间。JSONL 是会话正文的唯一事实来源；SQLite 只保存可搜索的
会话元数据、置顶/归档状态和文件指纹。

可以在 `~/.dscode/config.json` 中配置凭证与历史记录策略：

```json
{
  "cli_auth_credentials_store": "auto",
  "history": { "persistence": "save-all" }
}
```

凭证模式支持 `auto`、`keyring`、`file`。把历史策略设为 `none` 后，新会话不会写入正文。
`DSCODE_SQLITE_HOME` 可单独迁移 SQLite 状态目录。

可用 `DSCODE_HOME` 修改整个目录，用 `DSCODE_SESSIONS_DIR` 单独修改会话目录。DSCode 不再继承
`PI_CODING_AGENT_DIR`。首次启动会把旧的 `~/.dscode/agent` 内容无损复制到新目录，不删除、
不覆盖已有文件。项目 skills 建议使用可移植的 `.agents/skills/` 约定。

## 默认配置

全新安装使用：

```text
model       deepseek-flash
transport   responses
thinking    max
permission  auto
sandbox     workspace-write
network     blocked
```

CLI 和 Web 默认启用 `read,exec_command,write_stdin,apply_patch,codemode`。
可通过 `--tools ...,delegate` 启用只读子 agent 调查。`delegate({task: "..."})` 每次只启动
一个子进程，使用当前工作区、模型和 thinking level，独立 context，不保存会话。子 agent 仅可
使用 `read`、`grep`、`find`、`ls`，不能执行命令、编辑文件、调用 MCP 或继续委派。
父 agent 等待结果，负责修改和验证；两分钟后超时，取消调用会终止子进程。

MCP 使用 Pi 1.0.2 的原生实现和配置格式：全局配置为 `DSCODE_HOME/mcp.json`
（默认 `~/.dscode/mcp.json`），受信任项目使用 `.pi/mcp.json`。server 通过
`enabled: false` 禁用；默认 `exposure: "codemode"`，也可选 `deferred` 或 `direct`。
默认工具通过 codemode 调用；`searchTools()` 和 `describeTool()` 可发现工具，
无需改变模型的活跃工具声明。`tool_search` 默认不启用，可通过 `--tools` 显式选择，
或使用 server `exposure: "deferred"` 自动启用，将匹配工具加载到模型。
`--tools` 选择初始工具集合；`--no-mcp` 不加载 MCP，`--no-tools` 禁用所有工具。

`/mcp` 和 `dscode mcp add|remove|list|login|logout` 由 Pi 提供。CLI MCP 管理命令
不需要模型登录；`dscode mcp add ... -l` 写入项目 `.pi/mcp.json`。
server 定义的 MCP 工具在 `auto`/`ask` 下需要批准，`full` 下自动执行。
批准对话框显示 server namespace、工具、描述、参数，以及 `readOnlyHint` 的
true、false 或未提供状态。该提示由 server 声明，不会自动授予权限。
可选择仅批准本次、在本会话中批准此工具、在本会话中批准此 server 的全部工具，或拒绝。
会话授权覆盖后续任意参数的调用，也适用于 codemode 内部调用。
`/permissions` 显示授权；`/permissions revoke-mcp <工具名或server namespace>`
撤销对应授权，`/permissions revoke-mcp all` 清空全部 MCP 授权。
撤销 server namespace 时也清除该 server 的单独工具授权。
新建、恢复、fork 会话，以及 reload 或退出时会清空授权。
标准资源工具 `list_mcp_resources`、`list_mcp_resource_templates` 和 `read_mcp_resource`
只列出或读取上下文，在所有权限模式下都无需批准。
没有交互 UI 时拒绝需要批准的调用。codemode 内部调用执行相同的权限检查，
使用 `exec_command` 保留沙箱，使用 `apply_patch` 保留 checkpoint 和 `/undo`。
codemode 使用普通 `on` 模式，禁用直接模型调用的 `models` API。

## 常用启动方式

```bash
# 新会话
dscode -C ./my-project

# 继续或选择历史会话
dscode -C ./my-project --continue
dscode -C ./my-project --resume

# 一次性输出、JSONL 自动化或 IDE RPC
dscode -C ./my-project -p "解释认证流程"
dscode -C ./my-project --mode json -p "修复 lint 并运行测试"
dscode -C ./my-project --mode rpc

# 使用支持视觉的模型检查截图
dscode --provider openai-codex @screenshot.png "解释这个错误"
```

在 TUI 中粘贴 PNG、JPEG、GIF 或 WebP 图片并输入问题即可。DSCode 会立即把终端插入的本地路径
替换为 `[Image #N]`，并把图片数据作为 attachment 随消息发送；每轮最多支持 8 张图片，每张最大
20 MB。

TUI 常用命令：

| 命令 | 作用 |
| --- | --- |
| `/permissions` | 查看或切换 `ask`、`auto`、`full` 权限，列出 MCP 会话授权 |
| `/permissions revoke-mcp <工具名或server namespace\|all>` | 撤销 MCP 会话授权 |
| `/status` | 查看模型、context、缓存命中、token、费用和会话信息 |
| `/diff` | 查看当前 patch transcript |
| `/checkpoints` / `/undo` | 查看或恢复持久 checkpoint |
| `/new` / `/clear` | 清除当前 context 并开始一个新会话（两者等价） |
| `/resume` / `/fork` / `/tree` | 导航树形本地会话 |
| `/compact` | 压缩旧 context，同时保留当前工作状态 |
| `/jobs` | 查看可重连的后台命令 |
| `/mcp` / `/doctor` | 查看集成和运行状态 |
| `/login [provider]` | 选择并认证支持的模型供应商 |
| `/model` | 选择已配置的模型，并保存选择 |
| `/effort ...` | 调整当前模型的 reasoning effort |

输入 `/` 查看全部命令，输入 `/hotkeys` 查看快捷键。

## 安全模型

权限决定 DSCode 什么时候询问；sandbox 决定命令实际上能访问什么。

| 模式 | 行为 |
| --- | --- |
| `ask` | 命令、写入、delegate 和 MCP 都需要批准 |
| `auto` | 普通工作区操作自动执行；破坏性命令、联网、宿主机访问和外部 MCP 仍受控 |
| `full` | 可信模式，命令拥有不受限的宿主机文件系统和网络访问 |

默认命令边界是 `workspace-write` 且禁止联网。命令需要联网或宿主机访问时，TUI 会提供
**仅本次允许 / 本次会话始终允许这条命令 / 拒绝**，然后用最小必要权限自动重试。`--network`
可以为本次运行预授权网络；`--permission full` 只应用于完全可信的工作区。`dscode -y` 是明确的
YOLO 快捷方式：本次运行直接信任项目资源、跳过工具审批、关闭 sandbox 并开放网络。

macOS 使用 Seatbelt；Linux 和 Windows 使用配置好的 Docker sandbox：

```bash
export DSCODE_SANDBOX_IMAGE="your-reviewed-image:tag"
dscode -C ./project --sandbox workspace-write
```

没有可用 sandbox 后端时，DSCode 会 fail closed，不会悄悄在宿主机运行。

## DeepSeek 专用适配

- Responses API 无状态；DSCode 从本地会话树回放消息、reasoning item 和工具结果。
- Adapter 会删除 DeepSeek 不支持的 OpenAI store、cache retention 和 include 字段。
- 保留采样参数：DeepSeek 在 thinking 模式使用 `top_p`，其他模式使用 `temperature`。Thinking 支持
  `low`、`high`、`max` effort。
- `apply_patch` 在所有 provider 下使用带有 `input` 字符串参数的 schema function tool。
- Prompt 和工具顺序保持稳定，为 DeepSeek 自动前缀缓存保留可复用前缀。

这些转换只在当前 provider 为 `deepseek` 时执行；其他供应商使用运行时内置的原生实现。
环境中的 Provider API key 不会传给命令、hooks 或 stdio MCP server；MCP server 的显式 `env` 配置仍可提供凭据。

## 扩展与自动化

### 输入 hooks

内置 hook runner 支持在 `~/.dscode/hooks.json` 和可信项目的 `.dscode/hooks.json` 中配置
`hooks.input`，standalone CLI 同样可用。全局 hooks 先运行，项目 hooks 后运行。例如：

```json
{
  "hooks": {
    "input": [
      {
        "command": "node",
        "args": ["{cwd}/append-input.cjs", "{payload}"]
      }
    ]
  }
}
```

在项目目录创建 `append-input.cjs`：

```js
const input = JSON.parse(process.argv[2]);
process.stdout.write(`${input.text}\n\n请用中文回复。`);
```

`{payload}` 只包含 `event: "input"` 和 `text`。向 stdout 输出完整的替换消息，格式为纯文本；
不输出内容或只输出空白字符时保留原文本。非空输出原样保留，包括空白字符；后续 hooks 收到更新后的
文本。诊断信息写入 stderr。

DSCode 在 skill/template 展开前对 CLI 和 RPC 的用户输入运行这些 hooks，也支持排队消息。
Extensions 生成的输入和由 extensions 直接处理的命令不会触发它们。附件与消息投递行为仍由
DSCode/Pi 控制，hooks 只能替换文本。命令失败、超时或输出截断时会产生 extension error；Pi 使用进入
该 handler 时的输入继续处理，不应用已经完成的部分替换。Hooks 使用当前 sandbox/network 权限；standalone 版本也需要系统
提供相应的外部可执行程序。修改 hook 配置后需重启会话。

### UI 提示 hooks

配置 `hooks.uiPromptStart`，可在会话开始等待阻塞式 UI 提示时执行通知命令。例如在 macOS 播放声音：

```json
{
  "hooks": {
    "uiPromptStart": [
      {
        "command": "/usr/bin/afplay",
        "args": ["/System/Library/Sounds/Glass.aiff"]
      }
    ]
  }
}
```

可配置在 `~/.dscode/hooks.json` 或可信项目的 `.dscode/hooks.json` 中；standalone CLI 无需用户
extension 即可使用。配置在 `session_start` 加载，不覆盖此前的项目信任对话框。修改后需重启会话。

`{payload}` 包含 `event: "uiPromptStart"`、`kind`（`confirm`、`select`、`input`、`editor` 或 `custom`）、
`mode`（`tui`、`rpc`、`json` 或 `print`），以及可选的 `title`。自定义对话框没有标题元数据。
Pi 将重叠的提示合并为一次等待。命令使用当前 sandbox/network 权限，在 agent 所在主机执行，包括
RPC/HTTP 模式，不会在远程客户端播放声音。脚本可根据 `mode` 限制为仅在终端 UI 通知。全局 hooks
先于可信项目 hooks 执行。输出不会回答对话框；失败会报告 extension error，但不会阻止或拒绝对话框。
子进程等待 stdin 等不经过 Pi UI 提示 API 的等待不会触发此 hook。

### 扩展能力

- 分层读取 `AGENTS.md` 和 `CLAUDE.md`
- 用户级和项目级 Agent Skills
- 可信项目 hooks 与 MCP server
- 可重连后台命令
- 面向 CI 的 JSONL，以及完整 stdin/stdout RPC 模式
- 可复用的 `@aclisp/dsagent-core` 包及其内置 headless RPC worker
- [editors/vscode](../editors/vscode/README.md) 中的 VS Code 扩展
- 通过 `exec_command` 运行项目的编译器和语言检查

图形客户端和 IDE 集成完成上面的开发者设置后，可以使用私有 workspace 包
`@aclisp/dsagent-core`，不要求全局安装 CLI。Core 提供凭证、设置 API 和类型化 RPC client，
使用与终端版完全相同的 Agent、工具、权限和本地会话格式：

```ts
import { createDSCodeRpcClient } from "@aclisp/dsagent-core/rpc";

const client = createDSCodeRpcClient({ cwd: "/path/to/project" });
await client.start();
client.onEvent((event) => render(event));
await client.prompt("检查这个仓库");
```

普通 `@aclisp/dsagent` 构建会内嵌相同版本的 Core。npm 发布目前已暂停；开发者应使用上面的
workspace 设置。

## 从源码构建

```bash
git clone https://github.com/aclisp/dsagent.git
cd dsagent
corepack enable
pnpm install
pnpm check
pnpm dev -C /path/to/project
```

根 package 保留了一组主要入口：

- `pnpm build` 构建所有 workspace 子包和完整生产产物，包括 CLI、Web server 和视觉 CLI。
- `pnpm test` 从仓库根目录运行完整 Vitest 测试集，包括 `packages/` 下的测试。
- `pnpm typecheck` 检查子包、测试代码和根目录 TypeScript；由于跨包类型入口生成在 `dist/` 下，
  执行前可能会先构建 workspace 子包。
- `pnpm check` 是 CI/发布门禁：构建生产产物、检查测试代码类型、运行完整测试并执行 package smoke
  检查。
- `pnpm dev` 从源码启动 CLI；`pnpm start` 启动 `dist/bundle/cli.js` 中的打包版本，
  安装后的 `dscode` 命令也使用该入口。

原有未打包 CLI 保留在 `dist/cli.js`，可通过 `pnpm start:unbundled` 或
`node dist/cli.js` 启动，用于调试或对比。两个版本使用相同的设置、凭证、会话和运行逻辑。
CLI 将 pi 的 JavaScript 依赖一起打包以加快交互启动，原生模块和资源文件仍由安装的依赖提供。
详见 [CLI 打包说明](CLI_BUNDLING.md)。

其他验证命令：

```bash
pnpm smoke:live        # 使用真实 DeepSeek API 的修改与测试 smoke flow
pnpm acceptance:live   # 完整真实 API 功能验收
```

日常开发提交到 `dev`；带新版本号的提交合并到 `main` 并通过 CI 后，会自动创建对应的 GitHub
Release 并发布 full 和 lean Docker Hub 镜像。详细流程见 [Releasing DSCode](RELEASING.md)。

## 当前边界

- DeepSeek Flash 支持图片输入；DeepSeek V4 Pro 仍只接受文本输入。
- ChatGPT 套餐登录受账号可用模型、用量限制和 workspace 权限约束；OpenAI API key 的用量由 API
  平台单独计费。
- VS Code 扩展是本地集成，尚未发布到 Marketplace。
- Linux 和 Windows 的隔离能力取决于配置的 Docker 镜像。
- DSCode 仍是早期项目；Claude Code 和 Codex 当前拥有更广泛的 IDE、云端、多模态和生态支持。

我们不认为功能清单能够证明 DSCode 全面更好。项目应在真实仓库任务上按成功率、耗时、成本、
安全和人工接管率进行评测。
