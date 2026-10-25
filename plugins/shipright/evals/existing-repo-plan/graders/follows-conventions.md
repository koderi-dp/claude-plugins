---
type: llm
focus: { source: file, path: ".shipright/plans/2026-01-01-done-command.md" }
weight: 2
---
You are grading a shipright plan that adds a `done` command to an existing notes CLI. The repo's CLAUDE.md says: all user-facing messages are exported constants in `src/messages.mjs`, never inlined; pure modules under `src/` never touch `process`, `fs` or the console, only `src/cli.mjs` does I/O; tests are `node:test` files named `test/<module>.test.mjs`, one per module.

PASS only if all of the following hold:
- The new message `No note with id <id>` is planned as a constant in `src/messages.mjs` (a Constraint or a task's Files/Produces says so), not inlined in cli.mjs.
- The done state is handled in a pure module (notes.mjs or similar) with a tested function whose Produces line gives an exact signature, and the exit code 1 path lives in cli.mjs.
- The store compatibility rule (a note without a `done` field loads as not done) is pinned by a test in the plan.
- Tests follow the naming convention `test/<module>.test.mjs`.
- Every task block has Files, Produces, Tests and Done lines, and the plan holds no function bodies or import statements.

FAIL if a message is inlined outside messages.mjs, if a pure module is planned to do I/O, if the store compatibility rule has no test, or if the plan contains implementation code.
