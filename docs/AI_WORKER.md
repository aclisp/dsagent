# AI Worker 产品需求

本文只记录 AI Worker 的产品能力、用户可见规则和验收约束，不记录实现步骤、代码结构或
Slice 开发历史。部署与信任边界的决策依据见
[ADR-0001](decisions/0001-wecom-deployment-trust-boundary.md)，启动、配置、部署和日常使用说明见
[packages/web-ui/README.md](../packages/web-ui/README.md)。

## 产品定义与范围

- 数字员工是一个拥有工作能力和持续记忆的 Agent 服务实例。
- 用户可以让数字员工立即工作，也可以安排一次性提醒或周期性工作。
- 普通 Web UI、诊断 Web UI、所有已接入的 IM Provider 以及定时任务共享同一个 workspace、
  Session、历史、文件、工具效果和运行时状态。
- 首个真实 IM Provider 是企业微信智能机器人；通用模型允许同一 workspace 将来同时启用企业微信、
  飞书、钉钉等多个 Provider，但本期不实现其他真实 Provider。
- 通用外部事件触发以及未列明的语音、视频、卡片等消息类型不在本期范围。

## 部署、会话与权限

- 产品部署约束是一企业一 Docker 实例、一 workspace 和一套 IM 凭证；不同企业不能共用实例、
  workspace 或凭证。
- 应用保持现有 `WORKSPACES` 行为，不新增单 workspace 启动校验；IM 和 Scheduler 继续使用第一个
  workspace。
- 一个 workspace 只激活一个共享 Session；群聊、单聊、Provider 类型和任务来源都不是 Session
  或安全隔离边界。
- 服务启动时不主动激活 Session；首次打开页面、收到合法 IM 请求或任务到期时才加载或创建会话。
- 普通用户通过 `/chat/<workspaceId>` 与数字员工对话；诊断人员通过 `/debug/<workspaceId>` 查看
  底层过程。现有 HTTP、SSE 和 workspace 访问契约保持不变。
- 同一实例中的所有合法 IM conversation 属于同一组织和信任域，均可使用数字员工的完整工作能力，
  并可查看、创建、修改、暂停、恢复和删除该 workspace 的全部定时任务。
- IM 平台和具体 Provider 负责成员资格、鉴权、真实 mention、签名或加解密；数字员工不另行维护
  conversation 或成员 ACL。
- 一个共享 Session 同一时间只执行一个 Turn。Web UI、群聊或单聊的人工请求撞上忙碌状态时立即
  拒绝，不记录、不排队；群聊提示用户稍后重新 @数字员工，单聊提示用户稍后重新发送。

## IM conversation 与来源标记

- 通用层使用 conversation reference 表示 Provider、`group` 或 `direct` 类型以及 Provider 可用于
  回复或主动发送的内部地址；平台原始字段由 Provider 解析。
- 每个 conversation 首次收到合法触发消息时登记一个随机、全局唯一、不可反推平台地址的稳定
  opaque alias；同一 Provider 地址之后复用该 alias，alias 不包含 Provider、类型或原始 ID。
- 每个发送者同样登记稳定的 opaque sender alias。同一 Provider 中相同用户复用 alias；不同 Provider
  不自动合并为同一个人。
- Provider 原始 conversation ID、用户 ID、凭证和协议字段不得进入 Prompt、共享 Session 或任务
  配置。Prompt 使用以下统一 marker：

  ```text
  [IM message: group=conv-abc123; sender=sender-def456]
  [IM message: direct=conv-abc123; sender=sender-def456]
  ```

- marker 只帮助 Agent 识别当前来源和受众，不决定回复路由，也不模拟 Session 隔离。
- IM Turn 的最终回复由内部 `Turn → conversation reference` 关联送回原消息所在的群聊或单聊；
  failed 和 aborted 不额外发送失败消息，completed output 为空时发送固定的完成提示。
- 普通 Web UI 只把来源显示为“群聊”或“单聊”，不展示 conversation alias、sender alias、Provider
  名称或原始 marker；诊断 UI 保留原始内容和技术信息。

## 定时任务能力

### 用户能力与投递范围

- 支持一次性任务和周期性任务，投递范围只定义两种值：
  - `session`：结果保留在共享 Session 中，不主动发送到 IM；
  - `source`：结果保留在共享 Session 中，并主动发送回创建任务的原始 IM conversation。
- Web UI 创建的任务必须使用 `session`；Web UI 没有 IM source，不能创建 `source` 任务。
- 群聊或单聊创建的任务必须使用 `source`，由系统自动绑定当前 conversation；用户和 Agent 都不能
  填写、选择或替换目标地址。
- 任务创建后投递类型不可改变：`session` 不能转换为 `source`，`source` 不能转换为 `session`，
  source conversation 也不能改投。若需改变投递语义，应删除旧任务后从目标入口重新创建。
- 任一 IM conversation 或 Web UI 都可管理全部现有任务的提示词、时间、类型、暂停/恢复状态和删除
  状态；管理 source 任务不会改变其原始绑定。
- `source` 任务执行产生的 Turn 继承原 source；该 Turn 创建的新任务自动绑定同一 conversation。
  `session` 任务产生的 Turn 没有 source，其新任务使用 `session`。
- 用户通过自然语言表达任务内容、时间和周期；Agent 负责转换为任务定义。存在实质歧义时必须先
  追问，普通用户不需要了解内部任务 ID、Cron 表达式、alias 或运行元数据。
- Agent 修改任务后，必须确认配置已被 Scheduler 接受，才能向用户报告成功。

### 任务规则

- 周期任务只接受 Croner 原生 Cron 语法，不定义额外方言；支持 Croner 提供的 5、6、7 段及其
  名称、昵称和扩展语法。
- 所有周期任务使用服务实例的 IANA `TZ` 时区；不为单个任务保存独立时区。
- 一次性任务使用带 `Z` 或显式偏移量的 RFC 3339 时间。
- 相邻两次实际周期触发时间不得少于 5 分钟。
- 任务数量最多 100 个，单个任务提示词最多 32 KiB；任务 ID 最长 64 个字符，只允许小写字母、
  数字和连字符。
- 任务定义无效时整份拒绝，不部分加载、不自动修正；运行中的上一份有效定义继续生效。
- 周期模式不再产生未来时间时，任务保留但自动停止并标记为已耗尽；一次性任务成功消费到期点后
  停止，任务记录仍保留。
- 用户看到的任务状态是有限的当前运行、最近运行和最近跳过摘要，不承诺完整历史。
- 修改任务内容、时间或类型后，旧定义的运行快照不能被新定义继承；暂停、恢复和删除必须立即影响
  后续触发。
- 服务重启、关机、休眠或事件循环阻塞期间错过的触发不补跑。回调延迟超过 60 秒视为迟到并跳过。
- 同一周期任务上一轮仍在提交或执行时，下一次触发直接跳过；Agent Turn 结束后解除重叠保护，
  投递重试不阻塞下一轮。

### 执行、忙碌与投递失败

- 任务通过与普通请求一致的 Agent 工作流程执行，并共享同一 Session 记忆。
- 任务 Prompt 使用 `[Scheduled task: <id>]` marker；`source` 任务增加
  `source=<conversation-alias>`，帮助 Agent 理解受众。实际路由不依赖模型输出。
- 定时任务没有浏览器所有者。需要 `confirm` 时拒绝；需要 `select`、`input` 或 `editor` 时取消，
  不能等待人工输入。
- 定时任务遇到全局 busy 时保留现有提交重试：首次立即尝试，之后最多重试 5 次，间隔为 10、20、
  40、80、160 秒并加入有限抖动；不建立中央队列或按 conversation 排队。
- occurrence 采用 at-most-once 语义；已接受的 Turn 不自动重新运行。
- source alias 无法解析、目标 Provider 未配置或 Provider 启动失败时，本次投递立即记为
  `unavailable`，不重试、不回退、不排队、不补投。
- Provider 已接受投递尝试但返回临时错误时，按同一组退避间隔最多重试 5 次；永久错误或重试耗尽
  记为 `failed`。
- Agent 执行失败、被中止、提交失败、重叠、迟到、`unavailable` 或最终投递失败时，不向任何其他
  conversation 广播失败消息。投递结果不改变 Agent Turn 自身的执行结果。
- 服务重启后不恢复未完成投递；不设置 Agent Turn 自动超时，卡住的工作由 Web UI 手工停止。

## 企业微信 Provider

- 企业微信接入是可选能力；未配置或运行时不可用时，Web UI、Scheduler 和其他 Provider 仍可运行。
- 配置缺字段或格式非法时 Server 启动失败；配置完整但连接、鉴权或 Provider 启动失败时隔离该
  Provider，不拖垮其他入口。
- Provider 不使用固定群聊或发现流程；除 Bot ID、Secret、Bot Name 和可选 WS URL 外，不需要额外的
  群聊配置、企业微信专用控制 API、按钮或任务管理后台。
- 群聊只有带真实 mention 的合法消息才触发。可见文本中出现 `@数字员工` 不等于平台真实 mention；
  对已经收到的有效回调，mention 可以出现在文本任意位置，交给 Agent 前去掉该 mention。
- 单聊中的合法消息直接触发，不要求 mention。
- 群聊支持文本、图文混排和引用图片/文件；单聊支持文本、图文混排、独立图片、独立文件以及文本中
  引用的图片/文件。只有附件而没有正文时使用固定的附件提示作为 Turn 正文。
- 语音、视频、卡片事件、机器人自己的消息和其他不支持的消息类型静默忽略。
- 入站图片和文件写入 workspace 的 `uploads/` 目录，并使用与普通 Web UI 相同的附件 Prompt；下载
  失败时仍创建 Turn，并把失败信息交给 Agent。
- Agent 在最终文字中明确引用的 workspace 文件可以作为原生图片或文件附件追加发送；文字交付优先，
  附件失败不重试文字或额外通知 conversation。
- 企业微信凭证只用于 Provider 连接和投递，不得进入 Prompt、Session、任务配置或日志。入站媒体受
  `MAX_UPLOAD_BYTES` 限制；出站单次最多 5 个文件并受企业微信媒体上传限制。

## 多 Provider 与故障隔离

- 同一 workspace 可以同时启用多个 Provider；它们共享 Session 和全局单 Turn 并发，不建立按
  Provider 隔离。
- 每个 Provider 独立负责协议、凭证、事件过滤、消息规范化、回复映射、主动发送、媒体能力和错误
  分类。通用层不假设 Webhook、WebSocket、SDK、CLI 或某个平台字段。
- 一个 Provider 运行时失败不会停止其他 Provider、Web UI 或 Scheduler。对应 conversation 的主动
  投递按 `unavailable` 或 `failed` 处理。
- 同一套企业微信 `bot_id/secret` 只支持一个 Docker 实例；应用不实现 lease、协调服务、统一
  ingress 或多实例连接所有权检测。

## 安全、隐私与可观察性

- workspace 地址是访问凭证；只有持有完整高熵地址的用户才能打开对应 Web UI。
- Agent 输出、Prompt、凭证、显示名、原始 conversation ID、用户 ID 和 workspace ID 不写入普通
  生命周期日志或普通 UI 状态。
- 普通日志只使用必要的任务、Turn、去重和投递诊断字段，不回显敏感值。
- 配置错误只说明字段路径和原因；IM 失败不通过其他 conversation 放大。
- 产品不提供独立任务管理后台或通用外部事件入口；任务管理通过已有 Web UI 和 IM 对话能力完成。

## 验收标准

- 同一实例中的企业微信群聊和单聊都能进入共享 Session；marker 能稳定区分 conversation 和发送者，
  普通 UI 只显示“群聊”或“单聊”。
- 群聊保持真实 mention 触发；单聊无需 mention。约定范围内的图片和文件能进入共享 Session，明确
  引用的产物能作为原生附件发回原 conversation。
- 通用组合支持同一 workspace 同时启用多个 Fake Provider，所有来源仍共享 Session 和全局 busy。
- 任一 IM conversation 或 Web UI 都能管理全部定时任务，但不能改变既有任务的投递类型或 source。
- IM 新建任务自动使用 `source` 并绑定当前 conversation；Web UI 新建任务使用 `session`。source
  scheduled Turn 创建的新任务继承 source。
- source 任务结果只主动发送到原 conversation；不可用、失败和重启场景不回退、不广播、不排队、
  不补投。
- 任务继续满足时区、间隔、数量、大小、at-most-once、重叠、迟到、busy 重试和状态持久化规则。
- 任务管理和消息接入只使用 `delivery: session | source` 语义，不依赖固定群聊或企业微信专用控制面。
- 浏览器 HTTP、SSE、workspace 访问和共享 Session 行为保持不变；`packages/core` 不需要修改。
- 同凭证多实例连接所有权不由应用保证。
