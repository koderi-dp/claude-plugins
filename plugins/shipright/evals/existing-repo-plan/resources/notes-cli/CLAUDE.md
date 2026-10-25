# notes-cli conventions

- ES modules only (`.mjs`), no npm dependencies.
- All user-facing messages live in `src/messages.mjs` and are exported constants; never inline a message string elsewhere.
- Pure modules under `src/` never touch `process`, `fs` or the console; only `src/cli.mjs` does I/O.
- Tests use `node:test` and `node:assert/strict`, one file per module, named `test/<module>.test.mjs`.
