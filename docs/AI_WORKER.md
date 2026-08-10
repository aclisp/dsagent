产品定义

- 数字员工是一个运行 Web UI Server Agent 进程的容器实例。
- 它已有工作能力和持续记忆。
- 新增能力是根据用户安排，在指定时间主动工作并发送消息。
- 接入 IM 后，用户可以 @它工作、设置一次性提醒或安排周期性任务。
- 除固定 IM 群聊接入外，通用外部事件触发不在本 Feature 范围。

## 已验收依赖 Feature

- 私聊 Web UI 是面向非技术用户的交互入口，与诊断 Web UI 共享同一 Session；其产品定位、实现边界和验收约定见 [PRIVATE_CHAT.md](PRIVATE_CHAT.md)。
- AI_WORKER 接入群聊和定时任务后，私聊 Web UI 继续作为共享 Session 的用户入口和观测入口。

工作场景与会话

- 一个数字员工容器永久只能绑定一个群聊。
- 另一个群聊需要部署另一个数字员工容器。
- 每个 workspace 只激活一个 Session。
- 诊断 Web UI、私聊 Web UI、群聊和定时任务共享同一段会话上下文。
- 诊断 Web UI 是原始诊断界面，可以观察全部会话过程。
- 诊断 Web UI 和私聊 Web UI 发起的普通 Turn 不投递到群聊。
- 群聊 Turn 和定时任务 Turn 的结果可以投递到群聊。
- Server 启动时不主动激活 Session。
- 打开诊断 Web UI、私聊 Web UI、收到群聊请求或任务到期时，才懒加载最新 Session；没有历史时创建。
- 配置多个 workspace 时，主动任务和 IM 只使用 WORKSPACES 中的第一个条目。

任务配置

任务文件：

    <第一个 workspace>/.dscode/schedules.yaml

默认容器路径：

    /workspace/.dscode/schedules.yaml

状态文件：

    /workspace/.dscode/schedules.status.json

任务模型：

    version: 1
    tasks:
      - id: weekday-status-report
        enabled: true
        type: cron
        cron: "0 18 * * 1-5"
        prompt: |
          检查今天的工作情况并向群里发送总结。

      - id: contract-reminder
        enabled: true
        type: once
        at: "2026-08-12T09:00:00+08:00"
        prompt: |
          提醒群里跟进合同签署。

配置约束

- 只支持 once 和 cron。
- 周期任务使用 5 段 Cron。
- 周期任务统一继承容器 TZ，不保存单独时区。
- TZ 必须是有效 IANA 时区；缺失或无效时 Server 启动失败。
- 一次性任务使用带偏移的 RFC 3339 时间。
- 一次性任务只要已经过期，就自动改为 enabled: false，不补执行。
- 周期任务最低间隔为 5 分钟。
- 最多保存 100 个任务，包括暂停任务。
- schedules.yaml 最大 1 MiB。
- 每个 prompt 最大 32 KiB。
- id 最长 64 个字符，只允许小写字母、数字和连字符。
- 禁止 YAML 重复键。
- 配置无效时整份拒绝，不部分加载，也不自动修正。

Agent 管理任务

- Agent 使用现有 read 和 apply_patch 直接管理 YAML。
- 不新增任务 CRUD HTTP API，也不修改 Pi。
- 内置定时任务 Skill 教 Agent 使用配置格式。
- Agent 写入后必须读取 schedules.status.json，确认对应内容哈希已经 valid，才能告诉用户任务创建成功。
- 意图明确时直接创建、修改、暂停、恢复或删除。
- 时间或任务内容有歧义时必须追问。
- 向普通用户使用自然语言确认实际时间或周期。
- 不主动展示内部任务 ID。
- 不向普通用户展示或解释 Cron 表达式。

配置加载

- 文件不存在时视为空任务列表。
- 启动时文件无效，Server 仍然启动，但不加载任务。
- 运行期间文件变为无效，继续运行上一份有效配置。
- Server 监听目录变化，并支持 Agent 的原子文件替换。
- 状态文件记录内容哈希、valid 或 invalid、错误、加载时间和任务数量。

任务执行

- 任务触发后通过现有 Session Turn 流程进入正常 Agent Loop。
- 不直接执行 Shell 命令。
- 不通过 Host Loopback HTTP。
- 调度 Prompt 只增加一行：

    [Scheduled task: <id>]

- 不增加其他时间或来源文本。
- 不新增 Session API 的 source、origin、taskId 或 runId。
- clientId 保持浏览器回显抑制语义。
- 内部使用 turnId 关联任务运行和消息投递。

任务生命周期

- 一次性任务到期后保留任务记录，并改为 `enabled: false`，不再执行，也不补跑。
- 一次性任务 failed、aborted 或提交重试耗尽后，同样改为 `enabled: false`。
- 周期任务 failed 或 aborted 后保持启用，等待下一个周期。
- 已返回 202 的 Turn 不自动重新运行，避免重复副作用。
- 修改、暂停或删除任务只影响未来触发，不中止已开始的 Turn。
- 同一个周期任务上一轮未结束时，跳过下一次触发，不排队。
- 不补跑容器停机期间错过的周期。
- 不设置 Turn 超时；卡住时由 Web UI 手工 Stop。

忙碌与重试

- 不建立中央队列。
- 不抢占当前 Turn。
- 人工请求撞上忙碌状态时直接丢弃，并回复：

    我正在处理其他工作，刚才的请求没有被记录。请稍后重新 @我发送一次。

- 定时任务提交失败时，首次立即尝试，之后最多重试 5 次。
- 间隔为 10、20、40、80、160 秒，并加入正负 20% 抖动。
- 400 等确定性错误不重试。
- Session 不存在时先懒加载，再继续当前尝试。
- 同一任务 occurrence 只有一条重试链。

IM 产品行为

- IM 绑定是可选能力。
- 未绑定 IM 时，定时任务仍执行，结果留在共享 Session。
- 绑定 IM 后，所有定时任务结果都发送到固定群聊，无论任务从 Web UI 还是群聊创建。
- 不支持私有定时任务。
- 首个平台选择飞书。
- 首期只处理纯文本。
- 每一条请求都必须明确 @数字员工。
- 普通群消息、机器人自己的消息、隐式回复和引用消息都不触发。
- 群内任何成员都有完整使用权限，包括管理定时任务和调用 Agent 工具。
- 群成员资格由飞书负责管理，数字员工不维护白名单。

群聊消息格式

入站 Prompt 增加发送者标记：

    [Group message from 张三]

senderName 缺失时使用：

    [Group message]

投递行为：

- 不发送“收到，我开始处理”的接单消息。
- 只投递 completed output。
- failed 和 aborted 不发送群消息，只在 Web UI 可见。
- completed output 为空时发送：

    任务已经完成

- 用户请求的最终结果和忙碌提示回复到原始 messageId。
- 定时任务结果作为群里的新消息发送。
- 暂不支持图片、文件、语音、富文本卡片和附件下载。

Webhook 与去重

Webhook 路径：

    POST /webhooks/im

- URL 不包含 workspaceId、groupChatId 或平台名称。
- 固定群聊变量统一命名为 groupChatId。
- 容器配置使用 IM_GROUP_CHAT_ID。
- CLI 标准化结果必须返回 groupChatId。
- 只有与容器配置完全匹配的群事件可以触发 Turn。
- 其他群事件静默忽略。
- CLI 返回稳定 eventId。
- Server 使用最多 10,000 项、TTL 24 小时的内存去重表。
- 去重状态不持久化，容器重启后允许极小概率重复处理。

CLI 边界

基础配置：

- IM_CLI
- IM_GROUP_CHAT_ID

行为：

- 两者都不存在时关闭 IM。
- 只配置一个时启动失败。
- 同时配置时检查 CLI 存在并可执行。
- Web UI Server 不保存或读取飞书凭证。
- CLI 负责凭证、Token、验签、解密、事件解析、平台消息格式和发送 API。
- Web UI Server 只负责 Webhook HTTP 入口、Session 调度和内部消息关联。
- CLI 按次启动，不常驻，也不使用 Loopback HTTP。
- 固定子命令为 webhook 和 send。
- 输入通过 stdin JSON。
- 输出通过 stdout JSON。
- stderr 只用于诊断。
- 不通过命令行参数传递消息、Header、群 ID或凭证。
- Server 直接 spawn，不通过 Shell。

消息投递重试

- completed output、空输出兜底和忙碌提示使用同一投递器。
- 临时失败最多重试 5 次。
- 间隔为 10、20、40、80、160 秒，并加入正负 20% 抖动。
- CLI 返回 retryAfter 时优先采用。
- 永久错误不重试。
- 不重新运行 Agent。
- 不保存持久化 Outbox。
- 容器重启后不恢复未完成投递。
- 最终失败只记录诊断日志，结果仍保留在 Web UI Session。

安全与诊断

- 飞书凭证由 CLI 配置文件管理。
- 凭证不进入参数、Prompt、Session、任务文件或日志。
- 生命周期日志只写容器 stdout。
- 日志包含必要的 taskId、runId、eventId、turnId 和 attempt。
- 不记录 Prompt、Output、senderName、完整 groupChatId 或 workspaceId。
- 不新增日志数据库、管理页面或历史查询 API。
- Session REST、SSE 和事件字段保持不变。
- HTTP Adapter 只增加通用的进程内事件订阅能力。

## 实施 Slice

- 已验收前置 Feature：私聊 Web UI（详见 [PRIVATE_CHAT.md](PRIVATE_CHAT.md)）。
- Slice 1：HTTP Adapter 通用进程内事件订阅。
- Slice 2：完整的一次性与周期性任务能力。
- Slice 3：通用 IM CLI 集成，使用测试 CLI 验证。
- Slice 4：你调研 CLI 后完成真实飞书命令映射。
- 每个 Slice 完成后停止，等待你验收。
- 浏览器和 Live Verification 由你手工完成。
- 每个 Slice 的实现改动保持未暂存、未提交；用户验收后再按明确指令处理 Git。
- 当前 docker-compose.yml 的用户改动不纳入本 Feature。

唯一有意保留的后续项，是实际飞书 CLI 的选择、命令映射及平台级格式限制；它属于 Slice 4，不影响前三个 Slice 的边界。
