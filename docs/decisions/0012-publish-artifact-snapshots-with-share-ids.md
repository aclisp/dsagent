# ADR-0012: Publish artifact snapshots with independent share tokens

- Status: Proposed
- Date: 2026-11-26
- Related: [ADR-0007](0007-tui-web-session-handoff.md), [ADR-0011](0011-scope-http-sessions-to-workspace-credentials.md)

## Context

A workspace owner wants to send an interactive HTML artifact to someone without
giving them access to the agent, its history, or other workspace files. The
current `/share/<workspace_id>/…` link exposes the same bearer credential used
to open chat and discover or activate sessions. A passphrase in an input hook
would run too late and protect only prompt submission, not the rest of the
Web interface.

## Proposed decision

Publish an immutable snapshot of an explicitly selected static directory and
entry page, such as `dist/` and `index.html`. Show the publisher the exact files
that will become available. Copy only regular files in the selected directory;
exclude hidden files and reject symlinks and paths that escape the directory.
Preserve relative paths so the entry page can load its scripts, styles, and
images. Do not rewrite arbitrary HTML or fetch dependencies during publication.
Changes in the workspace do not change the published snapshot. To update a
publication, publish a new snapshot and revoke the old link if needed.

Use **Publish artifact** for the action and **Share link** for its result.
Generate an independent `shareToken` for each publication from 9
cryptographically random bytes encoded as 12 unpadded Base64URL characters
(72 bits of entropy). It grants read access to that snapshot; it is not a
stable app ID.
The share link `/s/<shareToken>/` redirects to the selected entry page at
`/s/<shareToken>/<entry-path>` so relative assets resolve correctly even when
the entry is nested. Anyone with the token can use `GET` or `HEAD` to read files
from the snapshot. The public route does not list directories, read from the
live workspace, or accept writes. Opening a publication does not discover
sessions, create a turn, or call a model. Only a holder of the owning workspace
credential can publish, manage, or revoke the link. Revocation denies requests
for the short link, the entry page, and its assets; already downloaded copies
cannot be recalled.

## External backends and frontend versions

A published frontend may call an independently deployed API such as Directus.
DSCode does not host or proxy that backend, and Directus is not a dependency.
The backend enforces its own permissions: a `shareToken` neither grants nor
revokes API access. Do not include privileged API credentials in the snapshot.

Separate share tokens let old and new frontend versions coexist for preview and
manual rollback by returning to the earlier link. A stable URL that switches
traffic between versions is out of scope for the first release. If both
versions use the same backend, its API must remain compatible with both.
Switching the frontend does not roll back backend data or schema changes.

## Single-origin deployment

Use the same origin for the first release. Keep the existing private workspace
credential for chat and management; do not add accounts, login cookies, or
prompt passphrases. The public route never discloses a `workspace_id` or
`session_id` in its generated links or responses. The publisher must not include
private URLs or IDs in the files being published. Suppress referrers on private
pages and when opening a public link, and do not give a newly opened publication
a reference to the private opener page.

A URL path is not a browser isolation boundary. A publisher who includes JS
must trust that code and its dependencies to run on the same origin. The first
release does not support untrusted executable uploads. If that becomes a
requirement, revisit a separate origin or an opaque-origin sandbox; the latter
can affect features such as storage and requests for assets.

The existing `/share/<workspace_id>/…` route remains a private file preview, not
a publication URL. Previously distributed workspace IDs must be treated as
disclosed; new share tokens do not revoke them. ADR-0011 is deferred, so a separately
leaked active session ID still grants access under the current API. This feature
must not expose either private ID, but it does not change session authorization.

## Acceptance criteria

- A visitor with only `/s/<shareToken>/` lands on the chosen entry and can load
  its relative assets, including when the entry is nested. The response exposes
  neither private ID, and using the token against chat or session routes does
  not start a turn or call a model.
- The public route serves only the snapshot. Requests for another publication's
  files without its ID, paths outside the snapshot, and directory listings are
  rejected. Live workspace edits do not alter the publication.
- The owner can revoke a link without revoking other publications or changing
  the workspace ID. A fresh request for the revoked page or any of its assets
  fails. Existing private chat and file previews continue to work.
