# ADR-0003：单文件 CLI 的产品范围与技术验证

状态：产品范围已确认；macOS arm64 首轮离线验证通过，完整发布验收待完成。

## 目标

提供包含运行时的单个 `dscode` 可执行文件，用户无需安装 Node.js、Bun、pnpm、克隆源码或本地构建。优先验证 Bun standalone；当前 Node 分发方式保持不变。

尽量不在运行时释放程序自身依赖的辅助文件，如 JS、WASM 和动态库。会话、凭证、checkpoint、Git worktree、用户要求生成的文件可以正常写盘。保留 pi 对缺失 rg/fd 的自动下载，作为外部工具管理的明确例外；这些工具可以下载到工具目录，不纳入单文件。不通过静默删除功能或放宽权限来满足打包目标。

## 已确认的范围

| 项目 | 决策 |
| --- | --- |
| 命令与配置 | `dscode`、默认 `~/.dscode`、现有 `DSCODE_*` 环境变量 |
| 平台 | Linux x86_64（glibc）、macOS arm64；Linux 使用 Bun x64 baseline target；不支持 Linux arm64、Windows、Alpine/musl、Intel Mac |
| 执行模式 | TUI、`-p`、`--mode json`、`--mode rpc`；保留帮助、版本与认证管理命令 |
| 沙箱默认值 | 主进程与子 agent 默认 `danger-full-access`；不自动等同于 `permission=full` 或 `-y` |
| 审批 | 保留现有权限规则；子 agent 保留角色权限；print/JSON 无确认入口时拒绝需审批操作，RPC 通过协议提供审批 |
| 凭证 | 单文件版固定使用文件凭证，不依赖钥匙串 |
| 共用目录 | 读取已有本地 Skills 和 JSONL 会话；不迁移钥匙串凭证，不改写原有配置来强制上述策略；钥匙串独有凭证需重新登录 |
| 图片 | 保留图片路径、`@file` 输入、`read` 读图；保留内嵌 Photon WASM 预处理及图片 worker |
| 剪贴板 | 不携带 TUI 原生 helper；保留普通终端文字粘贴，不要求 macOS 直接读取剪贴板截图；Linux 可使用用户安装的剪贴板命令 |
| 视觉 CLI | 不携带 `dscode-vision` 及其专用执行路径 |
| 子 agent | 保留；启动同一个二进制，内部非交互执行不依赖旁置 JS 或系统 Node |
| Skills | 支持用户级、项目级本地 Skills；用户自行放入文件，外部命令由用户准备 |
| Extensions | 保留 DSCode 内置 extension；禁止用户 extensions，包括显式加载入口 |
| pi 包管理 | 不提供包安装、更新、删除或包内 extensions 加载 |
| MCP | 保留 stdio 和 Streamable HTTP；服务、运行时及启动命令由用户准备 |
| 原生依赖裁剪 | 排除钥匙串、SQLite、Windows helper、可选 WebSocket 原生加速和 Kerberos |
| 网络代理 | 保留普通 HTTP/HTTPS 代理；不支持依赖 Kerberos 模块的 Negotiate 认证 |
| 静态资源 | 内嵌主题、HTML 导出模板；不携带 pi 文档、示例；用户主动导出的 HTML 可以落盘 |
| 安装升级 | 直接下载或平台识别安装脚本；下载校验后原子替换；不自动检查或自动更新 |
| 外部工具 | 不纳入单文件；保留 pi 对缺失 rg/fd 的自动下载，其余工具如 Git、npx、Python 由用户准备 |

## 技术验证标准

1. 在没有 Node/Bun、node_modules、源码目录的环境中启动；不能因构建机已有依赖而误判成功。
2. 验证版本、帮助、TUI 初始化、文本输出、JSONL 和 RPC；协议 stdout 不混入诊断日志。
3. 用本地模拟模型验证流式输出、取消、退出码、命令与 patch、后台进程、会话恢复，不调用付费模型。
4. 验证图片 WASM、worker 和图片附件，不释放辅助文件。
5. 验证内置 extension 与本地 Skills，同时确认用户 extensions/包加载被禁用。
6. 验证 stdio/HTTP MCP、审批，以及子 agent 重启同一二进制。
7. 确认裁剪后的依赖图没有上述排除模块；记录原生平台尚未验证的边界。
8. 记录产物大小、构建环境、可重复命令与实际结果。构建成功不等于功能验收完成。

## 验证记录

2026-09-25：macOS arm64 使用 Bun 1.3.14 完成 12 项离线检查，包括内嵌 WASM worker、TUI 初始化、文本/JSON/RPC、真实 explorer 子 agent 与 stdio/HTTP MCP。实验使用隔离目录、受限 PATH 和 Seatbelt，未读写真实凭证或用户状态。

完整结果、可重复步骤与未覆盖边界见 [单文件实验记录](../../experiments/standalone/README.md)。当前实验产物不是发布版；Linux、HTML 导出、完整依赖裁剪和其他验收仍待完成。
