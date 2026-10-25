# RPC children

Use RPC for child tasks that need approval dialogs or follow-up prompts. Launch with
`exec_command` and keep stdin open:

```json
{"cmd":"dscode --mode rpc --no-session","stdin_open":true,"yield_time_ms":0,"timeout_ms":0}
```

Send one JSON command per line through `write_stdin`. End each `chars` value with an
actual newline:

```json
{"process_id":"1","chars":"{\"type\":\"prompt\",\"message\":\"Implement and verify the assigned task\"}\n","yield_time_ms":0}
```

Poll output and retain partial lines until a complete JSONL record is available.
For `extension_ui_request` records that need a decision, obtain the user's response
and send an `extension_ui_response` with the request's `id`:

- `confirm`: set `confirmed` to `true` or `false`.
- `select`, `input`, or `editor`: set `value` to the chosen or entered text.
- Cancellation: set `cancelled: true`.

For example, after the user approves a confirmation:

```json
{"process_id":"1","chars":"{\"type\":\"extension_ui_response\",\"id\":\"request-id\",\"confirmed\":true}\n","yield_time_ms":0}
```

Notifications and status updates need no response.

A successful `prompt` response confirms submission. Wait for `agent_settled` and collect
the final assistant result. Send further `prompt` records to continue the conversation.
When all work is complete, send EOF to end the RPC session:

```json
{"process_id":"1","eof":true,"yield_time_ms":1000}
```

Poll until the child exits and collect its exit status.
