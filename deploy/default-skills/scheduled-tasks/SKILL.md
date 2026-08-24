---
name: scheduled-tasks
description: Create, change, pause, resume, inspect, or delete DSCode one-time and recurring scheduled tasks. Use whenever the user asks for a reminder, future work, periodic work, a schedule, or wants an existing scheduled task managed.
---

# Scheduled Tasks

Manage the current workspace's `.dscode/schedules.yaml`. Treat
`.dscode/schedules.status.json` as scheduler-owned: read it to verify changes, but never edit it.

## Resolve the request

- Ask only when the time, task instructions, or delivery scope is materially ambiguous.
- A request received through Web UI defaults to `delivery: session` (“仅在 Web UI 查看”).
- A request whose current prompt begins with `[Group message` defaults to `delivery: group`
  (“同时发送到群聊”). Explicit user wording overrides either default.
- Read `schedules.status.json` for the Server timezone and group-delivery availability. Convert the
  user's time into that timezone and confirm it naturally; do not teach or display Cron syntax to
  ordinary users.
- Warn when `delivery: group` is requested but `groupDeliveryAvailable` is false: the task remains
  valid and will run, but this occurrence's result will only be visible in Web UI unless a Provider
  is bound by the time a future occurrence runs.

## Edit the source of truth

Read the existing YAML before editing and preserve unrelated tasks, order, and comments. The file
has this shape:

```yaml
version: 1
tasks:
  - id: contract-reminder
    enabled: true
    type: once
    at: "2026-08-24T18:00:00+08:00"
    delivery: session
    prompt: |
      提醒我跟进合同签署。

  - id: weekday-report
    enabled: true
    type: cron
    cron: "0 18 * * 1-5"
    delivery: group
    prompt: |
      检查今天的工作情况并给出总结。
```

Required invariants:

- Use only `type: once` with an RFC 3339 timestamp containing `Z` or an explicit offset, or
  `type: cron` with a Croner-native pattern.
- Cron occurrences must be at least five minutes apart.
- Always write `delivery: session` or `delivery: group` explicitly.
- IDs use lowercase letters, digits, and hyphens, are at most 64 characters, and remain stable
  across edits. Generate a meaningful unique ID for a new task, but do not expose it unless needed
  for technical diagnosis.
- Keep prompts non-blank and focused on the work the Agent should perform and the desired final
  response. Do not put credentials or secrets in a task.
- Never create more than 100 tasks or a prompt larger than 32 KiB.

Use `apply_patch` for the edit. Pausing sets `enabled: false`; resuming sets it to true only after
checking that the schedule still has a future occurrence. Delete only when the user asks to delete.

## Verify before confirming

After editing, compute the SHA-256 hash of the exact `schedules.yaml` bytes (for example with
`sha256sum`) and read `schedules.status.json` until its `contentHash` matches. Confirm success only
when `valid` is true and the task ID appears in the status. If status is invalid, report the field
path and reason, fix only the requested configuration when safe, and verify again. If the status
file is missing, stale, or reports the scheduler as non-operational, do not claim the task was
created successfully.

Confirm with the actual natural-language time or recurrence and either “仅在 Web UI 查看” or
“同时发送到群聊”. Do not include the internal ID, Cron pattern, run metadata, or status-file
details in an ordinary confirmation.
