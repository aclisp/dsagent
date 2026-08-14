# Upstream integration notes

## 2026-08-13: `packages/core` review

Review baseline:

- Upstream branch: local `dev` tracking `origin/dev` at `9f8559c`.
- Server branch: `feature/server` at `bb2b6bb`, also published as `fork/feature/server`.
- Merge base: `5e37295`.
- The branches contain independent changes after the merge base; upstream changes must be selected by commit rather than copying the complete `packages/core` directory.

Three upstream-only commits after the merge base affect `packages/core`.

| Commit | Decision | Rationale |
| --- | --- | --- |
| `7282c6b` — Release 0.3.6 with DeepSeek Pro selection | Recommended | Registers both DeepSeek V4 Flash and Pro with their correct costs, preserves custom DeepSeek model support, and adds focused coverage. Its patch applies cleanly to `feature/server`. |
| `b597a4f` — Add OpenCode Zen Go API-key login | Optional | The Core and test changes apply cleanly and keep provider support aligned with upstream. The current Web UI Server uses OpenRouter, so this provider has no immediate runtime effect. The complete commit cannot be cherry-picked unchanged because it also modifies Desktop files absent from `feature/server`. |
| `9444a4d` — Desktop personalization and conversation improvements | Do not port yet | The Core addition depends on a Desktop-owned settings file and has no producer in the Web UI Server. It overlaps the protected prompt-profile design and conflicts with current Core prompt composition. |

### Recommended integration

1. Port `7282c6b`. Either cherry-pick the complete commit, including the `0.3.6` package-version updates, or manually port its DeepSeek provider implementation and test if the branch version must remain unchanged.
2. Port the Core, documentation, fixture, and test portions of `b597a4f` only if OpenCode Zen Go support or general upstream provider parity is wanted. Omit its Desktop-only change.
3. Skip `9444a4d` until the Server has an explicit product requirement for user personalization and a trusted, read-only source for those settings.

### Prompt-security consideration

The Server currently selects a product identity through read-only `SYSTEM.md` and `APPEND_SYSTEM.md` mounts. `9444a4d` introduces `DSCODE_PERSONALIZATION_FILE`, whose contents are appended to the system prompt on every turn. Pointing that variable at an Agent-writable file would create a new prompt-modification path and weaken the existing implementation boundary. A future Server implementation must define a trusted source and precedence rules before adopting this mechanism.

### Preserve Server-specific Core work

Do not replace `packages/core` with the upstream `dev` snapshot. The upstream snapshot does not contain the Server branch's Vision CLI implementation (`vision-cli.ts` and `vision-command.ts`) and would also overwrite the workspace-catalog dependency changes and other Server-specific hardening. Use selected cherry-picks or manually adapted patches instead.

This review used Git history, source diffs, and `git apply --check`. It did not modify either branch, cherry-pick commits, or run the test suite.
