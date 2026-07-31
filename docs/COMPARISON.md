# DSCode vs Claude Code vs Codex

> 面向"正在用 Claude Code 或 Codex，考虑要不要换"的开发者。先说破一个最常见的
> 反驳，再给证据。

## 0. 先回答那个最尖锐的问题：Codex 也能接 DeepSeek，为什么要用 DSCode？

这是对的，DeepSeek 官方甚至提供了 [Codex 接入指南](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex/)。
但"能接"和"为它设计"是两回事：

**Codex + DeepSeek 是兼容层，DSCode + DeepSeek 是原生实现。**

- Codex 的沙箱、审批流、部分工具和用量统计绑定 OpenAI 模型。接第三方模型时
  要么降级、要么绕过，官方接入指南本身就是"配置 baseURL + 关闭不兼容特性"的
  妥协路径。
- DSCode 的 `src/deepseek.ts` 从第一行就是为 DeepSeek Responses API 写的：
  把 OpenAI 专属字段（`prompt_cache_key`、`prompt_cache_retention`、
  `include`）从请求中删掉，`apply_patch` 转成 Responses 原生 freeform
  custom tool，思考模式下清理无效采样参数，自动注入 `web_search`。这不是
  hack，是适配层。
- DSCode 的定价和缓存模型（`src/model.ts` 的 cacheRead 定价、`src/ui.ts`
  每轮缓存命中率）是为 DeepSeek 的**磁盘前缀缓存**设计的——缓存命中输入
  约 1/10 价格、跨会话持久。Codex 接 DeepSeek 时，prompt 结构和用量显示都
  不是按这个经济模型优化的，你也看不到 cache hit。

一句话：**Codex 接 DeepSeek 是"让别人的 runtime 勉强跑我们的模型"，
DSCode 是"runtime 和模型一起设计"。** 前者省的是配置时间，后者省的是
长会话和并行的真金白银。

## 1. 对比表格

| 维度 | DSCode | Claude Code | OpenAI Codex |
| --- | --- | --- | --- |
| 默认模型 | DeepSeek V4 Flash（Responses API） | Claude Sonnet/Opus | gpt-5-codex / codex-mini |
| 第三方模型（DeepSeek）适配 | **原生**：字段清理、原生 apply_patch tool、reasoning effort 透传、web_search 注入 | 不支持（闭源） | 兼容层：需配置 baseURL，部分特性降级 |
| 前缀缓存利用 | **围绕磁盘缓存设计**：稳定前缀、cache-aware compact、每轮显示命中率 | 无（模型侧缓存，产品不暴露） | 无（接第三方模型时更看不到） |
| 每轮成本可见性 | **每轮**：`tokens in (x% cached) · out · reasoning · $` | 会话结束才有成本（需 billing 集成） | 用量显示绑定 OpenAI 模型 |
| 并行 agent | **四角色**：explorer / implementer / reviewer / tester，最多 4 路，**implementer 独立 Git worktree**，写入隔离 | Task 子代理，跑主工作区，按 Opus 计费 | 子代理功能较新，同样跑主工作区 |
| 并行成本模型 | 低单价 + 高并发 → **并行是默认动作** | 并行是预算决策 | 并行是预算决策 |
| 默认网络策略 | **默认禁网**（Seatbelt `(deny network*)`） | 默认联网，需配置 deny 规则 | 默认联网，需配置 |
| 沙箱 | Seatbelt / Docker，workspace-write 默认 | 有权限系统 + 沙箱 | macOS Seatbelt / Linux Docker / Windows |
| 开源 / 可审计 | 开源（MIT），runtime 可 fork、可私有扩展 | 闭源（minified JS） | 开源（Apache 2.0），但完整特性绑 OpenAI |
| 运行时替换 | DeepSeek adapter 是干净分层，换模型/自托管是设计内路径 | 不可换 | 换模型是绕过，非设计内 |
| MCP / Skills / hooks / AGENTS.md | ✅ | ✅ | ✅ |
| 会话管理 | 树形 JSONL、fork / resume / compact、transcript diff | resume / fork / compact | resume / continue / checkpoints |
| 中文仓库优化 | **专项**：中文符号、构建日志、错误解释 | 无专项 | 无专项 |
| 1M 上下文 | ✅ | ✅（Sonnet 4.5） | 400k |
| 多模态 | ❌（V4 文本限定） | ✅ | ✅ |
| VS Code / IDE | 本地薄集成 + RPC + 语言诊断 | 官方扩展（更成熟） | 官方扩展 + 云任务（更成熟） |
| 生态成熟度 | 早期，社区小 | 最成熟 | 成熟 |

## 2. 我们真正有、他们没有的（重点）

### 2.1 磁盘前缀缓存 = 定价模型（结构性优势）

DeepSeek 的 KV 缓存是平台级特性：**写入硬盘、跨会话持久、命中输入约 1/10 价格**。
DSCode 围绕它做了三件事，代码可查：

- `src/model.ts`：cacheRead 定价进入成本计算；
- `src/ui.ts`：每轮状态栏显示 `tokens in (x% cached) · $`；
- `src/compaction.ts` + `src/prompt.ts`：system prompt / 工具定义 / 项目规则
  保持稳定前缀，compact 按缓存收益决定时机。

效果：**长会话和并行 agent 的边际成本趋近于零**。Claude Code 和 Codex 的缓存
是模型侧隐式行为，产品不暴露、不围绕它设计。这个优势绑定 DeepSeek 的定价
结构，不是抄 UI 能抄走的——Codex 用户即使接了 DeepSeek，也拿不到这套
cache-aware 设计。

### 2.2 四角色 worktree swarm（用法差异，不是功能差异）

`src/subagents.ts`：explorer（只读取证）/ implementer（独立 worktree 写入）/
reviewer（审 diff）/ tester（定位失败），最多 4 路并行，implementer 的候选
改动与其他 agent 写入隔离，主 agent 负责合并。

Claude Code 和 Codex 都有"子代理"按钮，但跑在主工作区、按旗舰模型计费——
**并行是预算决策**。DSCode 的低单价 + 高并发让**并行是默认动作**：主 agent
实现 + reviewer 审 diff + tester 验证 + 双候选竞争，在 V4 Flash 价格下是
免费的。这是成本结构决定的用法差异。

### 2.3 默认禁网（默认值差异）

`src/sandbox.ts`：默认生成 `(deny network*)` Seatbelt 规则。Claude Code /
Codex 默认联网，安全需要配置；DSCode 开箱即安全。对金融、政企、代码不出
内网的团队，这是开箱差异。

### 2.4 每轮成本透明

Claude Code 会话结束才有总成本；Codex 的用量显示绑定 OpenAI 计费（接
DeepSeek 后失效）。DSCode 每轮显示 token / 缓存命中率 / reasoning / 美元
（`src/ui.ts`），成本敏感团队可实时监控。

### 2.5 可替换的 runtime

Claude Code 闭源；Codex 开源但完整功能绑定 OpenAI。DSCode：MIT 开源、
`src/deepseek.ts` 是干净适配层、企业可自托管/私有扩展。换模型是设计内路径，
不是绕过。

### 2.6 中文仓库专项

针对中文符号、构建日志和错误解释的优化，两家没有这个市场针对性；且
DeepSeek 模型本身的中文能力是原生优势。

## 3. 诚实边界（我们还没有的）

- **多模态**：V4 文本限定，Claude Code / Codex 支持图片；
- **生态成熟度**：Claude Code / Codex 的 IDE 扩展、云任务、社区文档更成熟；
- **域名级网络 allowlist**：已列入路线图，未实现；
- **体验**：在真实仓库评测持续胜出前，不宣称全面超越（见
  `PRODUCT_STRATEGY.md` 的评测方法论——同一任务三工具 shadow eval，比
  成功率 × 时间 × 成本 × 安全）。

## 4. 一句话话术

> 你的工作流不用换，换的是成本结构：缓存命中输入打一折、跨会话持久；四路
> 并行 agent 是默认动作而不是奢侈动作；网络默认关；每轮多少钱写得明明白白。
> 这些不是功能，是经济结构——我们绑定了一个把长会话和并行做到边际成本
> 趋近于零的模型，而 Codex 接 DeepSeek 只是"让它能跑"，不是"为它设计"。

## 5. 迁移路径

```bash
pnpm install && pnpm check
export DEEPSEEK_API_KEY="sk-..."
dscode -C /path/to/project
```

- 项目里的 `CLAUDE.md` / `AGENTS.md` 直接沿用，无需改写；
- 交互习惯对齐：TUI、plan/ask/auto/full 权限、diff 逐文件审批、`/undo`；
- 用 `--continue` 从上次会话继续，用 `--fork <session-id>` 分叉实验。
