# HTTP API 简明手册

- 服务地址：以实际部署地址为准。
- 除 SSE（服务器发送事件）响应外，请求和响应均使用 JSON。
- `/v1` 接口的失败响应通常为：`{ "error": "<错误代码>" }`。
- `sessionId`、`turnId` 和 `requestId` 均由服务端生成。
- “对话轮次”简称“轮次”，表示一次用户消息及智能体的处理过程。
- 跨域调用仅支持 `/health` 和 `/v1/*`；`/share/*` 不支持跨域 JavaScript 读取。

## 端点一览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 检查服务是否存活 |
| `POST` | `/v1/workspaces/:workspaceId/files` | 上传文件到工作区 |
| `GET` | `/share/:workspaceId/*` | 查看或下载工作区文件 |
| `GET` | `/v1/sessions` | 查询工作区的会话 |
| `POST` | `/v1/sessions` | 创建或恢复会话 |
| `GET` | `/v1/sessions/:sessionId` | 查询活动会话的状态 |
| `GET` | `/v1/sessions/:sessionId/messages` | 获取活动会话的消息记录 |
| `DELETE` | `/v1/sessions/:sessionId` | 关闭会话 |
| `GET` | `/v1/sessions/:sessionId/events` | 订阅会话的 SSE 事件流 |
| `POST` | `/v1/sessions/:sessionId/turns` | 发起一轮对话 |
| `POST` | `/v1/sessions/:sessionId/turns/:turnId/abort` | 中止正在执行的轮次 |
| `POST` | `/v1/sessions/:sessionId/ui-requests/:requestId/responses` | 回应智能体的交互请求 |

## `GET /health`

**用途：** 检查 HTTP 服务是否正常运行。

**输入：** 无。

**成功输出：** `200`

```json
{ "status": "ok" }
```

## `POST /v1/workspaces/:workspaceId/files`

**用途：** 上传文件到工作区，供智能体读取或处理。

**输入：** 路径参数 `workspaceId`；请求体使用 `multipart/form-data`，文件字段名为 `files`，支持多个文件。大小上限由部署环境决定，同名文件会覆盖已有文件。

**成功输出：** `201`

```json
{ "files": [{ "name": "photo.png", "path": "uploads/photo.png", "size": 12345 }] }
```

`path` 是文件在工作区中的相对路径，`size` 的单位为字节。

**失败输出：**

- `400 invalid_upload`：没有文件或文件名不合法。
- `404 workspace_not_found`：工作区不存在。
- `413 upload_too_large`：文件过大。
- `415 Unsupported Media Type`：请求格式不是 `multipart/form-data`。

## `GET /share/:workspaceId/*`

**用途：** 通过浏览器查看或下载工作区文件；不支持跨域 JavaScript 读取。

**输入：** 路径参数 `workspaceId`，以及 `*` 表示的工作区相对路径。

```http
GET /share/main/uploads/photo.png
```

特殊字符需要进行 URL 编码。完整 URL 包含访问凭证 `workspaceId`，应避免泄露。

**成功输出：** `200`

响应体为文件内容，并包含相应的 `Content-Type` 和 `Content-Disposition`。

**失败输出：**

- `400 invalid_path`：路径无效。
- `404 workspace_not_found`：工作区不存在。
- `404 file_not_found`：文件不存在或不可访问。

## `GET /v1/sessions`

**用途：** 查询工作区当前活动的会话；如果没有活动会话，则返回最近保存的会话。

**输入：** 可选查询参数 `workspaceId`，用于只查询指定工作区。服务器要求必须指定 `workspaceId` 时，该参数必填。

```http
GET /v1/sessions?workspaceId=main
```

**成功输出：** `200`

活动会话：

```json
{
  "sessions": [
    {
      "workspaceId": "main",
      "active": true,
      "session": {
        "id": "session-id",
        "workspaceId": "main",
        "persisted": true,
        "status": "idle"
      }
    }
  ]
}
```

没有活动会话时，`active` 为 `false`，`session` 是最近保存的会话摘要：

```json
{
  "sessions": [
    {
      "workspaceId": "main",
      "active": false,
      "session": {
        "id": "session-id",
        "name": "可选的会话名称",
        "firstMessage": "第一条用户消息",
        "messageCount": 12,
        "modified": "2026-08-04T12:00:00.000Z"
      }
    }
  ]
}
```

如果工作区从未创建过会话，则 `session` 为 `null`。

**失败输出：**

- `400 invalid_session_request`：服务器要求必须指定 `workspaceId`，但请求中没有提供。
- `404 workspace_not_found`：`workspaceId` 不存在。
- `500 session_list_failed`：读取已保存的会话失败。

## `POST /v1/sessions`

**用途：** 为指定工作区创建新会话，或者恢复一个已经保存的会话。

**输入：**

```json
{
  "workspaceId": "main",
  "resumeSessionId": "session-id"
}
```

- `workspaceId`：必填，服务器配置的工作区 ID。
- `resumeSessionId`：可选；提供时恢复该会话，不提供时创建新会话。

**成功输出：** `201`

```json
{
  "id": "session-id",
  "workspaceId": "main",
  "persisted": true,
  "resumed": false,
  "status": "idle"
}
```

- `resumed`：是否恢复了已有会话。
- `status`：`idle`、`running` 或 `aborting`。

**失败输出：**

- `400 invalid_session_request`：请求体缺少字段、字段为空或类型错误。
- `404 workspace_not_found`：`workspaceId` 不存在。
- `404 persistent_session_not_found`：要恢复的会话不存在。
- `409 workspace_session_active`：该工作区已有活动会话。
- `409 session_already_active`：指定会话已处于活动、启动或关闭过程中。
- `409 session_already_exists`：新会话的 ID 已存在。
- `500 session_creation_failed`：创建或恢复会话失败。

## `GET /v1/sessions/:sessionId`

**用途：** 查询一个活动会话的当前状态。

**输入：** 路径参数 `sessionId`。

**成功输出：** `200`

```json
{
  "id": "session-id",
  "workspaceId": "main",
  "persisted": true,
  "status": "running"
}
```

`status` 为 `idle`、`running` 或 `aborting`。

**失败输出：** `404 session_not_found`，会话不存在或当前未激活。

## `GET /v1/sessions/:sessionId/messages`

**用途：** 获取活动会话当前保留的消息记录。

**输入：** 路径参数 `sessionId`。

**成功输出：** `200`

```json
{
  "messages": [
    {
      "role": "user",
      "timestamp": 1770206400000,
      "content": [{ "type": "text", "text": "帮我检查登录表单" }]
    },
    {
      "role": "assistant",
      "timestamp": 1770206401000,
      "content": [
        { "type": "text", "text": "我来检查。" },
        {
          "type": "toolCall",
          "id": "tool-call-id",
          "name": "read",
          "arguments": { "path": "login.ts" }
        }
      ]
    }
  ]
}
```

消息类型：

| `role` | 主要字段 | 说明 |
| --- | --- | --- |
| `user` | `timestamp`、`content` | 用户消息 |
| `assistant` | `timestamp`、`content` | 智能体文本和工具调用 |
| `toolResult` | `timestamp`、`toolCallId`、`toolName`、`isError`、`content` | 工具执行结果 |
| `compactionSummary` | `timestamp`、`summary` | 上下文压缩摘要 |

响应不包含思考内容和图片内容。上下文压缩后，列表可能从 `compactionSummary` 开始。

**失败输出：** `404 session_not_found`，会话不存在或当前未激活。

## `DELETE /v1/sessions/:sessionId`

**用途：** 中止当前工作、关闭事件流并释放会话使用的智能体。

**输入：** 路径参数 `sessionId`。

**成功输出：** `204`，无响应体。

**失败输出：**

- `404 session_not_found`：会话不存在。
- `500 session_disposal_failed`：关闭会话失败。

## `GET /v1/sessions/:sessionId/events`

**用途：** 建立 SSE 长连接，接收轮次状态、流式文本、工具调用和交互请求等事件。

**输入：** 路径参数 `sessionId`。请求头建议包含 `Accept: text/event-stream`。

**成功输出：** `200`，响应类型为 `text/event-stream; charset=utf-8`。

每个事件的格式为：

```text
event: <事件类型>
data: { <JSON 数据> }

```

事件类型：

| 事件 | 主要输出字段 | 说明 |
| --- | --- | --- |
| `turn` | `turnId`、`status`、`output?`、`error?`、`message?`、`clientId?` | 轮次状态和最终结果 |
| `assistant_text_delta` | `turnId`、`delta` | 智能体流式输出的文本片段 |
| `thinking_start` / `thinking_end` | `turnId` | 思考开始或结束 |
| `compaction_start` / `compaction_end` | `turnId` | 上下文整理开始或结束 |
| `tool` | `turnId`、`phase`、`toolCallId`、`name` | 工具调用状态 |
| `ui_request` | `turnId`、`request` | 等待客户端回应的交互请求 |
| `ui_event` | `turnId`、`event` | 状态、通知、标题、工作提示等界面事件 |
| `extension_error` | `turnId`、`error` | 扩展处理事件时发生错误 |
| `ping` | 无 | 大约每 30 秒发送一次的心跳 |

`turn.status`：

- `running`：轮次已开始，可包含提交的 `message` 和 `clientId`。
- `aborting`：正在中止轮次。
- `completed`：轮次已完成，`output` 是最终文本；没有最终文本时为 `null`。
- `failed`：轮次失败，`error` 是失败原因。
- `aborted`：轮次已中止。

`tool.phase`：

- `started`：包含 `args`。
- `updated`：包含 `args` 和 `partialResult`。
- `completed`：包含 `result` 和 `isError`。

`ui_request.request`：

| `method` | 主要字段 |
| --- | --- |
| `confirm` | `id`、`title`、`message`、`timeout?` |
| `select` | `id`、`title`、`options`、`timeout?` |
| `input` | `id`、`title`、`placeholder?`、`timeout?` |
| `editor` | `id`、`title`、`prefill?` |

`turnId` 在当前没有活动轮次时可能为 `null`。

**失败输出：** `404 session_not_found`，会话不存在或当前未激活。

## `POST /v1/sessions/:sessionId/turns`

**用途：** 向智能体提交用户消息，并异步发起一轮对话。

**输入：** 路径参数 `sessionId`，以及 JSON 请求体：

```json
{
  "message": "帮我检查登录表单",
  "clientId": "client-id"
}
```

- `message`：必填，发送给智能体的消息，不能为空。
- `clientId`：可选，由调用方定义；服务端在 `running` 事件中原样返回。

**成功输出：** `202`

```json
{
  "id": "turn-id",
  "status": "running"
}
```

该响应只表示轮次已开始。流式内容和最终结果通过 SSE 事件流返回。

**失败输出：**

- `400 invalid_message`：`message` 缺失或为空。
- `404 session_not_found`：会话不存在或当前未激活。
- `409 turn_in_progress`：该会话已有正在执行的轮次。

## `POST /v1/sessions/:sessionId/turns/:turnId/abort`

**用途：** 中止指定会话中正在执行的轮次。

**输入：** 路径参数 `sessionId` 和 `turnId`，无请求体。

**成功输出：** `202`

```json
{
  "id": "turn-id",
  "status": "aborting"
}
```

最终中止结果通过 SSE 的 `turn` 事件返回。

**失败输出：**

- `404 session_not_found`：会话不存在或当前未激活。
- `404 turn_not_found`：轮次不存在或已经结束。
- `500 turn_abort_failed`：中止轮次失败。

## `POST /v1/sessions/:sessionId/ui-requests/:requestId/responses`

**用途：** 回应 SSE `ui_request` 事件。智能体收到回应后继续执行。

**输入：** 路径参数 `sessionId` 和 `requestId`。请求体根据交互类型选择以下一种：

```json
{ "confirmed": true }
```

用于 `confirm`。

```json
{ "value": "用户输入或选择的内容" }
```

用于 `select`、`input` 或 `editor`。`select` 的值必须来自 `options`。

```json
{ "cancelled": true }
```

用于取消任意交互请求。

**成功输出：** `204`，无响应体。

**失败输出：**

- `400 invalid_ui_response`：响应格式错误，或内容与交互类型不匹配。
- `404 session_not_found`：会话不存在或当前未激活。
- `404 ui_request_not_found`：`requestId` 不存在，或不属于该会话。
- `500 ui_response_failed`：提交交互响应失败。
