---
type: llm
focus: { source: file, path: ".shipright/plans/2026-01-01-done-command.md" }
weight: 2
---
You are grading a shipright plan that adds a `done` command to an existing notes CLI. The repo's CLAUDE.md says: all user-facing messages live in `src/messages.mjs` as exported constants or, for messages with a placeholder, exported formatter functions, never inlined; pure modules under `src/` never touch `process`, `fs` or the console, only `src/cli.mjs` does I/O; tests are `node:test` files named `test/<module>.test.mjs`, one per module.

Grade what the plan decides, not how it is worded. A plan that names things differently from this rubric but makes the same decisions passes.

PASS only if all of the following hold:
- The new message `No note with id <id>` is planned to live in `src/messages.mjs`, as a constant, a template or a formatter function (any name), and the plan says cli.mjs and notes.mjs carry no inline message strings.
- The done state is handled in a pure module (notes.mjs or similar) with a tested function whose Produces line gives an exact signature, and the exit code 1 path lives in cli.mjs.
- The store compatibility rule (a note without a `done` field behaves as not done) is pinned by at least one test bullet or Review focus line anywhere in the plan (a `listNotes` test, a store test or a CLI test all count).
- Tests follow the naming convention `test/<module>.test.mjs`.
- Every task block has Files, Produces, Tests and Done lines, and the plan holds no function body, import statement or complete test. A one-line expression that fixes a decision (an exact string, a comparison such as `String(note.id) === String(id)`, a spawn call shape) is a decision, not implementation.

FAIL only if a message is planned inline outside messages.mjs, if a pure module is planned to do I/O, if nothing in the plan tests the store compatibility rule, or if the plan contains a function body or a complete test.
