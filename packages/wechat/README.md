# DSCode 微信通道

通过微信 iLink 的扫码登录和 HTTPS 长轮询接入 DSCode Server。一个部署只接受扫码绑定者本人的单聊，与该部署的 Web UI、wecom 和 Scheduler 共用 Session。缺少扫码者身份时拒绝启动。

## 登录与启用

```sh
dscode channels login wechat
# Docker：在服务容器内登录，使用容器的持久化 DSCODE_HOME。
docker compose exec -it dscode dscode channels login wechat
```

用本人微信扫码并确认，出现提示时输入手机微信显示的数字。二维码过期会刷新，最多尝试三张；支持微信要求的登录重定向。

登录后重启服务生效。默认从 DSCode home 读取已有绑定并启用微信；`IM_WECHAT_ENABLED=false` 可禁用，`true` 要求已有有效绑定。凭据读取或通道启动失败不会阻止其他 Provider 和 HTTP 服务。

可选 `--qr-output /absolute/path/to/new-file.png` 保存二维码图片，目标文件必须尚不存在；刷新时更新本次创建的图片。`--timeout 480` 设置本次登录等待秒数。

## 使用与故障语义

- 支持文本、图片和文件双向收发，语音只消费微信提供的转写；未转写语音提示改发文字。
- 附件起始的消息等待约一秒，连续附件及随后说明合并为一次请求，等待最长三秒。纯文本立即提交。已经提交的任务执行期间，新请求按共享 Session 的 busy 规则拒绝，不排队。
- 新附件准备失败时整批不提交 Agent，提示重发。文件写入 workspace 的 `uploads/`，通过已有 `[Uploaded files: ...]` 约定交给 Agent。
- 手机端在“转发”选择器找不到机器人时，可从机器人会话的“＋ → 文件 → 聊天中的文件”选择附件发送。
- 处理期间维持输入状态；完成、失败和中止都取消。失败和中止发送简短通知。
- 显式用行内代码引用的 workspace 文件会作为产物发送。沿用通用限制：每份最多 50 MiB、每次最多 5 份；入站默认每份 100 MiB，可随服务的 `MAX_UPLOAD_BYTES` 调整。
- 私密 Web UI bearer URL 在发送前脱敏。媒体 API 的 token、AES key 和签名 URL 不进入日志或 Agent Prompt。
- 轮询游标和入站记录在同一事务中保存；重启恢复未提交消息，已进入提交阶段或执行中的请求标记中断，不重跑。
- 文本每片最多 2000 个 Unicode 字符，并控制发送间隔。进程内按投递 ID 保留发送进度，临时错误复用原 client_id 重试未确认部分；请求超时可能导致重复投递。
- 文件永久失败或重试耗尽会补发说明。进程重启后不补投回复或文件。
- Scheduler 的 source 回投使用持久化 context token，投递时 token 必须仍有效。`-14` 会暂停账号 API 调用一小时；可以重新扫码并重启服务。

## 私有状态与引用

`$DSCODE_HOME/channels/wechat/credentials.json` 保存唯一有效绑定，文件权限 `0600`。按账号和 owner 派生数据库路径，SQLite 事务保存游标、入站记录、去重状态、最新 context token 及引用索引。通道目录创建权限 `0700`。

引用索引同时记录入站和已确认发送的服务端消息 ID、正文和 workspace 附件路径，默认保留 30 天、最多 10000 条；仅能恢复本通道记录过且仍可用的消息。支持 `svr_id` 与 `ref_msg.message_item.msg_id` 两种引用标识、内嵌引用和带 MD5 的部分文字引用；缺失时明确标注不可用。元数据清理不删除 workspace 文件。

## 上游与验收

选择性移植自 `Tencent/openclaw-weixin@0ad1ae91347a938f52f1e4e2abd6dcda51e05f9e`。协议版本前缀对应上游 `3.0.0-beta-0`，DSCode 使用自己的后缀和观测标识。移植范围包括协议类型、uint64 解析、AES、部分引用及请求/扫码/CDN 流程，运行时不依赖 OpenClaw。许可证见 `LICENSE.tencent`。

自动化覆盖协议、身份过滤、恢复、附件失败、引用、生命周期及发送重试，并回归 wecom。2026-11-10 已完成真实微信扫码、文本、语音转写、多图、图片/文件双向传输、重启后引用、定时回投及 busy/中止验收。PIN 和故障注入分支由自动化补充覆盖。详见仓库 `docs/WECHAT_ACCEPTANCE.zh-CN.md`。
