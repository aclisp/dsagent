# Upstream integration notes

## Current policy (2026-08-29)

DSCode is an independent product that preserves the original `dscode` Git
history. The repository is maintained on the product remote and receives
selected upstream changes only after review.

The canonical remote layout is:

- `origin`: `https://github.com/aclisp/dsagent.git`, the product repository
- `upstream`: `https://github.com/thinkany-ai/dscode.git`, fetch-only source
- `dev` and `main`: product branches that track `origin`
- primary upstream source: `upstream/dev`; `upstream/main` and upstream tags
  are used as release-state references

## One-time migration from the fork branch layout

The original fork used local `dev` as a branch that tracked the upstream
repository. After the fork became an independent product, `dev` was reassigned
to the product development line, and the old upstream-tracking branch was
renamed to `upstream-dev`.

Run this migration once, after the product repository has established its
remote `dev` branch from the former product branch (`feature/server`). Start
with a clean worktree and check out the former product branch:

```bash
git fetch origin
git switch feature/server
git branch -m dev upstream-dev
git branch -m feature/server dev
git branch --set-upstream-to=upstream/dev upstream-dev
git branch --set-upstream-to=origin/dev dev
git pull --ff-only origin dev
```

The migration only renames local branches and changes their tracking
configuration; it does not rewrite or discard any commits. Verify the result
with:

```bash
git branch -vv
```

The expected layout is:

- local `dev` tracks `origin/dev` and contains product development
- local `upstream-dev` tracks `upstream/dev` and is used only as an upstream
  reference

Keep the old remote `feature/server` branch until the new `dev` line and its
first release have been validated. It can be deleted separately later as a
repository housekeeping step.

Upstream synchronization is manual and ad hoc. For each integration, create a
temporary `upstream-sync/*` branch from the product development branch, select
specific commits, open a reviewable pull request, and update this ledger. Do
not merge the whole upstream branch or replace `packages/core` with an
upstream snapshot.

Use `git cherry-pick -x` when an upstream commit applies unchanged. For an
adapted or partial port, preserve the source SHA in an `Upstream-Commit:
<sha>` trailer and document what was omitted or changed here. Keep skipped
commits and their rationale in the ledger. The product's Vision CLI, prompt
hardening, workspace catalog, and Web UI-specific Core behavior remain
protected integration boundaries.

The dated entries below are an append-only historical record. Remote names in
those entries describe the layout that existed when each review was written;
the current remote policy is the one above.

## 2026-08-18: status refresh

Current baseline:

- Upstream branch: remote `origin/dev` at `1ce0328`, verified directly with `git ls-remote`; the local `dev` branch matches it.
- Server branch: local `feature/server` contains the selected upstream ports through `3751518`; the published `fork/feature/server` remains at `c13d0b4` until the integration work is pushed.
- Merge base: unchanged at `5e37295`.
- `7282c6b` is integrated as `b1f1668`; the non-Desktop portion of `b597a4f` is integrated as `7ff320d`; `6e9a037` is integrated as `3751518`.
- Since the recorded upstream baseline `9f8559c`, upstream added one functional commit affecting Core, `6e9a037`, followed by merge commit `1ce0328`.

Four upstream-only commits after the merge base currently affect `packages/core`.

| Commit | Current decision | Integration status and rationale |
| --- | --- | --- |
| `7282c6b` — Release 0.3.6 with DeepSeek Pro selection | Integrated | Ported as `b1f1668`, including the `0.3.6` package-version updates and focused provider test. |
| `b597a4f` — Add OpenCode Zen Go API-key login | Integrated | Ported as `7ff320d`: Core provider/login support, English and Chinese documentation, MCP credential stripping, and focused tests. The Desktop provider-ID change remains intentionally omitted. |
| `9444a4d` — Desktop personalization and conversation improvements | Do not port | Still conflicts with the protected prompt-profile design and current Core prompt composition. The Server has no trusted producer or explicit product requirement for this personalization input. |
| `6e9a037` — Preserve image content returned by MCP tools | Integrated | Ported as `3751518` without functional adaptation. Standard MCP image blocks are now preserved for the agent instead of being replaced with omission text. |

### Current integration state

- All currently accepted Core upstream ports are integrated.
- Continue to skip `9444a4d` unless the Server gains a trusted, read-only personalization source and explicit precedence rules.

The original integration rule remains unchanged: select upstream work by commit and preserve the Server branch's Vision CLI, prompt hardening, workspace catalog, and Web UI-specific Core behavior. Do not replace `packages/core` with the upstream snapshot.

This refresh used a direct remote-tip query, Git history and source diffs, ancestry checks, and `git apply --check`. It did not fetch, modify either branch, integrate commits, or run tests.

The `7282c6b` port was subsequently validated with its exact upstream regression test, the existing provider and runtime-options tests, and the Core typecheck: 15 focused tests passed. It was committed as `b1f1668`. Docker and live provider verification were not run.

The non-Desktop `b597a4f` port was validated with the login-scope, provider, runtime-options, and MCP tests: 31 focused tests passed, followed by the Core typecheck. It was committed as `7ff320d`. Live OpenCode login and provider calls were not run.

The `6e9a037` port was validated with both MCP tests, covering credential stripping and image-content preservation, followed by the Core typecheck. It was committed as `3751518`. Live MCP image-result verification was not run.

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
