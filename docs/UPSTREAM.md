# Upstream integration notes

## 2026-08-18: status refresh

Current baseline:

- Upstream branch: remote `origin/dev` at `1ce0328`, verified directly with `git ls-remote`; the local `dev` branch matches it.
- Server branch: local `feature/server` at `b1f1668`; the published `fork/feature/server` remains at `c13d0b4` until the integration work is pushed.
- Merge base: unchanged at `5e37295`.
- `7282c6b` is integrated as `b1f1668`; the non-Desktop portion of `b597a4f` is applied in the working tree for review.
- Since the recorded upstream baseline `9f8559c`, upstream added one functional commit affecting Core, `6e9a037`, followed by merge commit `1ce0328`.

Four upstream-only commits after the merge base currently affect `packages/core`.

| Commit | Current decision | Integration status and rationale |
| --- | --- | --- |
| `7282c6b` — Release 0.3.6 with DeepSeek Pro selection | Integrated | Ported as `b1f1668`, including the `0.3.6` package-version updates and focused provider test. |
| `b597a4f` — Add OpenCode Zen Go API-key login | Ported for review | Its nine non-Desktop files are applied in the working tree: Core provider/login support, English and Chinese documentation, MCP credential stripping, and focused tests. The Desktop provider-ID change remains intentionally omitted. |
| `9444a4d` — Desktop personalization and conversation improvements | Do not port | Still conflicts with the protected prompt-profile design and current Core prompt composition. The Server has no trusted producer or explicit product requirement for this personalization input. |
| `6e9a037` — Preserve image content returned by MCP tools | Recommended clean port | New since the previous review. It preserves standard MCP image blocks instead of replacing them with omission text. With the `b597a4f` credential fixture now present, its complete three-file patch passes `git apply --check` without adaptation. |

### Current integration order

1. Review and commit the applied non-Desktop `b597a4f` port.
2. Port the complete `6e9a037` MCP image-result patch.
3. Continue to skip `9444a4d` unless the Server gains a trusted, read-only personalization source and explicit precedence rules.

The original integration rule remains unchanged: select upstream work by commit and preserve the Server branch's Vision CLI, prompt hardening, workspace catalog, and Web UI-specific Core behavior. Do not replace `packages/core` with the upstream snapshot.

This refresh used a direct remote-tip query, Git history and source diffs, ancestry checks, and `git apply --check`. It did not fetch, modify either branch, integrate commits, or run tests.

The `7282c6b` port was subsequently validated with its exact upstream regression test, the existing provider and runtime-options tests, and the Core typecheck: 15 focused tests passed. It was committed as `b1f1668`. Docker and live provider verification were not run.

The non-Desktop `b597a4f` working-tree port was validated with the login-scope, provider, runtime-options, and MCP tests: 31 focused tests passed, followed by the Core typecheck. Live OpenCode login and provider calls were not run.

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
