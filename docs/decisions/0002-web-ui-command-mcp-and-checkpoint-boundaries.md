# ADR-0002：Web UI 命令、MCP 工具与 checkpoint 边界

- 状态：已接受；任务 1、jobs 专项、任务 2、任务 3 已实现并验收
- 日期：2026-09-07
- 更新：2026-10-02（规划移除与子进程简化见 ADR-0004；默认工具与 MCP 决策由 ADR-0005 取代）

## 背景

DSCode CLI 与 Web UI 共用 Core extension，但 HTTP host 的交互能力和生命周期边界不同。
需要明确以下行为，避免 Web UI 把 CLI 专用命令、未发现的 MCP 工具暴露给用户，
同时让 Web UI 能安全使用 Core 已有的 checkpoint 恢复能力。

## 决策

### 1. HTTP host 的命令与权限边界

1. HTTP host 拒绝 CLI 会改变会话结构或依赖 TUI 的命令：`/base-url`、`/clear`、`/new`、
   `/resume`、`/fork`、`/clone`、`/import` 和 `/tree`。命令名不区分大小写，带参数也必须
   在进入模型前拒绝。
2. CLI 和 Web/HTTP host 使用相同的 `ask|auto|full` 权限集合。
3. Web/HTTP host 不注册、不允许激活 `delegate`，显式选择该工具时启动失败。
   `--no-tools` 优先级最高，同时显式选择 `delegate` 时仍禁用全部工具。

### 2. 默认工具与 MCP

此节由 [ADR-0005](0005-native-pi-mcp.md) 取代，使用 Pi 原生 MCP、codemode 和 tool-search。

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

- Web 不新增 CLI 子进程调查能力。
- jobs 不引入过期时间、持久化、轻量完成状态或活跃进程数量限制。
- checkpoint UI 不扩展为版本管理或仓库级 Git diff 工具。

## 实现入口

- `packages/http-adapter/src/agent-session-host.ts`：HTTP 命令限制、权限和 Web 工具边界。
- `packages/core/src/runtime-options.ts`：默认工具、显式工具选择、`--no-tools` 与 `--no-mcp`。
- `packages/core/src/pi-builtins.ts`：原生 Pi 扩展注册与 MCP 环境凭据过滤。
- `packages/core/src/dscode-extension.ts`：权限过滤、初始工具集合、jobs 与 checkpoint 命令。
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
