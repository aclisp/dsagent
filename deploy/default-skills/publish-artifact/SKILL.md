---
name: publish-artifact
description: Publish, list, and revoke public share links for static HTML artifacts. Use when the user explicitly asks to publish or share an HTML artifact, list its share links, or revoke a publication.
---

# Publish an artifact

Use `exec_command` with the built-in `dscode-artifact` command. It is available
in sessions served by standalone Web and TUI `/web`.
Invoke it directly, with literal arguments and no shell chaining.

1. Resolve the user's selected workspace-relative static directory and its
   HTML entry path, relative to that directory. Ask if either is ambiguous.
   Only publish code the user trusts, including its dependencies. Keep private URLs,
   credentials, and unrelated files out of the artifact.
2. Run `dscode-artifact preview "dist" "index.html"`. In interactive chats,
   show the complete file list and ask the user to confirm in their own words.
   Web chat displays the list automatically. For scheduled work, follow the
   user's task instructions.
3. When the user has authorized publication, run `dscode-artifact publish`.
   Use the returned share path. Web chat displays the full link using the
   current browser address. In other channels, relay the share path and tell
   the user where to find the full link in Web chat.

After a successful publication, later workspace changes do not change the
snapshot. To share a new version, prepare and confirm a new snapshot.

Use `dscode-artifact list` to list the workspace's active publications.
Use `dscode-artifact revoke <shareToken>` when the user explicitly asks to
revoke the identified link. Extract the token from the share link rather than
passing its full URL. If the user has not identified a unique link, list the
active links and ask which one to revoke. A revoked link cannot be restored.
