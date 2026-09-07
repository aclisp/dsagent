# ADR-0002：Web UI 命令、MCP 工具与 checkpoint 边界

- 状态：已接受；任务 1、jobs 专项、任务 2、任务 3 已实现并验收
- 日期：2026-09-07
- 更新：2026-09-07

## 背景

DSCode CLI 与 Web UI 共用 Core extension，但 HTTP host 的交互能力和生命周期边界不同。
需要明确以下行为，避免 Web UI 把 CLI 专用命令、计划权限或未发现的 MCP 工具暴露给用户，
同时让 Web UI 能安全使用 Core 已有的 checkpoint 恢复能力。

## 决策

### 1. HTTP host 的命令与权限边界

1. HTTP host 拒绝 CLI 会改变会话结构或依赖 TUI 的命令：`/plan`、`/base-url`、`/agents`、
   `/clear`、`/new`、`/resume`、`/fork`、`/clone`、`/import` 和 `/tree`。命令名不区分大小写，
   带参数的调用也必须在进入模型前拒绝。CLI 保留这些命令的原有注册和行为。
2. Web/HTTP host 不支持 `plan` 权限。运行时参数最终解析为 `permission=plan` 时，服务器启动
   直接失败，不自动降级为 `auto`；`/permissions plan` 请求同样失败，不调用模型、不改变权限
   或会话。`/permissions` 只展示 `ask|auto|full`。
3. CLI 的 TUI、JSON 和 RPC 模式继续支持 `plan`，历史 session 中已有的 plan 权限记录和结构化
   计划可以在 Web 中恢复并查看，但不会在 Web 中自动执行计划。
4. Web/HTTP host 不注册、不允许激活 `update_plan`。显式选择该工具时启动失败；`--no-tools`
   优先级最高，因此 `--no-tools` 与显式 `update_plan` 同时出现时仍然禁用全部工具。CLI 保留
   `update_plan` 及其 plan 模式行为。

### 2. 默认工具与 MCP

1. CLI 和 Web UI server 在没有 `--tools` 时，默认启用四个常规工具：
   `read`、`exec_command`、`write_stdin`、`apply_patch`。显式选择这四个工具与省略参数的
   结果一致；CLI 的其他常规工具需要显式选择，Web 继续禁用 `delegate`。
2. MCP 工具由 Core 在 session 初始化时从 `DSCODE_HOME/mcp.json` 和受信任项目的
   `.dscode/mcp.json` 中发现、注册，并自动加入当前工具集合。用户不需要在 `--tools` 中逐个
   指定 `mcp__...` 工具；显式选择四个常规工具时仍然自动加入已发现的 MCP 工具。
3. `--no-tools` 禁用常规工具和 MCP 工具，参数顺序不影响结果；`--no-mcp` 保留常规工具但
   不读取、连接或注册 MCP。显式列出的 MCP 名称不能绕过 `--no-mcp`。
4. MCP server 的 `disabled` 配置、项目可信检查和配置文件错误保持有效。单个 server 连接或
   发现失败不会阻止 session 启动；错误通过初始化提示和 `/mcp` 暴露。`/mcp` 区分已连接、
   已发现、当前 active、配置禁用和失败原因。
5. MCP 只在 session 初始化时发现，不增加热加载或自动重连；配置变化需要重新初始化 session。
   重新初始化前清理旧的 MCP 注册和 active 工具，避免 stale tool 泄漏。
6. CLI plan 模式保留 `update_plan` 和允许只读探索的工具，暂时停用 MCP；退出 plan 后恢复
   进入前的工具集合。`ask`/`auto` 下 MCP 调用仍需审批，非交互环境无法审批时拒绝，`full`
   保留免审批语义。

### 3. Managed jobs 生命周期

1. 每个 Session 的 `ManagedProcessRegistry` 最多保留 100 条已结束记录。超过上限时删除最早
   结束的记录，运行中的进程不参与淘汰。
2. `/jobs` 保持原有展示，只显示 running/not-running 两种状态；不增加 TTL、过滤或 `--all`。
3. 记录读取行为保持兼容：已返回完成结果的记录仍可再读取一次完成状态；后台结束后的最终
   输出仍可读取；`write_stdin` 读取完成记录后立即删除。已淘汰的 ID 继续返回 `Unknown process`。
4. 不限制活跃进程数量，不引入轻量完成状态、持久化或额外配置。记录总数上界为运行中任务数
   加 100，进程结束时立即执行回收，不依赖 `/jobs` 查询。

### 4. Web checkpoint、diff 与 undo

1. checkpoint 只由 `apply_patch` 创建；`exec_command`、重定向和 Git 命令造成的文件修改不会
   自动生成 checkpoint。checkpoint 保存涉及文件的完整 before/after 快照，并持久化到 session
   branch。
2. `/checkpoints` 列出当前 branch 的 checkpoint ID、文件和撤销状态；无记录和全部撤销时复用
   Core 的文本通知。
3. `/diff` 显示最后一个未撤销 checkpoint 的完整 patch。Core 追加 `dscode-diff` entry，HTTP
   host 将其转换为 `checkpoint_diff` SSE 事件，`/chat` 和 `/debug` 展示 checkpoint ID 及完整
   等宽 patch。展示区支持横向、纵向滚动和复制，不静默截断；首期不引入 Git diff 语义、弹窗、
   双栏对比或文件选择器。
4. `/undo` 恢复最后一个未撤销 checkpoint，多次调用按时间顺序逐个撤销。保留浏览器确认、
   内容冲突保护、`--force` 覆盖行为和工作区路径保护；`--force` 只跳过内容冲突检查，不能绕过
   路径限制。用户主动 undo 不经过模型工具权限审批，即使 sandbox 为 `read-only` 也可在确认后
   恢复共享工作区。
5. 确认框列出受影响文件，并明确说明 `--force` 会覆盖 checkpoint 之后的修改。取消、成功、
   冲突拒绝和其他失败均即时反馈；`/chat` 的文件恢复说明保持中文，取消和恢复结果通知使用
   Core 的英文文案，`/debug` 页面 UI 文案保持英文。
6. 命令输出只在当前连接即时展示，刷新后不自动重放；用户重新运行命令查询持久化状态。首期
   不增加按 ID undo、单文件 undo 或 redo。

## 非目标

- Web 不新增 plan 权限或 `update_plan` 展示能力。
- MCP 不增加热加载、自动重连或 `/mcp reload`。
- jobs 不引入过期时间、持久化、轻量完成状态或活跃进程数量限制。
- checkpoint UI 不扩展为版本管理或仓库级 Git diff 工具。

## 实现入口

- `packages/http-adapter/src/agent-session-host.ts`：HTTP 命令限制、plan 权限和 Web 工具边界。
- `packages/core/src/runtime-options.ts`：默认工具、显式工具选择、`--no-tools` 与 `--no-mcp`。
- `packages/core/src/mcp.ts`：MCP 配置、连接、发现、状态和关闭。
- `packages/core/src/dscode-extension.ts`：权限过滤、MCP 初始化、jobs 与 checkpoint 命令。
- `packages/core/src/managed-process.ts`：后台进程结果与完成记录回收。
- `packages/core/src/checkpoint.ts`：快照、冲突检测和恢复。
- `packages/http-adapter/src/session-controller.ts`：checkpoint diff 的 SSE 转换。
- `packages/http-adapter/src/ui-broker.ts`：Web UI 请求和通知事件。
- `packages/web-ui/src/web-ui-runtime.ts`：Web 默认 runtime 参数。
- `packages/web-ui/static/chat.js`、`app.js`：`/chat`、`/debug` 的命令反馈和 diff 展示。
- `packages/web-ui/static/chat.css`、`style.css`：diff 滚动展示样式。

## 验证

- `pnpm check`：64 个测试文件通过，368 个测试通过，1 个既有平台测试跳过，打包冒烟检查通过。
- MCP 默认工具、显式四工具、`--no-tools`、`--no-mcp`、失败 server、信任检查和 HTTP host
  工具调用均有自动化测试。
- jobs 完成记录上限、running 记录不被淘汰和终止时序均有自动化测试。
- checkpoint extension、HTTP SSE diff 转换和 Web `/chat`、`/debug` 的 undo/checkpoints/diff
  流程已完成手工验证。
