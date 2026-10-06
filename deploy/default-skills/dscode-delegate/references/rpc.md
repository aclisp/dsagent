# RPC children

Use RPC when a child needs approval dialogs or follow-up prompts. Launch through
`exec_command`:

```json
{"cmd":"dscode --mode rpc --no-session","yield_time_ms":0,"timeout_ms":0}
```

Keep stdin open. Send one JSON record per line through `write_stdin`; the `chars`
value must end with an actual newline:

```json
{"process_id":"1","chars":"{\"type\":\"prompt\",\"message\":\"Implement and verify the assigned task\"}\n","yield_time_ms":0}
```

Poll output regularly and retain partial lines until a full JSONL record is available.
Handle `extension_ui_request` records that need a decision:

- `confirm`: obtain the user's decision and respond with `confirmed: true` or `false`.
- `select`, `input`, or `editor`: obtain the chosen or entered text and respond with `value`.
- Cancellation: respond with `cancelled: true`.

Use the request's exact `id`. For example, after the user approves a confirmation:

```json
{"process_id":"1","chars":"{\"type\":\"extension_ui_response\",\"id\":\"request-id\",\"confirmed\":true}\n","yield_time_ms":0}
```

Never approve automatically. Notifications and status updates need no response. Child
dialogs are handled through this protocol; they are not automatically forwarded into
the Web UI's approval dialogs.

A successful `prompt` response acknowledges acceptance, not completion. Collect the
final assistant result and wait for `agent_settled`. Send further `prompt` records if
needed. When the work is finished, send EOF and collect the process's exit status:

```json
{"process_id":"1","eof":true,"yield_time_ms":1000}
```

Continue polling if the process is still running. EOF closes the child; it cannot accept
further prompts afterward.
