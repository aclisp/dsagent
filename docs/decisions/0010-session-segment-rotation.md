# ADR-0010: Rotate session segments after automatic compaction

- Status: Withdrawn; not implemented
- Date: 2026-11-26

## Withdrawal

For long-running work, write a handoff, exit DSCode, and start a fresh session
without `--continue`. Read the handoff in the new session and keep the old JSONL
for reference. This frees the old process's memory without changing Pi or the
session format. The trade-off is that the task continues in a new session rather
than under the same session ID.

## Original proposal

Seal the current JSONL segment only after automatic context compaction succeeds,
its compaction record has been persisted, and the segment is at least the minimum
size in bytes. Append the next entry to a new segment of the same session. If the
segment is too small, keep appending to it. Manual `/compact` and failed or
cancelled compactions do not trigger rotation.

Rotation preserves all history: it does not delete or rewrite existing entries.
Unlike the former pruner (`64ab77b6`, removed in `41e52a49`), it changes only
where subsequent entries are written.

## Rationale

Automatic compaction provides a natural rotation point in a long conversation.
Manual compaction may happen at any time, and automatic compaction is driven by
model context rather than file size. The byte minimum avoids creating tiny files
when automatic compaction happens early. The threshold value is deferred, and
this rule does not impose a maximum segment size.

## Verification

The goal is to prevent cold history from increasing the cost of resuming or
continuing a session. Rotation alone does not establish this: ordinary turns and
resumes must not scan cold history or keep its payloads in memory. This guarantee
does not cover the cost of building or rebuilding an index, explicit history
reads, or images that are still part of the active context.

Use small fixtures with identical active context, different numbers of sealed
segments, and identifiable inline images excluded by automatic compaction.

1. **Repeated resume:** With the index already built, run `dscode --continue`
   repeatedly. Verify that it reconstructs the same model context without
   scanning all archived segments or reading the old image payloads. Count
   records and bytes read rather than relying on elapsed time alone.
2. **Continuous use:** Trigger several automatic compactions and rotations in
   one process. Verify that the session runtime and TUI caches no longer hold
   references to the old Base64 payloads, and that ordinary per-turn processing
   does not traverse more history as sealed segments accumulate. Check retained
   references rather than waiting for garbage collection.
3. **Lossless recovery:** Concatenate the segments in order and compare them
   byte for byte with the same entries written without rotation. Interrupt
   rotation and verify that all successfully persisted entries can still be
   recovered. Verify that the agent can locate and recover archived text through
   `read`. For an archived image, extract the original into an image file for
   `read` rather than relying on an inline Base64 line fitting its text limit.
