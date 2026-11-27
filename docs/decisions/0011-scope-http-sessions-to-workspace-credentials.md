# ADR-0011: Require the workspace credential on HTTP session routes

- Status: Deferred; not implemented
- Date: 2026-11-26
- Related: [ADR-0007](0007-tui-web-session-handoff.md)

## Context

DSCode Web uses the random workspace ID as a bearer credential. Opening the chat
page and discovering or activating a session already require it, but requests
against an active session currently require only the session ID. That ID alone
must not authorize access to the session or allow someone to spend model tokens.
Checking only the turn submission route is insufficient: the session details
response includes the workspace ID.

## Why this is deferred

For artifact-only sharing, a visitor should receive a read-only `share_id` and
only the files in an explicitly selected publication snapshot. An isolated
`sessionId` leak is not a primary risk in that workflow: opening the publication
does not normally expose chat requests, JSONL paths, or handoff documents. The
first priority is to ensure that neither private ID appears in the public link
or published files. The proposal below is not a prerequisite for that work.
Until it is implemented, an independently leaked active session ID still
authorizes access to that session.

The original transport proposal used `?workspaceId=<id>` because it works with
native `EventSource`. A proxy that logs full request URLs would then record both
IDs together, defeating the protection against a leak from those logs. If this
work resumes, prefer carrying the workspace credential in a request header so
session-scoped request URLs do not contain it. Native `EventSource` cannot send
custom headers, so this would require a `fetch()`-based SSE client or a separate
SSE credential design. Headers still need redaction in request traces. The added
client work is not justified by the artifact-only sharing scenario today.

## Candidate design if revisited

In workspace-capability mode, require the workspace credential on every HTTP
route under `/v1/sessions/:sessionId`, including the root route. The value must
match the workspace assigned to that session, not merely identify a configured
workspace. Apply one shared check before exposing state, opening an SSE stream,
or changing anything. Missing or mismatched credentials and unknown sessions
all return `404` with `session_not_found`.

Enable the complete mode on both the standalone Web server and TUI-owned `/web`.
Session listing must remain workspace-scoped and never enumerate IDs. Session
creation and resume keep their existing request body; a saved reload position
can only be used within the workspace that recorded it. Do not leave a parallel
route that accepts a session ID alone on a protected listener. Direct HTTP
adapter embeddings that expose their listener to untrusted callers must use the
same mode; any legacy mode is for trusted embeddings only.

No login, account system, prompt passphrase, Pi change, or session-file migration
is required. In-process scheduler and IM submission are unchanged. This does not
make existing `/share/:workspaceId/*` links safe to publish: those links still
disclose the workspace credential. Independent public shares are a separate
decision.

## Verification if implemented

- For a real active session, a missing credential or another valid workspace's
  credential returns the same `404` as an unknown session. Check details,
  history, SSE, turn submission, abort, UI responses, and deletion. Rejected
  requests must not start a turn, open a stream, or mutate the session.
- With the correct credential, verify normal chat, SSE, `/clear`, and `/reload`
  from both browser pages. In TUI-owned Web, reload still restores the selected
  branch and `/tui` still takes it back. A reload position from another workspace
  must not be used.
- External clients of protected listeners must supply `workspaceId`; update the
  HTTP documentation and smoke tests. There is no unauthenticated fallback.
