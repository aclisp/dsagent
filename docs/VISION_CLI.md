## 最终架构

> 状态：Slice 1 已完成并通过手工验收；Slice 2–4 尚未实施。

```text
用户上传图片并提问
        ↓
主模型读取 dscode-vision Skill
        ↓
exec_command:
dscode-vision --image "uploads/a.png" --prompt "..."
        ↓
Core 识别严格限定的可信命令
        ↓
shell:false 启动固定视觉 CLI
只注入 OPENROUTER_API_KEY
        ↓
读取 models.json 中指定的视觉模型
        ↓
一次性视觉推理，无 Tool、无 Session
        ↓
stdout 成为 exec_command 结果
        ↓
主模型结合识图结果回答用户
```

明确不做：

- 不新增模型可见 Tool。
- 不修改 Session API、HTTP Adapter 或 Web UI 协议。
- 不写入或共享 `auth.json`。
- 不通过进程名判断是否放行凭证。
- 不把图片直接加入主模型上下文。
- 不提供同容器 root 主动攻击防护。

首版固定使用 OpenRouter，只新增一个面向部署者的配置：

```text
DSCODE_VISION_MODEL=<models.json 中的视觉模型 ID>
```

Provider 固定为 `openrouter`，复用现有 `OPENROUTER_API_KEY`。先不引入多 Provider 配置。
`DSCODE_VISION_THINKING` 是主 Agent 每次启动视觉进程时传入的内部运行参数，不是另一项部署配置。

## Slice 1：独立的一次性视觉 CLI（已完成并验收）

目标是先让 `dscode-vision` 自身成立，不接入 `exec_command` 的凭证例外。

CLI 接口：

```bash
dscode-vision --image "uploads/screenshot.png" \
  --prompt "解释图片中的错误，并提取关键报错文字"
```

首版规则：

- 一次只处理一张图片；多张图片由 Agent 分别调用。
- `--image` 必填。
- `--prompt` 可选；缺省时使用固定的详细描述和 OCR prompt。
- 不允许透传任意 DSCode 参数。
- 支持现有 PNG、JPEG、GIF、WebP。
- 继续沿用单张 20 MiB 上限。
- 相对路径根据当前 workspace 解析。

内部直接调用 `ModelRuntime.completeSimple()`，不启动完整 Agent loop。运行语义相当于：

```text
--provider openrouter
--model $DSCODE_VISION_MODEL
--mode text
--print
--no-session
--no-tools
--no-approve
--no-skills
--no-context-files
--no-prompt-templates
--thinking $DSCODE_VISION_THINKING
```

`DSCODE_VISION_THINKING` 不是独立的用户配置。可信启动分支在每次调用时从主 Agent
读取当前 thinking level 并传给视觉进程，因此用户在会话中调整 thinking level 后，后续识图调用会同步使用新值。

实际实现直接构造包含一个图片块和一个文本块的用户消息，因此不会加载 Tool、Session、Skill、
Context 文件、Prompt Template 或 Extension。

为了确保它不读取共享凭证和无关上下文，视觉进程使用临时 DSCode Home：

1. 创建临时目录。
2. 从正常 `DSCODE_HOME` 复制 `models.json`。
3. 临时目录中没有 `auth.json`、Skill、`APPEND_SYSTEM.md` 或 `AGENTS.md`。
4. 完成后删除临时目录。
5. API Key 只从进程环境读取。

实际修改：

- 新增 `packages/core/src/vision-cli.ts` 视觉运行模块。
- 新增 `src/vision-cli.ts` CLI entry，并注册 `dscode-vision` bin。
- 从 Core 导出必要的视觉 CLI API。
- package smoke test 增加视觉 CLI 产物与 `--help` 检查。
- 新增视觉 CLI 单元测试和 mock OpenRouter 集成测试。

已完成的自动验证：

- 参数解析。
- 图片确实作为 image content 发给模型。
- 请求中的模型 ID 正确。
- 请求不包含 Tools。
- 不创建 Session。
- 已存在的主 `auth.json` 不会覆盖注入的环境变量。
- 文本模型收到图片时给出明确错误。
- 缺少模型配置、图片无效、图片过大时给出明确错误。
- stdout 只有最终识图文本，诊断写入 stderr。

构建后可在仓库中这样手工调用：

```bash
DSCODE_VISION_MODEL='视觉模型 ID' \
DSCODE_VISION_THINKING='主 Agent 当前 thinking level' \
OPENROUTER_API_KEY='OpenRouter Key' \
node dist/vision-cli.js \
  --image '/图片的绝对路径/screenshot.png' \
  --prompt '请详细描述图片内容，并提取其中全部文字'
```

Slice 1 已通过真实视觉模型手工验收。当前 CLI 可以在受控环境中直接提供 Key 使用，但还不能从 Web UI Agent 安全调用；该安全调用路径属于 Slice 2。

## Slice 2：可信 `exec_command` 执行分支

目标是实现方案 D。

在 [`managed-process.ts`](/Users/homerh/Code/dscode/packages/core/src/managed-process.ts) 中增加一个窄分支：

```text
普通命令
  → 现有 sandboxCommand()
  → 剥离所有模型 API Key
  → shell 执行

严格匹配的 dscode-vision 命令
  → 不进入 shell
  → 固定绝对路径
  → shell:false
  → 仅恢复 OPENROUTER_API_KEY
```

识别规则：

- 可执行名称必须恰好是 `dscode-vision`。
- 只接受 `--image` 和 `--prompt`。
- 不接受环境变量赋值、重定向、管道、命令连接或命令替换。
- 不允许 `sudo dscode-vision`、`env ... dscode-vision` 等变体。
- 不通过 `$PATH` 解析真正执行文件。
- 内部始终启动构建时确定的固定绝对路径。

为了避免新增 shell 解析依赖，建议实现一个很小的“不展开参数解析器”：

- 支持普通参数、单引号、双引号和反斜杠。
- 不展开 `$VAR`、`$(...)`、反引号或通配符。
- 拒绝未引用的 shell 控制符和换行。
- 解析后再验证参数结构。

例如：

```bash
dscode-vision --image "screen shot.png" --prompt "读取全部文字"
```

可以进入可信分支；下面这些全部进入普通无凭证分支：

```bash
dscode-vision a.png && env
dscode-vision a.png | tee result.txt
OPENROUTER_API_KEY=x dscode-vision a.png
sudo dscode-vision a.png
```

可信子进程环境采用 allowlist，并额外加入：

```text
OPENROUTER_API_KEY
DSCODE_VISION_MODEL
DSCODE_HOME
HOME
PATH
LANG/LC_*
TZ
HTTPS_PROXY/HTTP_PROXY/NO_PROXY
NODE_EXTRA_CA_CERTS
```

其他模型 Key 不传入。

还需要：

- 将 `dscode-vision` 识别为需要网络的命令。
- `permission=full` 下直接运行。
- 其他权限模式继续走现有网络授权流程。
- 复用 `ManagedProcessRegistry` 的超时、终止、输出上限和 `write_stdin` 生命周期。
- 错误和日志中永远不打印 Key。

自动验证：

- 普通 `exec_command` 仍看不到所有模型 Key。
- 精确视觉命令能收到 OpenRouter Key。
- 视觉进程看不到其他 Provider Key。
- 管道、连接命令、重定向等不能获得 Key。
- 修改 `$PATH` 或放置同名程序不能替换固定可执行文件。
- 超时、中断和后台进程清理行为保持不变。
- 不影响现有 managed-process、sandbox 和 approval 测试。

Slice 2 完成后暂停。此时核心安全边界已经形成，但生产镜像里还没有安装最终 CLI。

## Slice 3：构建产物和容器交付

目标是让 lean 镜像包含 CLI，同时继续保护 `packages` 源码。

构建方式：

- 新增独立的视觉 CLI bundle 脚本。
- 使用 esbuild 将视觉 entry 和 DSCode workspace 代码打成一个 minified ESM 文件。
- 不包含 source map。
- 第三方生产依赖继续从现有 `/app/node_modules` 解析。
- 输出例如：

```text
/app/dist/dscode-vision.js
```

- `/usr/local/bin/dscode-vision` 指向该固定产物。
- 可信执行分支直接启动 `/app/dist/dscode-vision.js`，不跟随用户的 `$PATH`。

运行镜像仍然不复制：

- `packages/*/src`
- 测试
- `.d.ts`
- source map
- 未压缩的 Core 构建目录

配置修改：

```yaml
environment:
  DSCODE_VISION_MODEL: "${VISION_MODEL:?set VISION_MODEL in .env}"
```

`.env.example` 增加：

```dotenv
VISION_MODEL=your-vision-capable-openrouter-model-id
```

`models.json` 中对应模型必须声明：

```json
{
  "id": "your-vision-model",
  "input": ["text", "image"]
}
```

现有 `models.json:ro` 挂载保持不变，`auth.json` 不新增、不挂载。

预计修改：

- 根 `package.json` 构建脚本。
- 视觉 bundle 脚本。
- [`Dockerfile`](/Users/homerh/Code/dscode/Dockerfile)。
- [`.env.example`](/Users/homerh/Code/dscode/.env.example)。
- [`docker-compose.yml`](/Users/homerh/Code/dscode/docker-compose.yml)。
- 模型配置示例和 Web UI Server 文档。

当前 `docker-compose.yml` 已有未提交修改。到这个 Slice 时会只追加视觉配置，保留现有内容，不擅自暂存或提交其他改动。

自动验证：

- `pnpm build` 生成 minified 视觉产物。
- 产物不依赖 `packages/*/src`。
- 产物可启动并显示帮助或配置错误。
- package smoke test 验证必须的 bundle 存在。
- 根 `pnpm check` 通过。

我不会运行 Docker、启动 Server 或做浏览器验证。镜像构建与容器验收留给你手工执行。

Slice 3 完成后暂停。

## Slice 4：默认 Skill 和产品行为

新增：

```text
deploy/default-skills/dscode-vision/SKILL.md
```

Skill 只向主模型说明：

- 用户提供截图、照片、扫描件、图表或其他图片，需要理解视觉内容时调用。
- 优先把用户真正的问题作为 `--prompt`，避免只做泛泛描述。
- 图片路径必须来自用户提供的附件或明确指定的 workspace 文件。
- 多张图片分别调用，最后由主模型汇总。
- 将 stdout 视为辅助观察结果，不原样机械转发。
- CLI 失败时明确说明无法读取图片，不得凭文件名猜测内容。
- 不检查、打印或讨论 API Key。
- 不尝试调用普通 `dscode` 绕过专用 CLI。

不会修改：

- `APPEND_SYSTEM.md`
- `AGENTS.md`
- Web UI JavaScript
- Server API
- Tool 列表

entrypoint 现有的默认 Skill seed 逻辑可以直接分发新 Skill；因为它是一个新目录，不会覆盖用户已有 Skill。

文档补充：

- `dscode-vision` 的用途和命令格式。
- `VISION_MODEL` 配置。
- 与主模型的关系。
- 普通命令拿不到 Key，但同容器 root 主动攻击不在防护范围。
- 常见失败原因和排查方式。

自动验证：

- Skill frontmatter 和目录结构正确。
- 镜像默认 Skill 清单文档同步。
- 构建和完整测试通过。

随后由你做最终手工验收：

1. 配置一个 `input: ["text", "image"]` 的 OpenRouter 模型。
2. 构建并启动镜像。
3. 在 Chat 页面上传截图并提问。
4. 确认主模型会调用 `dscode-vision`。
5. 确认识图结果最终被主模型整理为自然回答。
6. 确认普通 `exec_command` 中 `OPENROUTER_API_KEY` 为空。
7. 验证中文 OCR、错误截图、照片和带空格文件名。
8. 验证缺少模型配置或选择文本模型时错误信息可理解。

## 每个 Slice 的执行纪律

每个 Slice 都遵循：

1. 只修改该 Slice 范围内的文件。
2. 运行针对性自动测试。
3. 汇报实际改动、测试结果和未验证项。
4. 停止并等待你验收。
5. 不自动进入下一个 Slice。
6. 不自动暂存或提交；你明确要求后再处理。
7. Docker、Server、Browser 和真实 LLM 验证全部留给你。
