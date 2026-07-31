# DSCode 产品策略

## 结论

DSCode 不应以“又一个 Claude Code 兼容壳”为目标。可成立的产品命题是：

> 面向本地仓库、中文开发者和高并发工程团队，提供与 DeepSeek V4 Flash 深度协同、成本透明、
> 可替换且可评测的 coding-agent runtime。

短期目标是达到 Claude Code/Codex 的编码闭环可靠性，中期用 V4 Flash 的极简 harness、1M
上下文、自动前缀缓存和低调用成本，赢下“长任务吞吐/成本”和“团队可定制性”。在自己的真实仓库
评测没有持续胜出前，不宣称全面超过任何竞品。

## V4 Flash 带来的设计约束

### 1. 极简工具面是主路径

DeepSeek 公布的 Code Agent 成绩使用 DeepSeek Harness 极简模式和 `max` effort。DSCode 默认只暴露：

- `exec_command`：搜索、读取、构建、测试和 Git 检查；
- `apply_patch`：唯一写入路径，采用 Responses 原生 freeform custom tool。

这能减少模型在多个语义重叠工具之间选择的负担，也避免大 patch 被 JSON 转义。细粒度工具集作为
`safe` 回退保留，而不作为性能主路径。

### 2. Responses 是协议，不是托管会话

DeepSeek Responses API 无状态，不支持 `previous_response_id`、服务端 conversation、store 或自动
truncation。Runtime 必须负责：

- 完整回放消息、推理和工具调用；
- 本地会话持久化；
- 输入预算和 400 前的主动压缩；
- 自己保证 Web Search item 的正确回放；
- 将未支持参数从请求中清理掉。

### 3. Context 要 cache-first，而不是无限塞

1M context 并不意味着每轮扫描整个仓库。正确策略是：

1. system prompt、工具定义、项目规则保持稳定；
2. 先用 `rg` 定位，再读相关范围；
3. 大命令输出保留错误附近和末尾总结，不把几 MB 日志送回模型；
4. 历史达到预算阈值后，将早期工作压缩为含路径、决策、测试结果和未完成项的结构化摘要；
5. 展示 cache hit，持续发现破坏稳定前缀的 runtime 改动。

### 4. Effort 要按任务动态调度

V4 Flash 支持 `low`、`high`、`max`。最终形态不应让用户每次手选：

- `low`：仓库搜索、状态查询、小解释、格式化；
- `high`：普通修复、单模块重构、测试诊断；
- `max`：跨模块修改、陌生大型仓库、反复失败后的恢复、最终 code review。

当前 CLI 默认 `max` 以贴近官方 Code Agent 基准，也可用 Pi 的 thinking selector 或
`Shift+Tab` 即时切换。后续是否加入自动 router，应由真实任务评测决定，避免启发式降档损失
首次成功率。

### 5. 低成本的价值在并行，而不只是省钱

缓存命中输入、普通输入和输出价格较低，同时 V4 Flash 官方并发上限较高。真正的产品优势应是把
预算用于可靠性：

- 主 agent 实现；
- 独立 reviewer 检查 diff；
- test agent 定位失败；
- 大仓库的只读探索 agent 并行收集证据；
- 对关键任务进行两个候选方案的廉价竞争。

但并行 agent 必须使用独立 worktree/只读角色和明确的合并所有权，否则冲突会抵消收益。

## 与 Claude Code / Codex 的现实比较

| 维度 | Claude Code / Codex 的成熟能力 | DSCode 的机会 | 当前状态 |
| --- | --- | --- | --- |
| 编码闭环 | 搜索、编辑、Shell、验证、长任务恢复 | V4 原生 minimal harness | 已实现并有模拟 API 集成测试 |
| 交互体验 | 完整 TUI、diff review、历史、后台任务、IDE | 复用 `pi-tui`/`pi-coding-agent`，不重造基础设施 | TUI 完整；VS Code 为本地薄集成 |
| 安全 | 权限规则；Codex 还有 OS sandbox | 策略层可定制，企业可接自己的沙箱 | 四档权限、checkpoint、Seatbelt/Docker |
| 扩展 | MCP、skills、hooks、项目指令 | Pi 扩展生态 + 开放 runtime | 已接入，并受 project trust 约束 |
| 长上下文 | 成熟的压缩与会话管理 | V4 1M + 自动硬盘前缀缓存 | 树形 JSONL、自动/手动 compact |
| 多 agent | 子 agent、后台/云任务、worktree | V4 Flash 的成本和并发可支撑更激进并行 | 四角色、四并发、implementer worktree |
| 多模态 | 图片、文件和 UI 工作流 | 可由外部视觉模型/工具补足 | V4 Responses 目前文本限定 |
| 透明度 | 产品内状态与用量能力不同 | 每轮展示 token、cache hit、reasoning、cost | 已有基础指标 |
| 本地/团队控制 | 闭源产品行为可配置但 runtime 不可替换 | Pi runtime 可审计、可 fork、可私有扩展 | 这是结构性优势 |

因此，`0.3.0` 已补齐本地 CLI 的主要产品层能力，但仍不能只凭功能清单宣称体验超过 Claude Code
或 Codex。最危险的误判，是把模型 benchmark 或“有这个按钮”当成完整产品 benchmark。

## 目标架构

```text
CLI / TUI / IDE
       │
session · plan · approvals · diff review · undo
       │
task router ── low / high / max ── subagents / worktrees
       │
Pi agent loop
       │
DeepSeek adapter
  Responses replay · apply_patch · web search · cache metrics
       │
execution boundary
  workspace policy · shell policy · container / VM sandbox
       │
local repo · MCP · skills · language servers · test runners
```

## 路线图与 0.3.0 状态

### P0：可信可用（主体完成）

- 已有模拟 DeepSeek Responses SSE 的完整 Pi JSONL 集成测试；真实 API 由 `pnpm smoke:live` 验收；
- 已有 macOS Seatbelt 和 Docker 后端，默认禁网；域名级网络 allowlist 仍待实现；
- 已有实时 patch、逐文件确认、持久 checkpoint、冲突保护 undo；
- Pi 按模型 context window 自动压缩，也支持 `/compact`；
- Pi 分层加载父级规则，DSCode engineering contract 要求修改深层目录前发现适用的嵌套规则；
- 会话写入、子进程密钥隔离和输出截断已有回归测试。

### P1：一线 coding-agent 体验（完成）

- Pi TUI：多行编辑、历史、消息排队/打断、工具/思考折叠、diff 和状态栏；
- 会话列表、命名、fork、tree、resume、compact 和 DSCode checkpoint；
- print、JSONL、RPC、CI 退出码；
- MCP、skills、sandboxed hooks、用户/仓库配置和 project trust；
- VS Code 本地扩展、IDE 选区、IDE diagnostics、自动语言 checker；
- 后台命令的 process id、轮询、输入、终止与 `/jobs`。

### P2：形成 V4 差异化

- effort router：按任务风险、上下文和失败次数自动切换档位；
- FIM fast path：局部补全/小编辑走非思考 FIM，复杂任务走 Responses agent；
- cache-aware context planner：稳定前缀、cache hit 回归告警、按收益选择压缩时机；
- worktree swarm：explorer、implementer、reviewer、test-fixer 并行且写入隔离；
- 面向中文仓库的符号、构建日志和错误解释优化；
- 企业策略包：私有 MCP、审计事件、命令/网络 allowlist 和自托管 sandbox。
- swarm 自动择优、候选 diff 安全集成与 worktree 生命周期管理；
- 基于真实 API 的 reasoning replay、Web Search 长会话与缓存命中回归门禁。

## 用评测定义“更好”

至少建立三层评测：

1. **离线工具评测**：patch 正确性、路径逃逸、审批分类、输出截断、session replay；
2. **固定仓库任务**：bugfix、跨文件 feature、测试修复、重构、依赖升级、前端视觉任务；
3. **团队真实任务 shadow eval**：同一 issue 分别交给 DSCode、Claude Code、Codex，在隔离分支运行。

每个任务记录：

- 最终测试是否通过、是否引入回归；
- 首次成功率与人工接管率；
- wall time、模型调用次数、工具调用次数；
- 输入/输出/reasoning tokens、cache hit、总成本；
- 审批次数、越权尝试、无关 diff；
- reviewer 对正确性、可维护性和解释质量的盲评。

只有在指定任务簇上持续改善“成功率 × 时间 × 成本 × 安全”后，才对外表达为具体优势，例如：
“在本团队 TypeScript 服务任务集上，同等通过率下成本降低 X%、耗时降低 Y%”，而不是笼统说
“比 Claude Code/Codex 更强”。

## 当前实现已经落地的 V4 优化

- Responses API 默认通道，Chat Completions 作为 fallback；
- `minimal`/`safe` 双 harness；
- `apply_patch` 原生 custom tool、多文件预校验与逐文件原子写入；
- 默认 `max`，运行时支持 thinking selector 和 `Shift+Tab` 切换；
- 始终启用 Pi 的并行 tool execution；
- 清理 DeepSeek 不支持的 Responses 字段和思考模式下无效的采样参数；
- 工作区权限模式和 plan mode；
- 自动/手动 context compaction；
- 每轮 cache hit、reasoning token 和费用可见。
- Pi TUI、树形 JSONL session、fork/resume/compact；
- Seatbelt/Docker OS sandbox、默认禁网、checkpoint/undo；
- MCP、Agent Skills、hooks、project trust；
- 后台进程、四角色 worktree subagents、JSONL/RPC 和 VS Code 薄集成。

## 官方资料

- [DeepSeek V4 Flash 更新日志](https://api-docs.deepseek.com/zh-cn/updates/)
- [DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
- [DeepSeek 接入 Codex](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/)
- [DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)
- [DeepSeek 上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)
- [DeepSeek 模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- [Pi agent toolkit](https://github.com/earendil-works/pi)
- [Codex best practices](https://learn.chatgpt.com/guides/best-practices)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
