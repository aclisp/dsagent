# DSCode 与 Claude Code、Codex 的对比

[English](COMPARISON.en.md)

## 产品定位

Claude Code 和 Codex 是覆盖面更广、成熟度更高的 coding-agent 产品。DSCode 是规模更小、取舍更
明确，默认围绕 DeepSeek V4 Flash 构建、同时可选 OpenAI API 和 Codex 套餐模型的 runtime。

DSCode 的价值并不是“竞品没有 agent、worktree、sandbox 或扩展”——这些能力它们都有。真正的
区别是设计中心：

> DSCode 保留围绕 DeepSeek 优化的本地 runtime，同时允许需要视觉能力的任务切换到
> OpenAI/Codex 模型。

## 当前对比

| 维度 | DSCode | Claude Code | Codex |
| --- | --- | --- | --- |
| 设计中心 | 本地仓库、DeepSeek 默认与 provider 选择 | 面向 Claude 的通用 coding 工作流 | 覆盖 CLI、IDE、桌面和云端的 OpenAI coding 工作流 |
| DeepSeek 接入 | 专用 Responses adapter、无状态回放、effort 映射、payload 清理、原生 freeform patch tool | DeepSeek 提供 Anthropic 兼容接口，并公开了 Claude Code 集成方式 | 通用 runtime；DSCode 不对第三方 provider 下的功能对齐做未经验证的断言 |
| 模型接入与图片 | DeepSeek API key、OpenAI API key 或符合条件的 ChatGPT 套餐；支持视觉的模型可接收图片 | Claude 账号/API 接入与多模态能力 | ChatGPT 套餐或 OpenAI API 接入与多模态能力 |
| Context 与成本 | 1M context；`/status` 展示 DeepSeek 缓存命中、token、reasoning 和预估费用 | 产品自己的 context 与用量统计 | 产品自己的 context 与用量统计 |
| 并行工作 | 内置四角色，最多四路并行；implementer 使用独立 Git worktree | subagent、后台 agent、agent team 和 worktree 隔离 | subagent，以及部分产品界面的 worktree |
| 安全 | 默认工作区 sandbox、命令禁网、按命令批准网络/宿主机访问、持久 patch checkpoint | 可配置的权限与 sandbox，支持文件系统和网络控制 | OS sandbox、审批，以及本地命令默认禁网 |
| Runtime 所有权 | MIT runtime，DeepSeek adapter 集中且可修改 | 完整产品 runtime 非开源；sandbox runtime 单独开源 | 开源 CLI，以及更广泛的 OpenAI 产品界面 |
| 扩展 | `AGENTS.md`、`CLAUDE.md`、Skills、hooks、MCP、JSONL、RPC | 项目指令、skills、hooks、MCP、plugins | `AGENTS.md`、skills、hooks、MCP、plugins、SDK、app server |
| 产品成熟度 | 早期项目；VS Code 为本地薄集成 | 成熟的 CLI、IDE、桌面、多模态和团队工作流 | 成熟的 CLI、IDE、桌面、云端、多模态和自动化工作流 |

## DSCode 的差异化

### 1. DeepSeek 专用 Responses runtime

`src/deepseek.ts` 不是简单替换 `base_url`。它会删除不支持的 OpenAI 字段、映射 reasoning 行为、
把 `apply_patch` 转换为原生 freeform custom tool，并可选注入服务端 Web Search。本地树形 JSONL
会话负责回放无状态的消息、reasoning item 和工具结果。

### 2. 缓存与成本透明

DeepSeek 的硬盘前缀缓存会降低重复前缀的成本，并返回 cache-hit token。DSCode 直接建模
cache-read 价格，通过 `/status` 展示当前缓存、token、reasoning 和费用。Provider 价格会变化，
因此这里不再硬编码具体折扣，统一以 [DeepSeek 官方价格页](https://api-docs.deepseek.com/quick_start/pricing/)为准。

### 3. 有明确角色的并行工作

DSCode 不要求每个项目重新设计 agent 角色，默认提供：

- `explorer`：只读仓库调查
- `implementer`：在独立 worktree 中生成候选改动
- `reviewer`：只读独立审查
- `tester`：聚焦测试与故障诊断

最多四路任务并行，主 agent 负责集成和最终验证。Claude Code 和 Codex 同样支持并行 agent 与
worktree；DSCode 的区别是开箱角色模型，以及利用 DeepSeek V4 Flash 的成本与并发结构。

### 4. 本地、可检查的控制

DSCode 将会话保存在本地，命令使用 OS 强制 sandbox，默认禁止命令联网，从子进程环境中删除
模型 provider API key，并在每次成功 patch 后创建持久 checkpoint。带冲突保护的 `/undo` 不会覆盖
checkpoint 之后被再次修改的文件。

### 5. 小而可 fork 的 runtime

项目使用 MIT License，并把 provider 专用行为集中在 adapter。团队可以检查和修改 prompt、权限、
工具、会话、MCP、hooks 和 sandbox，而不依赖托管控制面。

## 我们不做的宣传

- 不宣称 DSCode 全面优于 Claude Code 或 Codex。
- 不把并行 agent、worktree、sandbox、skills、hooks 或 MCP 说成 DSCode 独有。
- 不把低 API 价格描述成“并行免费”。
- 不把 1M context 描述成无需搜索、定点读取和 compact。
- 支持兼容模型的图片输入，但不宣称已经追平竞品的云端、IDE、多模态工作流或生态成熟度。

正确的比较方式，是在相同真实仓库任务上做 shadow eval，记录成功率、耗时、成本、安全、无关
diff 和人工接管率，而不是比较功能清单。

## 官方资料

- [DeepSeek V4 发布说明](https://api-docs.deepseek.com/news/news260424/)
- [DeepSeek 模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)
- [Claude Code 并行 agent](https://code.claude.com/docs/en/agents)
- [Claude Code subagent 与 worktree](https://code.claude.com/docs/en/sub-agents)
- [Claude Code sandbox](https://code.claude.com/docs/en/sandboxing)
- [Codex subagent](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex worktree](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [Codex sandbox](https://learn.chatgpt.com/docs/sandboxing)
- [Codex 认证](https://learn.chatgpt.com/docs/auth)
- [Codex 图片输入](https://learn.chatgpt.com/docs/image-inputs)
