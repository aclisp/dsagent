# ADR-0001：IM 部署实例、共享 Session 与任务来源投递边界

- 状态：已接受，Slice 1-4 已验收；引用与语音后续增强已实现，待人工验收
- 日期：2026-08-27
- 更新：2026-08-29

## 背景

DSCode 的数字员工首先是一个拥有工作能力和持续记忆的人。一个 workspace 承载它的工作目录、
工具执行、Session 历史、定时任务、Web UI 和 IM 通道。普通 Web UI、诊断 Web UI、IM 消息和
定时任务有意使用同一个共享 Session。

早期企业微信方案用 `IM_WECOM_GROUP_CHAT_ID` 指定一个固定群聊，并把普通消息接入、定时任务
管理范围和定时任务结果投递混在一起。这个模型既不能表达单聊，也不能让同一组织内的其他群聊
自然使用数字员工的完整能力；同时，当前 Compose 部署无法可靠保证同一个 Bot ID 只有一个有效
连接所有者。

产品已经确定以下前提：一个 Docker 实例只服务一个企业；不同企业使用不同实例、workspace 和
`bot_id/secret`。同一实例收到的群聊和单聊都属于同一组织、同一信任域。数字员工应当对它接触过
的所有对话保持感知，因此这些对话共享 Session、历史、文件、工具和运行时状态。

当前只有企业微信 Chat Provider，但同一企业未来可能同时启用企业微信、飞书、钉钉等多个 Chat
Provider。多个 Provider 收到的群聊和单聊仍属于同一组织、同一信任域，不因 Provider 不同而建立
专门的 Session、历史、任务或运行时隔离。

## 决策

### 1. 部署与信任边界

1. 一个 Docker 实例、一个 workspace 和一个共享 Session 共同构成一个企业级数字员工实例。
2. 同一 workspace 可以同时启用多个 Chat Provider。普通 Web UI、诊断 Web UI、所有已接入 Provider
   的合法群聊和单聊，以及定时任务，都使用同一个 Session 和同一份历史；不因 Provider 不同而隔离。
3. 群聊和单聊是共享 Session 中的对话来源，不是 Session 或安全隔离边界。模型可以感知其他
   对话的历史；文件、工具效果、Git 工作树、任务状态和运行时状态也有意共享。
4. 不同企业必须使用不同的 Docker 实例、workspace 和 IM 凭证；一个实例不合并不同企业的信任域。
5. 一个共享 Session 同一时间只执行一个 Turn。任一群聊、单聊或 Web UI 请求撞上正在执行的工作时，
   可以收到 `busy`，不排队；这是有意保留的全局工作状态。
6. 一实例一 workspace 是部署约束，不新增应用启动校验。现有 `WORKSPACES` 多条目行为保持不变，
   IM 和 Scheduler 继续使用第一个 workspace。

### 2. 通道无关的对话来源

1. 通用 Chat Client 使用 Provider 无关的 conversation reference 区分消息来源。reference 至少
   表示 Provider、`group` 或 `direct` 类型，以及该 Provider 可用于回送消息的内部地址；这个地址
   不要求都叫 `chatid`，群聊可以是群会话 ID，单聊可以是用户 ID 或其他等价地址。原始协议字段由
   Chat Provider 负责解析。
2. conversation 第一次收到合法触发消息时，登记随机、全局唯一且不可反推平台地址的稳定 opaque
   alias；相同 Provider 地址后续复用 alias。alias 不编码 Provider、`group`/`direct` 类型或原始 ID。
   发送者也登记稳定的 opaque sender alias；同一 Provider 的相同用户复用 alias，不跨 Provider
   自动合并身份。
3. 每条 IM 消息进入 Agent Prompt 时，都带有来源 marker。marker 统一使用 `[IM message ...]` 形
   式，群聊/单聊类型、conversation alias 和 sender alias 等 metadata 全部放在同一对中括号内；
   这与现有 `[Uploaded files ...]`、`[Scheduled task ...]` 等 Prompt marker 的约定一致：
   - 群聊：`[IM message: group=<conversation-alias>; sender=<sender-alias>]`；
   - 单聊：`[IM message: direct=<conversation-alias>; sender=<sender-alias>]`。
4. marker 只帮助数字员工识别当前谈话的受众和来源，不模拟 Session 隔离，也不改变共享历史。
5. 普通 UI 只显示“群聊”或“单聊”，不显示 opaque alias、Provider 名称或内部协议字段；诊断 UI
   可以查看原始 marker 和技术信息。
6. 对入站 IM Turn 的最终回复回到触发该 Turn 的原始群聊或单聊。回复路由由 Chat Client 保存的
   Turn 与 conversation reference 决定，不依赖模型输出的文本。
7. Chat Provider 负责鉴权、签名或加解密、真实 mention 判断、消息规范化、原始回复映射、媒体
   能力和重试分类；通用层不假设 Webhook、WebSocket、SDK 或某个 IM 平台的字段。

### 3. 定时任务管理范围

1. 所有 IM 群聊和单聊都可以管理定时任务，不存在由固定群聊配置产生的会话分类。
2. IM 会话可以管理该 workspace 内的全部定时任务，而不只是当前会话或当前用户创建的任务。
3. “管理定时任务”包括查看/列出、创建、修改、暂停、恢复和删除。
4. 定时任务管理复用现有 workspace 任务配置和调度器管理逻辑；普通 Web UI、诊断 Web UI 和 IM
   入口遵循相同的校验、读写和状态语义，不因来源不同增加文件或工具访问限制。系统提示词和 skill
   负责说明使用方式与用户体验；任务配置的校验、读写和状态更新由现有任务管理逻辑负责。

### 4. 定时任务投递语义

任务的投递范围是通用字段，定义 `session` 和 `source` 两种值。

#### `delivery: session`

- 任务仍在共享 Session 中执行，结果保留在共享历史中；
- 结果不主动发送到 IM，只能通过 Web UI 或后续对话查看；
- Web UI 发起的任务默认使用 `session`。Web UI 没有 IM conversation source，因此不创建
  `source` 任务。

#### `delivery: source`

- 任务在创建时记录发起它的 IM conversation reference；
- 任务运行结果保留在共享 Session 中，并作为一条新的主动消息发送回该 conversation；
- `source` 同时支持群聊和单聊；持久化的是 Provider 无关的稳定 conversation alias，不是企业微信
  专属的原始 ID；
- source 是任务创建来源的路由元数据，不是任意用户可填写的目标地址。后续由其他 IM 会话或 Web
  UI 管理该任务时，不得把结果任意改投到另一个会话；任务的来源投递关系保持不变；
- Agent 管理的任务配置只声明 `delivery: source`，不保存可填写的目标。Scheduler 在自己的持久化
  状态中维护 `taskId -> conversation alias`，根据当前 Turn 的内部 source context 自动建立绑定。

因此，IM 会话发起的定时任务必须使用 `delivery: source`，且 source 自动取当前会话；不能改成
`session`，也不能指定另一个群聊或单聊。Web UI 发起的任务使用 `session`。任务的提示词、时间、
类型、暂停/恢复状态和删除状态，任一 IM 会话或 Web UI 均可管理。

任务创建后，`session` 与 `source` 之间不能互相转换，既有 source 也不能改投。需要改变投递语义时，
删除旧任务并从目标入口创建新任务。source 任务产生的 Scheduled Turn 继承原 source，该 Turn 新建
的任务继续绑定同一 conversation；session Scheduled Turn 新建的任务使用 `session`。

任务运行和投递遵循以下规则：

1. `source` conversation 当前不可用时，任务仍执行并保留结果；本次主动投递标记为不可用，不回退
   为 `session`，不排队等待，也不在重启后补投。
2. 主动投递失败不改变 Agent 工作本身的执行结果，不因投递失败向其他会话广播失败消息。
3. 任务与普通请求一样使用共享 Session；如果另一个群聊、单聊或 Web UI 正在执行，任务按全局
   busy 规则处理。人工请求立即返回 busy；Scheduled Turn 保留现有的 10、20、40、80、160 秒提交
   重试链，不建立中央队列或按 conversation 排队。
4. source 任务的 Prompt marker 使用
   `[Scheduled task: <id>; source=<conversation-alias>]`，帮助 Agent 理解受众；实际投递仍只使用
   Scheduler 保存的绑定。
5. alias 无法解析、Provider 未配置或启动失败时立即记为 `unavailable`，不重试。Provider 已接受
   尝试后返回的临时错误保留现有最多五次投递重试；永久错误或重试耗尽记为 `failed`。

### 5. 旧的固定群聊配置和企业微信专用控制面不再存在

1. 删除 `IM_WECOM_GROUP_CHAT_ID`、任何固定群聊状态或持久化文件，以及所有依赖该配置的运行时分支。
2. 不新增企业微信专用控制 API、企业微信按钮或独立任务管理后台。
3. 不保留用于设置固定群聊的通用 skill；普通或诊断 Web UI 只提供现有的 workspace 访问和对话入口。未来
   其他 IM Provider 直接复用 conversation、任务管理和 source 投递语义，而不是复制企业微信
   控制流程。
4. 不再要求通过 `wecom-discover` 或类似流程选择任务群聊；IM conversation 在收到合法消息时由
   Provider/Chat Client 识别并登记，任务 source 使用该通道无关身份。

### 6. 企业微信连接所有权是部署约束，不是本 ADR 的实现范围

1. 企业微信是首个 Chat Provider，但 conversation、任务管理和投递规则不以企业微信字段建模。
2. 同一套 `bot_id/secret` 只允许运行一个 Docker 实例；不同企业必须使用不同凭证和实例。
3. 当前 Compose 部署无法从应用内保证同一个 Bot ID 只有一个有效连接所有者。应用不实现 lease、
   协调服务、统一 ingress 或其他连接所有权机制；误启动多个同凭证实例属于不受支持的部署方式。
4. 将来如果出现一个 Bot ID 服务多个独立实例的真实需求，再单独评估权威 ingress 或连接协调方案。
5. 企业微信群聊保留外层真实 mention 触发；引用中的 mention 不触发，但外层只有真实 mention 且
   引用有效时仍创建 Turn。群聊支持文本、图文混排，以及引用的文本、图文混排、语音转写、图片和
   文件；单聊在此基础上增加独立图片、独立文件和独立语音转写。独立群聊语音、视频和卡片事件不在
   支持范围。

### 7. 实现边界

1. 本决策不要求修改 `packages/core` 模块；通道来源登记、任务管理入口和 source 投递适配在现有
   Chat Client、HTTP/Web UI、调度器和具体 Provider 边界内完成。
2. 浏览器 Web UI 的现有 HTTP、SSE 和 workspace 访问契约保持不变。
3. Provider 专属的 ID、凭证和协议细节不得进入 Prompt、共享 Session 历史或任务配置；跨 Chat
   Client、Scheduler 和任务配置持久化的路由身份只使用通道无关 conversation alias。Provider/registry
   可以在内部持久化 alias 对应的实际发送地址，但不得把它暴露给上述边界。
4. 同一 workspace 的通用组合支持多个 Provider。配置错误仍阻止启动；配置完整但单个 Provider
   连接、鉴权或运行时启动失败时隔离该 Provider，不停止其他 Provider、Web UI 或 Scheduler。
5. 不为旧 `delivery: group`、固定群聊配置或发现流程实现兼容和升级路径；新模型只认识
   `delivery: session | source`。

## 被拒绝或推迟的方案

### 按群聊或单聊拆分 Session、workspace 或实例

数字员工需要对企业内接触过的所有对话保持连续感知。拆分 Session 会割裂记忆，却仍需额外解决共享
文件、工具、任务和运行时状态；拆分 workspace 或实例则增加部署与运维成本，当前信任边界不需要
这些隔离，因此不采用。

### 用固定群聊配置限制普通消息或任务管理

固定群聊配置不能表达单聊，也会把“谁能使用数字员工”和“任务结果发到哪里”混为一谈。既然同一
实例内的所有 IM 来源属于同一信任域，就不再设置由固定群聊配置产生的会话分类。

### 用固定群聊作为任务投递目标

固定群聊无法表达“任务结果回到发起会话”，也会让不同群聊之间互相覆盖投递目标。`source` 让目标
随任务创建来源确定，并同时适用于群聊和单聊。

### 企业微信专用控制 API、按钮或单独后台

这些方案会把通道细节扩散到产品控制面，未来每个 IM Provider 都需要复制一套流程；任务管理应当
通过已有的 Web UI 和通用 IM 对话能力完成。

### 每个 conversation 独立的任务 ACL

用户明确要求同一 workspace 内所有 IM 会话可以管理全部任务。额外的“创建者所有权”或按会话 ACL
会增加状态和访问控制分支，也不符合一个企业级数字员工共享工作空间的产品语义。

### 应用内连接所有权协调

当前部署模型已经规定一企业一实例一套 IM 凭证。Compose 无法可靠保证唯一连接所有者，但建设 lease
或 ingress 的收益不足以覆盖当前复杂度，因此推迟到出现多实例需求后再决策。

## 后果

### 正面后果

- 一个数字员工在企业内拥有连续、共享的记忆，所有群聊和单聊都能使用完整的普通工作能力；
- 定时任务不再需要固定群聊配置或企业微信专属配置，IM 任务可以自然回到发起它的会话；
- 所有 IM 会话共享同一套任务管理能力，避免“当前会话只能看自己的任务”的额外访问控制模型；
- 通用层只认识 Provider 和 conversation，后续接入其他 IM 通道无需复制企业微信控制面；
- 不修改 core 模块，保持实现范围和迭代成本可控。

### 接受的代价

- 不同群聊和单聊的内容、文件、工具效果和任务状态有意互相可见；
- Prompt marker 不能保证共享历史中的上下文绝不串扰；
- `source` 投递依赖来源 conversation 当前仍可用；不可用时不会补投或自动回退；
- 所有来源共享单 Turn 并发，忙碌时用户需要稍后重新发送；
- 同凭证运行多个实例时可能争抢企业微信长连接，应用本轮不检测或协调。

## 验收标准

1. 同一实例收到的群聊和单聊消息都能进入共享 Session；marker 使用稳定 opaque conversation 和
   sender alias 区分具体来源，普通 UI 只显示“群聊”或“单聊”。
2. 同一 workspace 同时启用多个 Chat Provider 时，各 Provider 的群聊和单聊仍进入同一个共享
   Session，不建立按 Provider 的隔离。
3. 任一 IM 群聊或单聊都能查看、创建、修改、暂停、恢复和删除该 workspace 的全部定时任务。
4. IM 创建的任务自动使用 `delivery: source`，运行结果只主动发送到创建时的原始群聊或单聊。
5. Web UI 创建的任务默认使用 `delivery: session`，结果不主动发送到 IM。
6. 任务管理不依赖 `IM_WECOM_GROUP_CHAT_ID`、固定群聊相关状态或 skill、企业微信按钮或专用控制 API。
7. source 不可用时任务仍执行并保留共享 Session 结果，不回退、不排队、不补投。
8. 任意来源撞上正在执行的共享 Session 时遵循全局 busy 行为，不新增按会话排队。
9. 同一 `bot_id/secret` 多实例连接所有权不由应用保证；连接所有权协调机制不在本 ADR 范围内。
10. 任务创建后不能改变 `session`/`source` 或 source 绑定；source Scheduled Turn 创建的新任务继承
    原 source。
11. 群聊继续要求外层真实 mention，单聊无需 mention；约定范围内的引用内容、语音转写、图片和文件
    可以进入共享 Session，并回送明确引用的产物。
12. 单个 Provider 运行时失败不拖垮其他 Provider、Web UI 或 Scheduler；`unavailable` 与发送失败
    遵循已确认的重试和不补投语义。

## 实施 Slices

> 状态：Slice 1-4 已验收；后续引用与语音增强已实现，等待人工验收。每个 Slice 独立
> 实现、验证并停止等待验收；验收前不自动进入下一 Slice，不暂存、不提交。

### Slice 1：conversation identity 与持久化基础

目标是先建立通道无关且不依赖现有固定群聊接口的身份边界，不切换运行时行为。

> 状态：已验收。验证：`packages/chat-client` test、typecheck、build 全部通过。

- 在 `packages/chat-client` 定义 Provider identity、`group | direct` conversation reference、sender
  reference 和 opaque alias 数据模型。
- 实现按 Provider 地址复用、随机生成、永不回收复用的 conversation/sender alias registry；持久化
  原始路由地址只存在 registry，任务配置和 Session 只接触 alias。
- 提供按 alias 解析 conversation、Provider 缺失和 registry 缺失时的明确结果，为后续
  `unavailable` 语义建立端口。
- 使用原子写入和最小权限保存 registry；不修改 `packages/core`，不改变 HTTP/SSE。
- 聚焦验证：alias 随机性与稳定复用、Provider/类型/地址碰撞隔离、sender 不跨 Provider 合并、重启
  恢复、损坏或缺失状态不把 alias 误投到其他 conversation。
- Green gate：`packages/chat-client` test、typecheck、build。

### Slice 2：多 conversation Chat Client 与内部 Turn source context

目标是把 Headless Chat Client 从固定群聊切换到 conversation 模型，并保持浏览器契约不变。

> 状态：已验收。验证：`packages/chat-client`、`packages/http-adapter`、`packages/web-ui`
> 及受影响的 `packages/wecom` test、typecheck、build 全部通过。

- 用通用入站消息替换 `InboundGroupMessage`、`groupChatId` 和固定群过滤；去重键包含 Provider
  identity，回复目标保存原始 conversation/reply reference。
- 生成已确认的群聊/单聊 marker；群聊和单聊分别使用带 @、不带 @ 的 busy 提示。
- 扩展进程内 Session Port/Controller 的内部 Turn context，使 IM Turn 携带 source alias，终态清理
  关联；不向公开 REST、SSE、Session 消息字段增加 Provider 或 source。
- Web UI Server 支持组合多个 Provider，共享一个 Session Port；单个 Provider 运行时启动失败时隔离，
  不停止其他入口。
- 普通 Web UI 识别新 marker，只展示“群聊”或“单聊”，诊断 UI 保留原始 marker。
- 使用多个 Fake Provider 验证共享 Session、全局 busy、Turn 回复隔离、alias 路由、Provider 故障隔离
  和 UI 来源解析。企业微信在本 Slice 只做满足新通用接口的最小适配，仍不扩展消息范围。
- Green gate：`packages/chat-client`、`packages/http-adapter`、`packages/web-ui` 及受影响的
  `packages/wecom` test、typecheck、build。

### Slice 3：Scheduler 的 `session | source` 语义

目标是让任务来源绑定成为 Scheduler 强制执行的路由元数据，而不是 Skill 约定。

> 状态：已验收。验证：`packages/web-ui`、`packages/chat-client`、
> `packages/http-adapter`、`packages/wecom` test、typecheck、build，以及根构建和 diff check 全部通过。

- 任务 schema 只接受 `delivery: session | source`；不实现 `group` 兼容或迁移。
- 新增 Scheduler-owned source binding 状态，保存 `taskId -> conversation alias`。新 source 任务只从
  当前 IM/source Scheduled Turn 自动绑定；没有 source context 时不能创建 source 任务。
- 强制既有任务 delivery 和 source 不可变；删除后从新入口创建才形成新语义。普通修改、启停和删除
  继续允许所有 Web UI/IM conversation 操作。
- source Scheduled Turn 继承内部 source context；session Scheduled Turn 不携带 source。source
  Prompt 使用已确认的 Scheduled marker。
- 通过 alias resolver 主动投递，区分 `unavailable`、`failed`、`delivered` 和 `abandoned`；保留现有
  Scheduled busy 重试与 Provider retryable 投递重试。
- 更新默认 `scheduled-tasks` Skill 和运行状态语义：IM 新建必为 source，Web UI 新建必为 session，
  Agent 不读写目标 alias，修改后仍须等待 Scheduler 接受。
- 聚焦验证：群聊/单聊创建、Web UI 创建、跨 conversation 管理、投递不可改、删除后重建、source
  继承、Provider 缺失、临时/永久失败、重启不补投以及既有调度生命周期回归。
- Green gate：`packages/web-ui`、`packages/chat-client`、`packages/http-adapter` test、typecheck、build。

### Slice 4：企业微信全 conversation 接入与部署清理

目标是让首个真实 Provider 完成群聊、单聊和 source 主动投递，并删除固定群聊控制面。

> 状态：已实现，待人工验收。验证：四个受影响 package 的 test、typecheck、build，根 `pnpm build`
> 和 diff check 全部通过；包含真实 `WeComChatProvider` 与 Scheduler 的单聊 source 集成测试。

- 删除 `IM_WECOM_GROUP_CHAT_ID`、`groupChatId` 构造参数和固定群过滤；群聊地址使用 `chatid`，单聊
  地址使用发送者 `userid`，原始值只进入 Provider/registry 内部。
- 群聊继续要求真实 mention；单聊合法消息直接触发。实现已确认的群聊与单聊文本、mixed、独立及
  引用图片/文件范围，继续忽略语音、视频和卡片。
- 回复使用原始消息 reference；source 主动发送解析 conversation address。单聊和群聊的文字、明确
  引用附件、重试与 URL 隐藏行为保持一致。
- 删除 `wecom-discover` 源码、测试、包脚本、根脚本和部署说明；Compose/README 只保留 Bot ID、
  Secret、Bot Name、可选 WS URL 等实际配置。
- 完成真实 Provider 与 Scheduler 的集成测试，并回归媒体大小、去重、机器人自身过滤、pending reply
  清理、连接重试和多 Provider 组合。
- Green gate：四个受影响 package 的 test、typecheck、build，根 `pnpm build` 和 diff check。
- Live gate 留给人工验收：至少两个企业微信群、两个单聊、群/单聊 source 任务、Web UI session
  任务、busy、Provider 暂时不可用、入站/出站附件及 Server 重启不补投。

### Slice 4 后续增强：引用内容与单聊语音

> 状态：已实现，待人工验收。该增强不改动 provider-neutral Chat Client 协议，只扩展企业微信
> Provider 的入站解析与 Prompt 组装。

- 支持引用文本、引用图文混排和引用语音转写；保留引用图片/文件，继续忽略引用视频。
- 群聊仍只由外层真实 mention 触发。去掉 mention 后没有正文但引用有效时，使用固定提示请求 Agent
  回应引用；引用中的 mention 永远不满足触发条件。
- 当前正文在前，引用文本在后并逐行转换为 Markdown quote block；只有引用附件时使用引用附件提示。
- 支持独立单聊语音，把企业微信提供的转写文本直接作为当前正文；独立群聊语音继续忽略。
- 当前附件和引用附件继续合并到同一个 `[Uploaded files: ...]` 列表，不扩展通用媒体结构或保留附件
  来源。引用为空、损坏或不受支持时不影响有效正文；整条消息没有可用内容时静默忽略。
- Green gate：`packages/wecom` test、typecheck、build 和 diff check。
- Live gate：群聊正文加引用、群聊仅 mention 加引用、引用 mixed、引用语音、单聊独立语音，以及无
  外层 mention、空引用和引用视频的静默忽略行为。

### 每个 Slice 的执行纪律

1. 只修改该 Slice 范围内的文件，保留无关工作树改动。
2. 先运行聚焦测试，再运行该 Slice 列出的 typecheck/build；报告准确通过项与环境限制。
3. 完成后停止，等待人工审阅和验收，不自动进入下一 Slice。
4. 验收前保持改动 unstaged/uncommitted；只有收到明确提交指令后才暂存本 Slice 已验证文件。
5. Docker、真实企业微信、浏览器和 Live Verification 由用户手工执行，Codex 提供明确步骤和观察点。
