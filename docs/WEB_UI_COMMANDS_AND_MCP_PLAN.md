# Web UI 命令与 MCP 后续任务

讨论日期：2026-09-07。按任务 1 → 任务 2 → 任务 3 推进；本文记录任务边界和待办，
不表示后续能力已经发布。任务 1 与 jobs 专项已提交，当前实施任务 2；任务 3 后续跟进。

## 任务 1：不支持的命令与 Web plan 权限

- 在 HTTP host 的 `UNSUPPORTED_SESSION_COMMANDS` 中加入 `plan`、`base-url`、`agents`。
  带参数的调用也应拒绝，不能落到模型输入；CLI 的命令注册保持原样。
- 最新确认规则：Web 暂不支持 plan 权限，DSCode CLI 仍允许 plan。
  适用于所有 HTTP host，包括浏览器、IM、定时任务及独立 HTTP 客户端；
  CLI 的 TUI、JSON、RPC 保持原样。
- 已确认：Web 最终配置解析为 `permission=plan` 时，在服务器启动阶段直接报错退出，
  不延迟到首次创建 Session，也不自动降级为 `auto`。
- 已确认：本轮不调整 `update_plan` 的工具选择行为；其可用性和 Web 展示问题归入任务 2。
- 已确认：`/permissions plan` 在 HTTP host 中使本次请求失败，不调用模型、不改变权限或会话；
  `/permissions` 的帮助只列出 `ask|auto|full`。
- 已确认：允许恢复历史中包含 plan 权限记录或结构化计划的会话，使用当前 Web 权限，
  保留历史内容，不自动执行计划。
- 已确认：保留 `--sandbox read-only` 的现有语义，不把它视为 plan 权限的等价替代。
- jobs 的本轮代码和测试改动已撤回，另列后续专项；不在本任务修复。
- 不在此任务实现 MCP 工具策略或 Web checkpoint/diff 展示。

## 任务 2：MCP enhancement（已确认，实施中）

### 用户提出的目标

- CLI 和 Web UI server 不传 `--tools` 时，默认常规工具统一为
  `read,exec_command,write_stdin,apply_patch`，`safe`/`minimal` harness 一致。
  CLI 的其他常规工具需要显式选择；保留 CLI 的 `delegate`，Web 继续禁用。
- MCP 工具从已配置且启用的 server 发现，自动加入可用工具，不要求用户在 `--tools`
  中逐个列出 `mcp__...`。显式传入上述四工具时也应自动加入 MCP 工具。
- 配置仍读取 `DSCODE_HOME/mcp.json` 和可信项目的 `.dscode/mcp.json`；保留现有信任检查。
- CLI 保留 `update_plan`，进入 plan 权限自动加入；不属于普通模式的四个默认工具。
- Web 及所有 HTTP host 不注册、不允许激活 `update_plan`。最终有效工具选择包含它时，
  启动直接报错退出；`--no-tools` 优先清空工具，因此覆盖显式 `update_plan`。
  这取代任务 1 暂不调整该工具的边界；Web 不在本任务新增计划展示。

### 已确认规则与实现边界

- `MCPManager.connectServer()` 发现、注册并激活工具后，core 的 `session_start` 又根据
  `toolsExplicit` 重设 active tools，显式 `--tools` 会排除新发现的 MCP 工具。
- HTTP host 向 Pi SDK 传递的 `tools` 还是永久注册白名单，也会挡住动态发现的 MCP。
  移除此白名单，保留 Web 的 `update_plan` 排除规则；零工具使用 SDK 的全部禁用开关。
- 由 core 统一计算“常规工具与已发现 MCP 工具的并集”，再应用权限限制；Manager
  负责连接、发现和注册，避免先激活再覆盖。
- 将“显式常规工具选择”与“禁用全部工具”分别表示；`--no-tools` 应禁用包括 MCP 在内
  的全部工具，无论参数顺序、权限切换，都不能因自动合并或 plan 补 `update_plan` 而失效。
- 增加 `--no-mcp`，CLI/HTTP 均支持：保留常规工具，但不连接或注册 MCP 工具，
  即使 `--tools` 显式列出 MCP 名称也不能绕过。
- 保留 MCP server 的 `disabled` 配置。禁用全部工具或 MCP 时跳过 MCP 连接。
- 自动发现/加入工具不等于自动批准调用。保留 `auto`/`ask` 下 MCP 调用审批，以及
  CLI plan 模式继续排除全部 MCP；退出 plan 后恢复进入前的工具集合，重复进入不污染快照。
  非交互场景中需要审批的调用继续拒绝；`full` 保留免审批语义。
- `/mcp` 应区分已连接、已发现、当前 active，以及不可用原因，避免“已连接但不能用”
  的误导。部分 server 连接或发现失败时继续启动，报告错误，并允许 `/mcp` 查看失败原因。
  配置读取失败同样报告；不自动重连，不新增热加载或 `/mcp reload`。
  仅在 session 初始化时发现工具，配置变化需重新加载 session；重新初始化移除旧 MCP 激活项。
- 同步 CLI 帮助、Web 默认参数、部署示例与文档，明确旧版 `--tools` 严格列表语义的变化。

### 验收重点

- 无 `--tools` 时四个默认常规工具在 CLI/Web 一致，其他常规工具不会意外激活。
- 显式四工具与默认工具两种启动方式均能发现并调用 fixture MCP 工具。
- 覆盖 `--no-tools`、MCP 禁用、未信任项目、连接失败和权限审批。
- 覆盖 CLI plan 进入/退出、session 重新初始化、分页发现和工具去重。
- 测试完整 extension `session_start`、真实 HTTP host 工具调用及 CLI 发往模拟服务的工具列表，
  捕获 active tools 覆盖及 SDK 注册白名单问题。

## 任务 3：Web UI undo/checkpoints/diff（待实施，排在任务 2 之后）

### 原则与范围

先简单对齐 DSCode CLI，复用 core checkpoint 与恢复逻辑；不先建设复杂的版本管理界面。
CLI 保持现有语义，Web `/chat` 与 `/debug` 都需要可用。

- `/checkpoints`：列出当前分支的 checkpoint ID、文件和撤销状态；当前已有文本通知，
  优先复用，只补必要的展示问题。
- `/diff`：显示最后一个未撤销 checkpoint 的 patch。当前只追加 `dscode-diff` entry，
  渲染依赖 TUI `Text`，浏览器不可见。先补可读文本输出或简单 diff 区块，
  不引入整个仓库的 Git diff 语义。
- `/undo`：恢复最后一个未撤销 checkpoint，保留浏览器确认、冲突保护及 `--force` 行为，
  明确显示成功或失败。操作对象是共享的服务器工作区。
- 无 checkpoint、全部已撤销、发生后续修改冲突时，反馈与 CLI 对齐。
- 保持 checkpoint/undo entry 的持久记录与 session 恢复能力。
  命令输出是否需要在刷新后的聊天历史中重现，实施时另行确定；首期不以重做历史协议为前提。

### 验收重点

- 创建 patch → checkpoints → diff → undo 的浏览器完整流程。
- 覆盖恢复 session 后查询/撤销、冲突拒绝、`--force` 确认与取消，以及空状态。
- Web 显示结果与真实文件内容一致，且不改变 CLI 的 checkpoint 选择和冲突检测规则。

## 专项：jobs 生命周期与兼容性

- 线上现象：`/jobs` 返回大量已结束的记录。
- 已确认两条积累路径：首次执行已返回完成结果但记录未删除；后台结束后无人读取结果，
  记录一直保留至 Session 释放。
- 已撤回的尝试只回收已交付结果并过滤列表，未限制未读取记录的总量，不能视为完整修复。
- 已确认采用最小兼容修复：CLI 和 Web 的每个 Session registry 最多保留 100 条
  not-running 记录，超过后删除最早结束的记录（不是最早启动的记录）。
- 运行中的记录不参与额度或淘汰；进程结束时直接执行回收，不依赖 `/jobs` 查询或后续操作。
- `/jobs` 保持原有展示和 running/not-running 两种状态，不增加过滤或 `--all`。
- 未淘汰的记录保留旧读取行为：首次执行已返回完成结果的记录仍可再读取一次完成状态；
  后台结束后的最终输出仍可读取；`write_stdin` 读取完成记录后立即删除。
  已淘汰或已删除的 ID 沿用 `Unknown process`。
- 不增加过期时间、轻量完成状态、持久化或配置项；此前讨论过的相关方案均不采用。
- 总记录数上界为运行中任务数加 100；本专项不限制活跃进程数量。
- 本专项先于任务 2 实施，任务 2 → 任务 3 的相对顺序保持不变。

## 源码入口

- `packages/core/src/dscode-extension.ts`：命令、权限过滤与 MCP 初始化。
- `packages/core/src/managed-process.ts`：后台进程结果与生命周期。
- `packages/core/src/runtime-options.ts`：默认工具与参数解析。
- `packages/core/src/mcp.ts`：MCP 配置、连接与注册。
- `packages/http-adapter/src/agent-session-host.ts`：命令限制与 runtime 参数校验。
- `packages/http-adapter/src/ui-broker.ts`：浏览器 UI 事件与请求。
- `packages/web-ui/src/web-ui-runtime.ts`：Web 默认参数。
- `packages/web-ui/static/chat.js`、`app.js`：普通与诊断页面的显示。
