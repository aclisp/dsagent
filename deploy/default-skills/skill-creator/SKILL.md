---
name: skill-creator
description: Create new skills and improve existing ones. Use when the user wants to turn a workflow into a reusable skill, write or structure a SKILL.md, draft a skill's frontmatter or description, or refine an existing skill's instructions or trigger description.
---

# Skill Creator

A guide to creating new skills and iteratively improving them. A skill is a directory with a
`SKILL.md` that teaches the model a reusable procedure. Skills are verified by **real use**, not
scripted checks — you draft, apply it in an actual scenario with the user, learn from what
happened, and refine. There is no separate testing harness; the test is the user's real task.

## Communicating with the user

Users of this skill range widely in technical familiarity. Match your language to the user:
avoid unexplained jargon like "assertion" or "JSON schema" unless the user has shown they know
what those mean. It's fine to briefly define a term when in doubt.

## Creating a skill

### Capture intent

Understand what the user wants before writing anything. If the conversation already contains a
workflow to capture (e.g. "turn this into a skill"), extract it from the conversation first — the
tools used, the sequence of steps, corrections the user made, input/output formats observed. Have
the user fill gaps and confirm before proceeding.

1. What should this skill enable the model to do?
2. When should it trigger? (what user phrases or contexts)
3. What's the expected output format?
4. Would test cases help? Skills with objectively verifiable outputs (file transforms, data
   extraction, code generation, fixed workflows) benefit from them; subjective outputs (writing
   style, art) usually don't. Suggest the appropriate default, but let the user decide.

### Interview and research

Ask about edge cases, input/output formats, example files, success criteria, and dependencies
before drafting. Come prepared with context so the user doesn't have to explain everything from
scratch. If useful, research (search docs, look up best practices, find similar skills) before
writing.

## Writing the SKILL.md

### Anatomy

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled resources (optional)
    ├── scripts/    - executable code for deterministic/repetitive tasks
    ├── references/ - docs loaded into context as needed
    └── assets/     - files used in output (templates, icons, fonts)
```

### Frontmatter

- **name** — the skill identifier.
- **description** — the primary triggering mechanism. Include both what the skill does AND
  specific contexts for when to use it. All "when to use" info goes here, not in the body.

Models tend to undertrigger skills — not to use them when they'd help. Write descriptions a
little "pushy": instead of "How to build a simple fast dashboard to display internal data.",
write "… Make sure to use this skill whenever the user mentions dashboards, data visualization,
internal metrics, or wants to display any kind of company data, even if they don't explicitly ask
for a 'dashboard.'"

### Progressive disclosure

Skills load in three levels:

1. **Metadata** (name + description) — always in context (~100 words).
2. **SKILL.md body** — in context whenever the skill triggers (<500 lines ideal).
3. **Bundled resources** — loaded as needed.

Key patterns:

- Keep the body under ~500 lines; if you approach the limit, add another layer of hierarchy with
  clear pointers about where to go next.
- Reference files clearly, with guidance on when to read them.
- For large reference files (>300 lines), include a table of contents.
- When a skill covers multiple domains/frameworks, organize by variant: keep the workflow and
  selection logic in SKILL.md and put one reference file per variant; the model reads only the
  relevant one.

### Safety

Skills must not contain malware, exploit code, or anything that could compromise system
security. Don't go along with requests to create misleading skills or skills designed to
facilitate unauthorized access or data exfiltration.

### Writing patterns

Prefer the imperative form. Define output formats exactly:

```markdown
## Report structure
ALWAYS use this exact template:
# [Title]
## Executive summary
## Key findings
## Recommendations
```

Include examples:

```markdown
## Commit message format
**Example 1:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication
```

### Writing style

Explain *why* things matter instead of stacking MUSTs. Make the skill general, not narrow to
specific examples. Draft, then re-read with fresh eyes and improve.

## Testing the skill

After drafting, come up with 2–3 realistic test prompts — the kind of thing a real user would
actually say. Share them with the user for sign-off, then run them **in a real scenario** with
the user and review the outputs together. Iterate based on what actually happens. There is no
scripted evaluation step — the skill improves through genuine use.

## Improving the skill

Generalize from the user's feedback. You're building a skill meant to be used many times across
many prompts; iteration on a few examples is just how you move faster. If the skill only works
for those examples it's useless.

1. **Keep the prompt lean.** Remove things that aren't pulling their weight. If the model wastes
   time on unproductive steps, cut the parts causing it.
2. **Explain the why.** Transmit understanding of the task into the instructions. Repeated
   ALWAYS/NEVER in all caps or rigid structures is a yellow flag — reframe and explain the
   reasoning instead.
3. **Look for repeated work.** If the model keeps writing the same helper script or taking the
   same multi-step approach across tasks, that's a strong signal the skill should bundle it once
   in `scripts/` and tell the skill to use it — saving every future invocation from reinventing
   the wheel.

Take your time; writing a draft revision and then looking at it anew pays off. Keep iterating
until the user is happy or you're not making meaningful progress.

## Optimizing the description

The frontmatter `description` decides whether the skill triggers. After the skill works, offer to
optimize it. Think through realistic should-trigger and should-not-trigger queries:

- **Should-trigger:** different phrasings of the same intent (formal and casual), cases where the
  user doesn't name the skill or file type but clearly needs it, uncommon use cases, and cases
  where this skill competes with another but should win.
- **Should-not-trigger:** near-misses that share keywords with the skill but need something
  different. Make them genuinely tricky, not obviously irrelevant.

Remember that skills only trigger for tasks the model can't easily handle alone — simple
one-step queries won't trigger even with a perfect description, so test with substantive,
multi-step requests. Update the description and show the user before/after.

## Updating an existing skill

- **Preserve the original name.** Use the directory name and `name` frontmatter field unchanged.
- **Copy to a writable location before editing.** The installed skill path may be read-only; copy
  to a temp location, edit there, and point the user at the result.

---

Good luck!

*Adapted from [Anthropic's skill-creator](https://github.com/anthropics/skills) (MIT).*