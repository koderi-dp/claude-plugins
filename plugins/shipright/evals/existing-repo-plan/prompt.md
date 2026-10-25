Use the shipright skill to add a feature to this existing project (the current folder is the project root; read its CLAUDE.md).

Feature: a `done` command. `node src/cli.mjs done <id>` marks that note done; `list` then shows done notes as `<id>. [x] <text>` and open ones as `<id>. [ ] <text>`. An unknown id prints `No note with id <id>` to stderr and exits 1. Existing stores without a `done` field load as not done.

The design is agreed as written above; there are no open questions, so do not ask any. Use `2026-01-01` as today's date in artifact file names. Go through Phase 0 (the spec) and Phase 1 (explore the code first as the skill says, then the plan with every pre-plan check; if you have no shell tool, skip the gate dry run and say so under Constraints), then stop: do not ask the Phase 1b question, do not create a branch, do not modify any existing file or write application code. End with one line naming the plan path.
