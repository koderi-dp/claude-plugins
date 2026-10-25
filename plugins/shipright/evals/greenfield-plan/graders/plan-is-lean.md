---
type: llm
focus: { source: file, path: ".shipright/plans/2026-01-01-word-counter.md" }
weight: 2
---
You are grading a shipright plan for a tiny command-line word counter.

PASS only if all of the following hold:
- Every task block has Files, Produces, Tests (with at least one bullet naming a test and its key assertion with concrete values, or `Tests: none, manual check on the Done line`) and Done lines.
- Produces lines give exact names and signatures (for example `countWords(text: string): number`), not vague descriptions.
- The exact user-facing strings from the request appear verbatim somewhere in Constraints or task bullets: `File not found: <path>` (or with a concrete path), exit code 2, and `0 words, 0 lines`.
- No task block contains function bodies, import statements or full test code; the plan holds decisions, not code.
- Every name a later task uses (a function, a file) appears in an earlier task's Produces or Files line.
- The plan has between two and four tasks.

FAIL if any of these is missing, if a task is clearly larger than about 20 lines of plan text, or if the plan contains implementation code.
