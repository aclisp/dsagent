# AI Worker

## 产品定义

- 数字员工是一个运行 Web UI Server Agent 进程的容器实例。
- 它已有工作能力和持续记忆。
- 新增能力是根据用户安排，在指定时间主动工作并发送消息。
- 接入 IM 后，用户可以 @它工作、设置一次性提醒或安排周期性任务。
- 除固定 IM 群聊接入外，通用外部事件触发不在本 Feature 范围。

## 已验收依赖 Feature

- 私聊 Web UI 是面向非技术用户的交互入口，与诊断 Web UI 共享同一 Session；其产品定位、实现边界和验收约定见 [PRIVATE_CHAT.md](PRIVATE_CHAT.md)。
- AI_WORKER 接入群聊和定时任务后，私聊 Web UI 继续作为共享 Session 的用户入口和观测入口。

## 工作场景与会话

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

## 任务配置

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
        delivery: group
        prompt: |
          检查今天的工作情况并向群里发送总结。

      - id: contract-reminder
        enabled: true
        type: once
        at: "2026-08-12T09:00:00+08:00"
        delivery: session
        prompt: |
          提醒我跟进合同签署。

### 配置约束

- 只支持 once 和 cron。
- delivery 只支持 session 和 group，并且每个任务必须显式配置。
- session 表示结果只保留在共享 Session，通过 Web UI 查看；group 表示结果还会投递到固定群聊。
- 周期调度使用 `croner` 包，只接受其原生 Cron pattern，不定义自有方言；支持 Croner 提供的 5、6、7 段、昵称、名称和扩展语法。
- 周期任务统一继承容器 TZ，不保存单独时区。
- TZ 必须是有效 IANA 时区；缺失或无效时 Server 启动失败。
- 一次性任务使用带偏移的 RFC 3339 时间。
- 相邻两次实际 Cron 触发时间的间隔不得低于 5 分钟。
- 有限 Cron pattern 不再存在未来触发时间时，保留任务、自动改为 `enabled: false`，并标记为 exhausted。
- 最多保存 100 个任务，包括暂停任务。
- schedules.yaml 最大 1 MiB。
- 每个 prompt 最大 32 KiB。
- id 最长 64 个字符，只允许小写字母、数字和连字符。
- 禁止 YAML 重复键。
- 配置无效时整份拒绝，不部分加载，也不自动修正。

### Agent 管理任务

- Agent 使用现有 read 和 apply_patch 直接管理 YAML。
- 不新增任务 CRUD HTTP API，也不修改 Pi。
- 内置定时任务 Skill 教 Agent 使用配置格式。
- Agent 写入后必须读取 schedules.status.json，确认对应内容哈希已经 valid，才能告诉用户任务创建成功。
- 意图明确时直接创建、修改、暂停、恢复或删除。
- 时间、任务内容或结果投递范围有歧义时必须追问。
- Web UI 请求默认使用 `delivery: session`；群聊请求默认使用 `delivery: group`；用户明确指定时覆盖默认值。
- 向普通用户使用自然语言确认实际时间或周期。
- 确认任务时使用“仅在 Web UI 查看”或“同时发送到群聊”等自然语言说明投递范围。
- 创建 `delivery: group` 任务但当前没有绑定 Chat Provider 时，任务仍然有效，Agent 必须提示当前结果只会留在 Web UI，未来触发时若已绑定才会发送到群聊。
- 不主动展示内部任务 ID。
- 不向普通用户展示或解释 Cron 表达式。

### 配置加载

- 文件不存在时视为空任务列表。
- 即使文件不存在，Server 也创建有效的空 `schedules.status.json`，记录 `TZ`、加载时间、内容哈希、任务数量和当前群聊投递可用性。
- 启动时文件无效，Server 仍然启动，但不加载任务。
- 运行期间文件变为无效，继续运行上一份有效配置。
- Server 监听目录变化，并支持 Agent 的原子文件替换。
- 状态文件无法可靠写入时采用 fail-closed：启动时无法写入则 Server 启动失败；运行中写入失败则已提交 Turn 继续，但暂停提交新的定时 Turn，恢复后从下一个未来触发点继续且不补跑。
- 调度器自动禁用任务时使用内容哈希进行乐观合并；不得覆盖 Agent 的并发编辑。目标任务已经修改、暂停或删除时取消旧定义的待提交执行，无法安全合并时不提交该次 Turn。
- `schedules.status.json` 是调度器管理的派生文件。Agent 只读取，不编辑；外部删除、损坏或修改时由调度器重建，不作为控制指令。

### 状态文件

- 状态文件记录版本、配置内容哈希、valid 或 invalid、经过清理的字段错误、加载时间、任务数量、`TZ` 和群聊投递可用性。
- 每个任务只保留有界运行快照：`scheduleStatus`、`currentRun`、`lastRun` 和 `lastSkip`，不建立完整历史数据库。
- `currentRun` 表示正在提交或执行的 occurrence；`lastRun` 保留最近一次实际提交链的最终结果；`lastSkip` 单独保存最近一次 overlap、late、状态不可写或配置变更取消，不覆盖真实执行结果。
- 执行结果区分 completed、failed、aborted、submission_failed、cancelled 和 interrupted；调度状态区分 active、paused 和 exhausted。
- group 投递结果独立记录 pending、delivered、failed、unavailable 或 abandoned；session 使用 not_applicable。投递失败不改变 completed 执行结果。
- prompt、Agent output、堆栈和 Provider 原始响应不写入状态文件；校验错误只包含字段路径和原因，不回显敏感字段值。
- 任务定义哈希匹配时运行快照跨重启保留。切换 enabled 保留快照；修改 prompt、type、at、cron 或 delivery 时清除旧快照；删除任务时删除快照；复用 id 不继承旧定义状态。
- 重启时遗留的 submitting 或 running 记为 interrupted，未确认的群聊投递记为 abandoned；不重新提交或投递。

### 任务执行

- 任务触发后通过现有 Session Turn 流程进入正常 Agent Loop。
- 不直接执行 Shell 命令。
- 不通过 Host Loopback HTTP。
- 调度 Prompt 只增加一行：

    [Scheduled task: <id>]

- 不增加其他时间或来源文本。
- 不新增 Session API 的 source、origin、taskId 或 runId。
- clientId 保持浏览器回显抑制语义。
- 内部使用 turnId 关联任务运行和消息投递。
- delivery 为 session 和 group 的任务使用同一套调度、提交重试、Turn 执行、状态记录和生命周期处理。
- delivery 只控制 completed output 是否额外投递到群聊，不影响任务是否执行或支持的任务类型。
- delivery 为 group 的任务显式登记其 turnId，由 Headless Chat Client 将 completed output 投递为群内新消息。
- delivery 为 session 的任务不登记群聊投递，结果只保留在共享 Session。
- 没有绑定 Chat Provider 时，group 任务仍然执行，结果保留在共享 Session，本次投递记为 unavailable；不排队、不补投，也不自动修改 delivery。
- Headless Turn 没有浏览器所有者。遇到交互 UI 请求时立即采用安全兜底：confirm 拒绝，select、input 和 editor 取消；观察中的 Web UI 可以显示请求但不能代为回答。
- 私聊 Web UI 将 `[Scheduled task: <id>]` 对应的用户行显示为居中的“定时任务”事件卡，正文取 prompt 第一行、合并换行并截断到约 120 个字符，不显示任务 ID、Cron、delivery 或 run 元数据；诊断 Web UI 保持原始事件。

### 任务生命周期

- 任务 occurrence 提供 at-most-once 保证，不提供 exactly-once 或 at-least-once。持久化已消费状态后、提交 Turn 前崩溃可能造成漏执行，但重启后不补跑。
- 一次性任务到期后先通过原子写入将 `enabled` 改为 false，成功后才提交 Turn；任务记录继续保留。自动禁用写入失败时不提交 Turn。
- 周期任务 failed 或 aborted 后保持启用，等待下一个周期。
- 已返回 202 的 Turn 不自动重新运行，避免重复副作用。
- 修改、暂停或删除任务立即取消尚未接受的旧定义重试链，但不中止已接受的 Turn；修改后的任务按新定义计算未来触发，不回补旧周期。
- 同一个周期任务上一轮仍在提交重试或执行 Turn 时，跳过下一次触发，不排队。Agent Turn 到达终态后即解除 overlap 保护，群聊投递重试不阻止下一轮执行。
- 无论容器停机、Server 重启、系统休眠还是事件循环长时间阻塞，错过的 once 和 cron occurrence 都不补跑。回调延迟不超过 60 秒视为正常抖动，超过 60 秒记为 late 并跳过；一次性任务保持禁用，周期任务等待下一个未来触发点。
- 不设置 Turn 超时；卡住时由 Web UI 手工 Stop。

### 忙碌与重试

- 不建立中央队列。
- 不抢占当前 Turn。
- 人工请求撞上忙碌状态时直接丢弃，并回复：

    我正在处理其他工作，刚才的请求没有被记录。请稍后重新 @我发送一次。

- 定时任务提交失败时，首次立即尝试，之后最多重试 5 次。
- 间隔为 10、20、40、80、160 秒，并加入正负 20% 抖动。
- 400 等确定性错误不重试。
- Session 不存在时先懒加载，再继续当前尝试。
- 同一任务 occurrence 只有一条重试链。
- 多个任务同时到期时，首次提交按 `schedules.yaml` 中的任务顺序进行；其余任务各自进入 busy 重试链，不保证后续仍保持 YAML 顺序。重试耗尽后记为 submission_failed，不补跑。

## Chat Client 架构

Chat Client 是参与共享 Session 的交互入口。当前和计划中的实例包括：

- `chat.html` / `chat.js` / `chat.css`：面向普通用户的 Browser Chat Client。
- `index.html` / `app.js` / `style.css`：面向诊断的 Browser Chat Client。
- `packages/chat-client`：面向 IM 的 Headless Chat Client，包名为 `@thinkany/dscode-chat-client`。

三者共享 Session 语义，但不强制共享实现。两个已验收的 Browser Chat Client 继续使用 REST 和 SSE，本 Feature 不为了抽象 Chat Client 而重构它们。

Headless Chat Client 的依赖方向为：

    Chat Provider -> Chat Client -> 进程内 Session Port
           ^               |
           +---- 消息投递 <-+

### 进程内 Session Port

- HTTP Adapter 提供通用的进程内 Session Port。
- Session Port 支持按 workspace 懒加载最新 Session、提交 Turn，以及订阅 Turn 终态事件。
- Turn 提交返回 accepted 和 turnId，或者返回 busy。
- 终态事件只需要提供 completed、failed、aborted 及 completed output。
- Browser Chat Client 和 Headless Chat Client 共用同一个 Session Controller 的单 Turn 并发、懒加载和生命周期约束。
- Headless Chat Client 不通过 Host Loopback HTTP 提交 Turn，也不消费 SSE。
- 现有 Session REST、SSE 和事件字段保持不变。

### Headless Chat Client 责任

- 不依赖 Fastify、Webhook、CLI、IM SDK 或具体 IM 平台。
- 接收 Chat Provider 标准化后的纯文本群聊请求。
- 校验请求是否来自容器绑定的唯一 groupChatId。
- 完成内存去重、Prompt 格式化、Turn 提交和忙碌处理。
- 使用内存映射关联 turnId 与原始 messageId。
- 只投递由自己提交或显式登记的 Turn；未关联的 completed 事件一律忽略。
- 为定时任务保留“将已提交 Turn 的结果投递为群内新消息”的通用入口。
- 不保存或读取 IM 凭证，不接触平台原始请求。

## IM 产品行为

- IM 绑定是可选能力。
- 未绑定 IM 时，定时任务仍执行，结果留在共享 Session。
- 绑定 IM 后，delivery 为 group 的定时任务结果发送到固定群聊，无论任务从 Web UI 还是群聊创建。
- delivery 为 session 的私有定时任务只在共享 Session 中可见，不发送群消息。
- Web UI 和群聊都可以创建 session 或 group 投递范围的任务。
- 首期只处理纯文本。
- 每一条请求都必须明确 @数字员工。
- 普通群消息、机器人自己的消息、隐式回复和引用消息都不触发。
- 群内任何成员都有完整使用权限，包括管理定时任务和调用 Agent 工具。
- 群成员资格由 IM 平台管理，数字员工不维护白名单。
- 首个真实 IM 平台及其接入方式在 Provider Slice 中决定，不构成通用 Chat Client 的约束。

### Chat Provider 边界

Chat Provider 负责具体 IM 平台的所有传输和协议细节，包括：

- 通过 Webhook、WebSocket、长轮询、SDK、CLI 或平台专有方式接收消息。
- 管理凭证和 Token，完成验签、解密、握手和平台回应。
- 解析平台事件，识别显式 @，并过滤普通群消息、机器人自己的消息和其他不应触发的事件。
- 将有效请求标准化后交给 Headless Chat Client。
- 将 `reply(messageId, text)` 和 `send(groupChatId, text)` 映射为平台投递操作。
- 将投递错误分类为成功、可重试或永久失败，并在平台可提供时返回 retryAfter。

Headless Chat Client 不定义 Provider 如何启动、监听或注册路由。Provider 在获得有效消息后主动调用 Chat Client，因此通用层不假设必然存在 Webhook 或常驻进程。
Provider 最终可以实现为仓库子包、部署模块或可执行程序；通用 Chat Client 不约束它的打包和部署形式。

### 标准化入站消息

Provider 交给 Headless Chat Client 的首期消息包含：

    dedupeKey: string
    groupChatId: string
    messageId: string
    senderName?: string
    text: string

- 这些字段是产品语义，不要求 IM 平台使用相同名称或原生提供相同结构。
- `dedupeKey` 是 Provider 为同一入站请求提供的稳定去重标识。
- `messageId` 是 Provider 可用于回复原始消息的不透明标识。
- 固定群聊变量统一命名为 `groupChatId`，具体配置来源由 Provider 实现决定。
- 只有与容器绑定值完全匹配的群聊请求可以触发 Turn，其他请求静默忽略。
- Headless Chat Client 使用最多 10,000 项、TTL 24 小时的内存去重表。
- 去重状态不持久化，容器重启后允许极小概率重复处理。

### 群聊 Prompt 与投递

入站 Prompt 增加发送者标记：

    [Group message from 张三]

`senderName` 缺失时使用：

    [Group message]

投递行为：

- 不发送“收到，我开始处理”的接单消息。
- 人工请求遇到 busy 时，忙碌提示回复到原始 `messageId`。
- Turn 接受后，Headless Chat Client 记录 `turnId -> messageId` 关联。
- 只投递已关联 Turn 的 completed output。
- 诊断 Web UI 和私聊 Web UI 提交的 Turn 没有该关联，不会投递到群聊。
- failed 和 aborted 不发送群消息，只在 Web UI 可见。
- completed output 为空时发送：

    任务已经完成

- 用户请求的最终结果回复到原始 `messageId`。
- 定时任务结果作为群里的新消息发送。
- 定时任务群消息只包含 completed output，不添加“定时任务”标题、任务 ID、Cron、计划时间或其他调度元数据。
- 暂不支持图片、文件、语音、富文本卡片和附件下载。

### 消息投递重试

- completed output、空输出兜底和忙碌提示使用同一投递器。
- 临时失败最多重试 5 次。
- 间隔为 10、20、40、80、160 秒，并加入正负 20% 抖动。
- Provider 返回 retryAfter 时优先采用。
- 永久错误不重试。
- 不重新运行 Agent。
- 不保存持久化 Outbox。
- 容器重启后不恢复未完成投递。
- 最终失败只记录诊断日志，结果仍保留在 Web UI Session。
- 定时任务 failed、aborted、submission_failed、overlap、late 和最终投递失败都不发送群聊通知，避免周期性刷屏。

### 安全与诊断

- IM 凭证由 Chat Provider 管理，Headless Chat Client 不保存、读取或转发凭证。
- 凭证不进入命令行参数、Prompt、Session、任务文件或日志。
- 生命周期日志只写容器 stdout。
- 日志包含必要的 taskId、runId、dedupeKey、turnId 和 attempt。
- 不记录 Prompt、Output、senderName、完整 `groupChatId` 或 workspaceId。
- 不新增日志数据库、管理页面或历史查询 API。
- 公开 Session API 不新增 source、origin、taskId、runId 或 Provider 字段。

## 实施 Slices

- 已验收前置 Feature：私聊 Web UI（详见 [PRIVATE_CHAT.md](PRIVATE_CHAT.md)）。
- Slice 1：HTTP Adapter 进程内 Session Port。提供懒加载、Turn 提交和终态事件订阅，保持现有 REST 和 SSE 不变。
- Slice 2：通用 `packages/chat-client`。使用 Fake Session Port 和 Fake Delivery 验证去重、busy、Turn 关联、completed 投递和非关联 Turn 隔离。
- Slice 3：Web UI Server 组合。在 Server 内组合 Session Port 和 Headless Chat Client，使用可替换的测试 Provider 完成进程内集成验证，不增加公开测试路由。
- Slice 4：为 delivery 为 session 和 group 的任务完整实现一次性与周期性调度、配置加载、提交重试、状态记录和生命周期管理。两者都通过共享 Session 执行；session 的结果仅保留在共享 Session，绑定 IM 时 group 的结果再通过 Headless Chat Client 的通用主动投递边界发送群消息。
- Slice 5：首个真实 Chat Provider。调研选定 IM 平台后，按它的实际协议决定使用 Webhook、SDK、长连接、CLI 或其他实现。
- 每个 Slice 完成后停止，等待你验收。
- 浏览器和 Live Verification 由你手工完成。
- 每个 Slice 的实现改动保持未暂存、未提交；用户验收后再按明确指令处理 Git。
- 当前 docker-compose.yml 的用户改动不纳入本 Feature。

实际 IM 平台、接收方式、凭证管理、平台响应、消息投递和格式限制都是 Chat Provider 的实现细节；它们留到 Slice 5 根据实际协议决定，不影响前四个 Slice 的通用边界。
