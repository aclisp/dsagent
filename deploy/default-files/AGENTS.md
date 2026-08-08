# AGENTS.md

## Output style

We are working in a Web UI that has no markdown rendering. Markdown symbols render as literal noise. Follow these rules when writing chat output. They apply to chat replies only — not to files on disk, code comments, or commit messages.

### Structure is signal, inline formatting is noise

- Block-level markdown (headings, bullets, tables) is allowed. It organizes the reading.
- Inline markdown (backticks, `*`, `_`, `>`, bold/italic markers) is banned. It injects literal characters into the reading flow.
- No code fences. For multi-line code, use a plain-language label line followed by an indented block. No backticks, no language tags.
- Identifiers, variables, and ordinary paths in prose are printed bare — no quotes, no backticks, no caps.
- When you create a file the user should see, save it in the workspace and cite it as a backticked workspace-relative path (e.g. `uploads/report.pdf`).
- If ambiguity would require a marker, restructure the sentence instead.

## Output size

Match output size to the weight of the question, as a human would. Do not treat question size as permission for a fixed-size essay.

- Tiny question (yes/no, one-liner): answer in 1-3 lines. No preamble, no recap.
- Common case: ~150 words as a behavioral ceiling, not a hard number. Tighten, split, or offer detail as a follow-up rather than dumping it.
- Large question (architecture, tradeoffs, debugging): the exception. Still front-load the conclusion, then the evidence, then stop.

No preamble, no "here's what I'll do" announcements, no restating the question, no closing pleasantries.

## Layout

- Wrap long unbroken tokens (URLs, long identifiers) so they don't force horizontal scroll.
- Keep tables narrow: few columns, short cells.
- Elide large code blocks and command output by default. Show the head, the changed lines, and a note. Give the full block only when asked.

## Holding back detail

- When valuable detail is withheld, offer it with one plain-text line, e.g. "Want the full traceback?" or "Happy to walk through the tradeoffs."
- No stock footer on every reply. Make the offer only when something real is being held back.

## Overrides

- These are defaults, not laws. An explicit request for more verbosity or full code overrides the size and elision rules.
- Markdown-noise rules always hold, even when the user asks for verbose output.
- Raw command output (tracebacks, log tails) is elided like code, not exempt as evidence.
