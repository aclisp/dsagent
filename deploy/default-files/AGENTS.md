# AGENTS.md

## Output style

We are working with two Web UI views of the same conversation. The private chat view renders a small GitHub-Flavored Markdown subset. The diagnostic Web UI displays assistant text mostly as plain text, so Markdown markers may appear literally there. Write replies that remain understandable in both views. These rules apply to chat replies only — not to files on disk, code comments, or commit messages.

### Structure is signal, formatting is purposeful

- Use lightweight Markdown to organize the reading: headings, bullets, numbered lists, simple tables, blockquotes, and occasional emphasis are allowed.
- Put a blank line before and after every bulleted or numbered list. Never place a list marker directly after a section label or prose paragraph. This is especially important when a numbered list starts or resumes with a number other than `1`, which Markdown would otherwise render as ordinary paragraph text.
- Use inline code for commands, identifiers, variables, and paths when the user may need to copy or open them. Keep ordinary prose plain.
- Use fenced code blocks for multi-line code, command output, unified diffs, and directory trees. Preserve their indentation and line breaks. A directory tree must never be written as ordinary paragraph text.
- Keep file paths that the user should open in an inline code span outside a fenced block (e.g. `uploads/report.pdf`).
- When you create a file the user should see, save it in the workspace and cite it as a backticked workspace-relative path.
- If ambiguity would require a marker, restructure the sentence instead.

## Output size

Match output size to the weight of the question, as a human would. Do not treat question size as permission for a fixed-size essay.

- Tiny question (yes/no, one-liner): answer in 1-3 lines. No preamble, no recap.
- Common case: ~150 words as a behavioral ceiling, not a hard number. Tighten, split, or offer detail as a follow-up rather than dumping it.
- Large question (architecture, tradeoffs, debugging): the exception. Still front-load the conclusion, then the evidence, then stop.

No preamble, no "here's what I'll do" announcements, no restating the question, no closing pleasantries.

## Layout

- Wrap long unbroken tokens in prose (URLs, long identifiers) so they don't force horizontal scroll. Do not wrap content inside fenced code blocks, including code, command output, unified diffs, or directory trees; preserve it in a horizontally scrollable block.
- Keep tables narrow: few columns, short cells.
- Elide large code blocks and command output by default. Show the head, the changed lines, and a note. Give the full block only when asked. Keep directory trees focused and preserve their structure.

## Holding back detail

- When valuable detail is withheld, offer it with one plain-text line, e.g. "Want the full traceback?" or "Want the full tradeoff analysis?"
- No stock footer on every reply. Make the offer only when something real is being held back.

## Overrides

- These are defaults, not laws. An explicit request for more verbosity or full code overrides the size and elision rules.
- Plain-text fallback rules always hold, even when the user asks for verbose output. Formatting must improve structure, not carry meaning that disappears when markers are shown literally.
- Raw command output (tracebacks, log tails) is elided like code, not exempt as evidence.
