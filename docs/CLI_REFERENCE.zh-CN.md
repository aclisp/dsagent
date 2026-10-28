# CLI 与运行时参考

## 终端应用

要求 Node.js 26.x 和 Git；源码构建还需要 pnpm 12.x。DSCode 运行时也使用 `rg`。

Unix 主机命令优先使用非空的 `$SHELL`，否则依次查找 `/bin/bash`、PATH 中可执行的 `bash`，
最后回退到 `/bin/sh`。显式配置的 `$SHELL` 无效时返回启动错误，不静默改用其他 shell。
主机和 macOS Seatbelt 命令使用 `-c`，不再为每条命令重新加载登录 shell 的启动文件。
DSCode 已继承的导出 SDK 环境变量和 PATH 条目仍然可用；请在启动 DSCode 前完成必要的 SDK
环境初始化。Docker 命令使用容器内的 `/bin/sh -c`，不使用主机 shell 路径。

Windows 主机命令使用 PowerShell，依次查找 `DSCODE_SHELL`、PATH 中的 `pwsh.exe` 和
`%ProgramFiles%\PowerShell\7\pwsh.exe`。找不到 PowerShell 7 时，主机执行继续查找 PATH 中的
`powershell.exe` 和 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`；未设置
`SystemRoot` 时也接受 `WINDIR`。主机执行的 `DSCODE_SHELL` 只去掉首尾空白后原样传给进程创建，
保留裸名称、相对路径和无扩展名路径的原有解析行为。自动查找失败时给出明确错误。
Windows 原生沙箱仍验证显式配置并要求 PowerShell 7，不回退到旧版 Windows PowerShell。两条路径共用尽力而为的
UTF-8 控制台输出设置，并禁用 profile 加载，同时保留各后端原有的启动参数。

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

Pi 1.3.0 的 `kimi-coding` 改用 OpenAI Chat Completions 协议，默认地址为
`https://api.kimi.com/coding/v1`。`models.json` 中自定义的 `kimi-coding` base URL
必须包含 `/v1`，并支持该协议。

新会话的思考力度优先级为：CLI `--effort` / `--thinking`（最后一个参数生效）、
`DSCODE_EFFORT`、`modelThinkingLevels["provider/modelId"]`、`defaultThinkingLevel`、
provider 默认值（DeepSeek 为 `max`，其他 provider 为 `medium`）。配置位于
`~/.dscode/settings.json` 或 `$DSCODE_HOME/settings.json`；受信任项目配置按 Pi 的规则合并。
恢复会话时，保存的力度优先于配置和 provider 默认值，CLI 和环境变量仍可覆盖。
CLI 子 agent 使用相同规则，不会隐式继承父会话当前的力度。

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

可以在 `~/.dscode/config.json` 中配置凭证、历史记录与快照保留策略：

```json
{
  "cli_auth_credentials_store": "auto",
  "history": { "persistence": "save-all" },
  "web_snapshots": { "retention_days": 30 }
}
```

凭证模式支持 `auto`、`keyring`、`file`。把历史策略设为 `none` 后，新会话不会写入正文。
`DSCODE_SQLITE_HOME` 可单独迁移 SQLite 状态目录。

fullscreen 模式下，正常完成的执行段会自动把中间说明和工具调用收起，只显示可点击的
`Worked for 3m 13s` 耗时行；用户输入和最终答复正文保持可见，最终消息中的 thinking 也归入
收起的执行过程。点击耗时行展开过程，再点击
单个工具展开其输出。`Alt+O` 控制全部过程块：只要有一个收起，就全部展开；全部展开时，
再按一次全部收起。收起过程时，也会收起内部全部工具输出；`Ctrl+O` 只控制当前可见
过程中的工具：只要有一个收起，就全部展开；全部展开时，则全部收起。
失败、中断或缺少完整边界的段落保持平铺。恢复历史时默认收起，不保存
展开状态。耗时根据已有用户输入与最终答复的会话条目时间戳计算，包含模型请求、工具执行、
确认等待和重试。fullscreen 搜索覆盖已展开内容，导出保留完整记录；regular 模式与退出时
输出到终端的对话记录保持平铺。

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

`exec_command` 默认将 stdin 接到空设备。需要通过 `write_stdin` 后续输入时，启动命令须设置
`stdin_open: true`，这会打开输入管道，不会分配终端。两种模式都支持轮询和终止。
向关闭的 stdin 写入字符会返回错误；向已经关闭的 stdin 发送 EOF 无副作用。
Shell 内部的管道和输入重定向仍可正常提供输入。

配置 DeepSeek 凭据且允许网络访问后，`web_search`、`web_fetch` 以 deferred 工具注册，所有聊天 provider 均可使用。
它们默认不加入 activeTools，完整定义也不会内嵌到 codemode 的说明中。需要时通过 codemode 的
`searchTools()` 或 `describeTool()` 发现，再调用 `tools.web_search()` 或 `tools.web_fetch()`。
原生 `tool_search` 也可以按需将它们加载为直接工具。
它们复用 DeepSeek 的服务地址和凭据；自定义代理需要支持 `/v1/tools/search`、`/v1/tools/fetch`。
`--tools` 选择初始激活的工具，不影响通过 codemode 调用 deferred 网页工具；
`--no-tools` 禁用全部工具，`--no-mcp` 不影响它们。

搜索每次请求最新结果，默认返回 5 条；可设置 `count`（1～50）、`ori_question`
（不超过 128 个 Unicode 字符）和 `need_content`（默认 `false`）。支持 `site:`、
`lang:`、`after:` 等原生查询语法。结果保留排序、摘要、URL、日期及评分。
`need_content: true` 获取的正文保存为快照，不直接塞入搜索结果。

`web_fetch` 接受 `url` 或 `snapshot_id` 二者之一，按 `offset`（从 1 开始）和
`limit` 分段阅读，默认 200 个展示行，每次最多 50 KiB。超长行按 4000 个 Unicode
字符折行展示，原始 Markdown 不变。结果返回 `snapshot_id` 和 `next_offset`。
按 URL 读取会复用最近快照；`refresh: true` 生成新版本，保留期间旧 ID 始终指向旧正文。
按 ID 读取不发起网络请求，也不重新解析凭据。

正文保存在 `$DSCODE_HOME/web-snapshots/`，会话只保存元数据，恢复和 fork 可读取尚未清理的版本。
启动时会尽力清理修改时间超过 30 天的快照，包括已保存会话仍引用的快照。可在
`~/.dscode/config.json` 中用非负整数 `web_snapshots.retention_days` 调整保留天数，
`0` 禁用清理。读取不会延长保留期。快照缺失时返回错误；使用原 URL 和 `refresh: true`
重新抓取可生成新版本，但正文可能已与历史版本不同。
`--no-session` 等非持久化会话只在内存保存正文。工具沿用 `auto` / `ask` / `full`
权限规则。网络访问被禁用时，两个工具都不可用，包括已缓存快照的读取。
`--network`、`full` 权限或 `danger-full-access` 沙箱可启用网络访问；单个命令的临时网络授权
不会启用网页工具。Fetch 失败时不自动转为本机抓取。
搜索与抓取通过 DeepSeek 按次计费，正文进入模型上下文后也会消耗模型 token；
详见 [DeepSeek Search / Fetch 文档](https://api-docs.deepseek.com/zh-cn/guides/search/)。

CLI 和 Web/HTTP agent 都可以通过 `exec_command` 启动普通 DSCode CLI 子进程，
再通过 `write_stdin` 获取结果。直接调用 `dscode ...` 使用固定的安装入口并保留模型凭据，
不通过 PATH 查找，也不受父 agent 的命令沙箱限制。子进程根据自己的 CLI 参数和普通默认值
选择模型、thinking level、权限、命令沙箱和命令网络访问，没有父权限上限或额外审批流程。
父命令网络被禁用时，子进程仍可请求模型；容器及其他外部 OS 限制继续生效。
启动 `dscode` 被归类为危险命令，使用父 agent 已有的命令审批流程：`auto` 需要审批，
`full` 直接允许。仅查看帮助或版本的独立调用不需要审批。

### 后台 CLI 子进程

Windows 的受管命令接受裸名称 `dscode` 和 `dscode.exe`，不区分大小写，均使用固定的安装入口、
相同的启动审批和子进程深度限制。路径参数保留反斜杠，支持 UNC 路径和引号内以反斜杠结尾的目录。
单、双引号支持 PowerShell 的双写引号，反引号只用于转义字面标点或空格；引号内变量保持字面文本。
命令替换、命令连接、管道、重定向及控制字符/Unicode 转义表达式会被拒绝。Unix 引号规则保持原样。

[dscode-delegate skill](../deploy/default-skills/dscode-delegate/SKILL.md) 按需提供委派指导。
Docker 与 `dscode-vision` 一样自动初始化该 skill；普通 CLI 和 standalone 安装需手动将
`deploy/default-skills/dscode-delegate` 整个目录复制到 `~/.dscode/skills/`
（或 `$DSCODE_HOME/skills/`）。Skill 可自动发现，核心提示词不再包含子 agent 启动指导。

为子进程提供完整任务和上下文，默认使用独立对话和父进程的当前工作目录。
子进程可以修改文件、运行普通命令和测试、使用 MCP/扩展。
受管理的 DSCode 子 agent 深度上限为 1，与原来的 `delegate` 一致：父 agent 可以启动多个
子 agent，但子 agent 不能通过 `exec_command` 再启动 DSCode 子 agent，即使拥有完整权限。
父 agent 应协调共享文件的修改；重叠任务可先显式创建 Git worktree。
通过 `--provider`、`--model`、`--effort` 选择模型和思考级别，需要可复现行为时显式指定权限
和沙箱参数。临时任务建议使用 `--no-session`。

```json
{"cmd":"dscode --no-session --permission auto --sandbox workspace-write -p '实现并验证指定任务'","yield_time_ms":0,"timeout_ms":0}
```

stdin 默认关闭，Print 任务会直接开始，无需额外发送 EOF。如需通过 stdin 补充上下文，
启动时设置 `stdin_open: true`，再通过 `write_stdin` 写入 `chars` 并发送 `eof: true`；
此时 Print 模式会等待 EOF 后处理输入。子进程仍在运行时，工具返回 `process_id`。
父 agent 可以继续其他工作，通过不带 `chars` 的
`write_stdin` 轮询输出；结束前应收集所有结果并检查修改。Print 模式会拒绝需要交互批准的
操作，子进程应报告被阻塞的操作和未完成的工作。

所有托管命令均支持 `timeout_ms: 0`，表示不设置进程截止时间。省略时仍默认 120000 ms，
正值范围为 1000–600000 ms。`yield_time_ms` 仅控制单次工具调用的等待时间，与进程寿命独立。
通过 `write_stdin` 的 `terminate: true` 停止进程；会话关闭会清理剩余托管进程。

每个 CLI 或 Web 会话最多同时运行 64 个托管任务。达到上限时，在创建进程之前拒绝新任务，
已有任务继续运行。通过 `/jobs` 查看任务，等待其结束或使用 `write_stdin` 的 `terminate: true`
停止任务。工具调用提前返回不会释放运行名额，进程关闭后才释放。已结束且尚未读取的记录
单独受 100 条保留上限约束，不占运行名额。

### RPC 子进程与审批

需要后续交互或审批时，启动 `dscode --mode rpc --no-session` 并显式保持 stdin 打开：

```json
{"cmd":"dscode --mode rpc --no-session","stdin_open":true,"yield_time_ms":0,"timeout_ms":0}
```

通过 `write_stdin` 发送 JSONL `prompt` 记录，每条记录后追加真实换行符：

```json
{"type":"prompt","message":"实现并验证指定任务"}
```

轮询 `extension_ui_request` 事件，取得用户决定后发送相同 ID 的响应：

```json
{"type":"extension_ui_response","id":"request-id","confirmed":true}
```

`select` 请求使用 `value` 返回选项，取消使用 `cancelled: true`。不要自动批准。
`prompt` 成功响应只表示接收任务，应收集最终回答并等待 `agent_settled`，随后发送 EOF 关闭
RPC 子进程。输出缓冲区有大小上限，需定期轮询。协议请求由父 agent 显式处理，不会自动
转发为 Web UI 的原生审批对话框。


MCP 使用 Pi 1.4.0 的原生实现和配置格式：全局配置为 `DSCODE_HOME/mcp.json`
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
| `/checkpoints [all]` | 查看上一轮的 checkpoint；加 `all` 查看当前 branch 的全部历史 |
| `/undo` | 恢复最后一个未撤销的 checkpoint |
| `/new` / `/clear` | 清除当前 context 并开始一个新会话（两者等价） |
| `/resume` / `/fork` / `/tree` | 导航树形本地会话 |
| `/compact` | 压缩旧 context，同时保留当前工作状态 |
| `/jobs` | 查看可重连的后台命令 |
| `/mcp` / `/doctor` | 查看集成和运行状态 |
| `/login [provider]` | 选择并认证支持的模型供应商 |
| `/model` | 选择已配置的模型，并保存选择 |
| `/effort ...` | 调整当前模型的 reasoning effort |

输入 `/` 查看全部命令，输入 `/hotkeys` 查看快捷键。

`apply_patch` 使用固定的 UTF-8 内容容量限制：补丁输入最多 1 MiB，单个原文件或结果文件
最多 10 MiB，单次补丁的原文快照与计划写入内容合计最多 50 MiB。移动链的中间写入版本
计入总量；合并的普通重复修改只计算保留的版本。容量检查在首次写入前完成。
checkpoint 读取和 `/undo` 使用相同的有界读取与内容预算；`/undo --force` 只绕过内容冲突，
不绕过容量限制。超限错误包含相关路径、已观察到的字节数及上限。这些限制针对内容体积，
并非进程内存上限，也不提供配置覆盖。

`apply_patch` 在准备阶段响应取消，包括修改前快照和文件读取。最后一次取消检查位于
首次创建目录、删除或写入等文件系统修改操作启动之前。一旦该操作启动，取消不会打断
后续补丁操作、修改后快照和 checkpoint 保存，成功完成的补丁仍可 `/undo`。
文件系统和 checkpoint 错误继续按原有机制报告。

## 安全模型

权限决定 DSCode 什么时候询问；sandbox 决定命令实际上能访问什么。

| 模式 | 行为 |
| --- | --- |
| `ask` | 命令、写入和 MCP 都需要批准 |
| `auto` | 普通工作区操作自动执行；破坏性命令、联网、宿主机访问和外部 MCP 仍受控 |
| `full` | 可信模式，命令拥有不受限的宿主机文件系统和网络访问 |

Windows 宿主机命令使用 PowerShell 专用的字面语法识别，覆盖常见删除别名、清空/覆盖文件、
停止进程/服务、电源及磁盘操作，也识别模块限定名称、管道、受支持的执行块和字面 PowerShell 包装命令。
注释和引号中的普通数据不作为命令。`Remove-Item` / `Clear-Item` 的目标明确限定为 `Env:`、
`Variable:`、`Alias:`、`Function:` 时，视为普通会话状态准备并自动执行；支持固定 provider 前缀后的
名称展开，例如 `Remove-Item "env:$v"`，以及全部目标明确限定为会话 provider 的逗号列表。
未知或混合目标、参数 splat、动态数组表达式仍需审批。
已知 cmdlet 明确使用 `-WhatIf` / `-WhatIf:$true`（含 `-wi` 别名）预览，以及明确启用
`Out-File -NoClobber` / `-NoOverwrite` 禁止覆盖时，不触发破坏性命令审批；关闭或动态的开关值、
带引号的参数文本及 `--` 后的内容不能获得该豁免。覆盖输出文件的重定向独立检查。
动态代码调用和无法按字面分析的 PowerShell 脚本启动需要审批。这仍是有范围限制的启发式识别，
不构成安全边界；不会求值自定义别名、函数定义或任意解释器代码。`ask` 仍要求每条命令审批，
`full` 保持原有行为。

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

### 工具调用日志 hooks

在 `~/.dscode/hooks.json` 或可信项目的 `.dscode/hooks.json` 中配置 `hooks.afterTool`，
即可记录工具名称、调用参数和是否报错。例如：

```json
{
  "hooks": {
    "afterTool": [
      {
        "command": "node",
        "args": ["{cwd}/log-tool.cjs", "{payload}"]
      }
    ]
  }
}
```

在项目目录创建 `log-tool.cjs`：

```js
const fs = require("node:fs");
const payload = JSON.parse(process.argv[2]);
fs.appendFileSync("tool-calls.jsonl", JSON.stringify({
  timestamp: new Date().toISOString(),
  ...payload,
}) + "\n");
```

`afterTool` payload 包含 `event: "afterTool"`、`tool`、`toolCallId`、`input` 和 `isError`。
嵌套调用还包含 `parentToolCallId`，便于关联并发和嵌套调用。这些 payload 不包含工具返回的文本、图片、
details 或 structured content。参数按 Pi 提供的值传递，不脱敏、不截断。

如需同时记录执行前的调用，可为 `hooks.beforeTool` 配置相同命令。其 payload 包含
`event: "beforeTool"`、`tool`、`toolCallId`、`input` 及可选的 `parentToolCallId`；
是否报错仅在 `afterTool` 中提供。Pi 在 `beforeTool` 之前校验参数，仅对已执行的调用触发 `afterTool`，
因此未知工具、参数校验失败和执行前被拦截的调用不会产生 `afterTool` 记录。

全局 hooks 先于可信项目 hooks 运行，使用当前 sandbox/network 权限，日志路径需要在该权限下可写。
standalone 版本也需要系统提供外部可执行程序。修改 hook 配置后需重启会话。

### 工作完成 hooks

配置 `hooks.completed`，可在提交的工作不再自动运行、用户可以回来查看结果时执行一次通知命令。
正常完成和最终失败都会通知。例如在 macOS 播放声音：

```json
{
  "hooks": {
    "completed": [
      { "command": "/usr/bin/afplay", "args": ["/System/Library/Sounds/Glass.aiff"] }
    ]
  }
}
```

`{payload}` 仅为 `{ "event": "completed" }`，不包含用户输入、助手回复或结果分类。

该 hook 等待 Pi 的 `agent_settled` 事件，在自动重试、压缩恢复和排队续跑全部结束后，只通知一次。
通知仅表示“本轮自动执行已经结束，可以回来查看结果”，不区分结果成功或失败。
用户按 Esc 等方式主动中断时不通知。

可配置在 `~/.dscode/hooks.json` 或可信项目的 `.dscode/hooks.json` 中，全局 hooks 先运行。
命令在 DSCode 主机执行，使用当前 sandbox/network 权限及配置的超时；standalone 版本也需要外部
可执行程序。通知命令失败会报告 extension error。修改配置后需重启会话。

### UI 提示 hooks

配置 `hooks.uiPromptStart`，可在会话开始等待阻塞式 UI 提示时执行通知命令；配置 `hooks.uiPromptEnd`
可在结束等待时清理通知。例如在 macOS 播放声音：

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

`{payload}` 包含 `event: "uiPromptStart"` 或 `"uiPromptEnd"`、`promptId`、`kind`（`confirm`、`select`、`input`、`editor` 或 `custom`）、
`mode`（`tui`、`rpc`、`json` 或 `print`），以及可选的 `title`。自定义对话框没有标题元数据。
Pi 将重叠的提示合并为一次等待。命令使用当前 sandbox/network 权限，在 agent 所在主机执行，包括
RPC/HTTP 模式，不会在远程客户端播放声音。脚本可根据 `mode` 限制为仅在终端 UI 通知。全局 hooks
先于可信项目 hooks 执行。输出不会回答对话框；失败会报告 extension error，但不会阻止或拒绝对话框。
子进程等待 stdin 等不经过 Pi UI 提示 API 的等待不会触发此 hook。

持久提醒应使用 `{payload}` 中的 `promptId` 作为标识。DSCode 为每次等待生成一个 UUID，
start/end 的 payload 包含同一个 ID。同一工作区的不同会话，以及标题相同的后续提示，都有不同 ID。
同一次等待的所有已配置命令共享该 ID。Pi 会将同一会话中重叠的对话框合并为一次等待，所以它们
共享一个 ID，而不是各有一个。未匹配或重复的 end 事件会被忽略。`{cwd}` 用于显示项目，
不再作为提醒标识。例如将自己的提醒脚本接入两个 hooks：

```json
{
  "hooks": {
    "uiPromptStart": [
      { "command": "/path/to/reminder", "args": ["show", "{cwd}", "{payload}"] }
    ],
    "uiPromptEnd": [
      { "command": "/path/to/reminder", "args": ["clear", "{cwd}", "{payload}"] }
    ]
  }
}
```

End 表示等待结束（已回答、取消、超时或异常），不表示用户批准了操作。每个会话中的 start/end
命令按顺序执行，即使某个 hook 失败，清理也不会先于创建。命令仍受 hook 超时限制，但不会随 agent
turn 取消，便于取消提示后清理。如果进程退出或崩溃，不保证命令完成。提醒操作应设计为幂等；这些
hooks 是通知生命周期接口，不是审批结果接口。

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
npm install --global pnpm@12
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
