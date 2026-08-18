# Upstream integration notes

## 2026-08-18: status refresh

Current baseline:

- Upstream branch: remote `origin/dev` at `1ce0328`, verified directly with `git ls-remote`; the local `dev` branch matches it.
- Server branch: `feature/server` at `c13d0b4`, also published as `fork/feature/server`.
- Merge base: unchanged at `5e37295`.
- No upstream commit identified in the August 13 review has been committed into `feature/server`; `7282c6b` is now applied in the working tree for review.
- Since the recorded upstream baseline `9f8559c`, upstream added one functional commit affecting Core, `6e9a037`, followed by merge commit `1ce0328`.

Four upstream-only commits after the merge base currently affect `packages/core`.

| Commit | Current decision | Integration status and rationale |
| --- | --- | --- |
| `7282c6b` — Release 0.3.6 with DeepSeek Pro selection | Ported for review | The complete four-file patch is applied in the working tree, including the `0.3.6` package-version updates and focused provider test. It is not committed yet. |
| `b597a4f` — Add OpenCode Zen Go API-key login | Optional | Pending. Port only its Core, documentation, fixture, and test changes if OpenCode Zen Go support or provider parity is wanted. Its Desktop change is absent from the Server branch and prevents an unchanged cherry-pick. |
| `9444a4d` — Desktop personalization and conversation improvements | Do not port | Still conflicts with the protected prompt-profile design and current Core prompt composition. The Server has no trusted producer or explicit product requirement for this personalization input. |
| `6e9a037` — Preserve image content returned by MCP tools | Recommended manual port | New since the previous review. It preserves standard MCP image blocks instead of replacing them with omission text. The Core and test changes are compatible, but the complete patch needs a small fixture adaptation because it assumes the `OPENCODE_API_KEY` entry introduced by `b597a4f`. This is a test-fixture overlap, not an architecture conflict. |

### Current integration order

1. Review and commit the applied `7282c6b` provider update.
2. Manually port `6e9a037`, retaining the Server branch's current model-credential stripping list in the MCP fixture while adding its image response and coverage.
3. Port the non-Desktop portions of `b597a4f` only if OpenCode Zen Go is needed.
4. Continue to skip `9444a4d` unless the Server gains a trusted, read-only personalization source and explicit precedence rules.

The original integration rule remains unchanged: select upstream work by commit and preserve the Server branch's Vision CLI, prompt hardening, workspace catalog, and Web UI-specific Core behavior. Do not replace `packages/core` with the upstream snapshot.

This refresh used a direct remote-tip query, Git history and source diffs, ancestry checks, and `git apply --check`. It did not fetch, modify either branch, integrate commits, or run tests.

The `7282c6b` working-tree port was subsequently validated with its exact upstream regression test, the existing provider and runtime-options tests, and the Core typecheck: 15 focused tests passed. Docker and live provider verification were not run.

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
