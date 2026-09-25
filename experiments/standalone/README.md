# 单文件 CLI 可行性实验

产品范围见 [ADR-0003](../../docs/decisions/0003-standalone-cli.md)。这是离线技术探针，**不是可发布的单文件构建器**。

## 运行

前置条件：仓库依赖和当前 `dist` 已构建；实验构建机安装 Bun 和 Node。macOS TUI 探针使用系统 Python 3 创建 PTY。这些是验证工具的依赖，不是被测二进制的依赖。

```sh
bun experiments/standalone/build.mjs
# 将上一步打印的临时目录作为参数：
node experiments/standalone/verify.mjs /absolute/path/to/build-output
```

`build.mjs` 仅通过构建插件适配已生成的 JS，不修改源码、dist、node_modules 或用户配置。输出在新建临时目录，包含 `dscode`、独立资源探针 `probe` 和 `build.json`。两个二进制各自独立；`probe` 不属于 dscode 的运行依赖，只用于资源测试及模拟外部 MCP server。

`verify.mjs` 将两个程序复制到另一个临时目录，使用独立 HOME/DSCODE_HOME 和仅含 `/usr/bin:/bin` 的 PATH。macOS 上使用 Seatbelt 禁止读取仓库和构建输出目录，并将写入限制在测试目录及 `/dev/null`、`/dev/tty`。模型服务只在 loopback 上模拟，不读取真实凭证、不调用付费模型。Linux 上不实施这个 Seatbelt 隔离，不能将其结果称为同等强度的隔离验证。

测试结果写入构建目录的 `verification.json`，保留临时目录供检查。构建适配使用字符串匹配并在预期源码变化时失败；这是快速验证方法，不是最终建议的维护方式。

## 已验证结果（2026-09-25）

环境：macOS arm64；Bun 1.3.14；Node 22.23.2 运行测试服务；pi 0.87.1；当前 DSCode dist 版本 1.1.6。

未经适配的 `bun build --compile dist/cli.js` 编译成功，但执行 `--version` 因读取 `/$bunfs/package.json` 失败。适配版本信息、主题路径、Photon WASM 路径、文件凭证策略和自重启入口后，以下 12 项通过：

| 检查 | 实际覆盖 |
| --- | --- |
| 版本 | 独立程序正确输出版本 |
| 内嵌资源探针 | 真正的 worker 加载内嵌 Photon WASM，将 2×2 PNG 缩放为 1×1；读取内嵌主题；同一二进制启动子进程 |
| 文本模式、Skills、内置工具、排除用户扩展 | 本地模拟 Responses 流返回最终文本；模型请求包含本地 skill 描述和内置工具；显式 extension 测试文件未执行 |
| JSONL | 输出每行可解析，包含 agent_end |
| TUI 初始化 | 真 PTY 中完成 InteractiveMode.init，通过上游 startup benchmark 正常退出；不是完整交互对话验收 |
| RPC | get_state 响应正确，stdin EOF 后正常退出 |
| 命令工具 | 模拟模型调用真实 exec_command 执行 pwd，并收到结果 |
| 子 agent | 模拟模型调用真实 delegate；explorer 重启同一二进制，完成 JSON 模式请求并返回 success；未覆盖 implementer worktree 或所有角色 |
| stdio MCP | 发现并调用独立模拟 MCP 程序；确认其环境没有 DEEPSEEK_API_KEY |
| HTTP MCP | Streamable HTTP 发现和实际工具调用 |
| 错误退出 | 模拟 provider 401，非零退出并输出诊断 |
| 配置保护 | 即使已有 config 指定 keyring，实验采用文件策略且未改写该 config |

最终复跑的 dscode 产物为 78,240,866 bytes（约 74.6 MiB），未完成依赖裁剪或体积优化；资源探针大小不计入产品。完整 CLI 中的图片 worker 打包路径尚未验收，独立探针明确不允许通过主线程 fallback 冒充 worker 成功。

检查运行目录后，除了测试预置文件和复制的二进制，只发现 settings.json、models-store.json 等状态文件；未发现释放的 JS、WASM、动态库或工具二进制。这是已执行路径的证据，不代表所有功能路径均已排除辅助文件写入。

## 后续验证与实现边界

- 三种模式复用同一运行时已经验证，保留它们无需新的原生依赖。
- Photon WASM 和 worker 内嵌已经有运行证据，不必为单文件目标放弃图片预处理。
- 实验对 extensions 仅阻止了传入路径和自动发现；尚未彻底裁剪包解析、包管理命令、动态加载器，不能作为发布版的禁用保证。
- pi 的 `ensureTool` 会在缺少 rg/fd 时自动下载。经确认，正式版保留此行为，作为外部工具管理的例外，不视为释放程序自身依赖的辅助文件。本轮实验设置 PI_OFFLINE，未验证自动下载路径；后续需单独验证，不应为了阻止下载而启用整体离线模式。
- HTML 导出资源内嵌、所有图片入口、真实 TUI 对话、取消、后台进程、patch/checkpoint/undo、会话恢复、MCP 审批、全部子 agent 角色仍需验收。
- OAuth/Bun 专用 provider 初始化、普通代理和自定义 CA 未验收；本轮只有本地模拟 DeepSeek Responses。
- 当前将 keyring 等列为 external 是实验便利，不是最终依赖裁剪：发布构建必须去掉不可达导入及 SQLite、vision CLI、Windows 路径等，并禁止意外回退到宿主依赖。
- Linux x86_64（Bun x64 baseline target）构建与实际运行、glibc 最低版本、macOS 最低版本、签名和下载升级链路尚未验证；交叉编译成功也不能替代目标平台运行。Linux arm64 不在首版支持范围内。
- 正式方案应收敛为明确的 standalone 入口、资源解析层和平台能力开关，避免长期维护大量上游源码字符串替换。

结论：macOS arm64 的核心可行性成立；当前产物只用于实验，不应发布或用于真实凭证及工作目录。
