---
name: pipeline-init
description: Use on /pipeline-init, on /pipeline init, and when the user asks to set up, start or initialise the pipeline in a project that has no docs/pipeline/config.json. Creates the config, an empty backlog and a rules.md fitted to the project through the mcp__pipeline__pipeline tool, or hands over to pipeline-migrate when the project already keeps a queue.
---

# pipeline-init

Sets a project up for the pipeline in one turn, with one line back. Never asks a question that the project's files can answer.

1. **Already set up?** If `docs/pipeline/config.json` exists, answer `pipeline: already set up · /pipeline status` and stop.
2. **Has a queue?** If the project has a work queue, a workflow document or ledgers (`docs/backlog.md`, `docs/WORKFLOW.md`, `docs/SLICES.md`, an "MVP queue" or status table in `CLAUDE.md`, `.superpowers/sdd/**/progress.md`, `docs/superpowers/ledgers/`), do not init: use the `pipeline-migrate` skill instead, which drafts the config and the backlog from those files, and say so in one line.
3. **Init.** `{ "action": "init" }` writes `docs/pipeline/config.json` with the defaults, an empty `backlog.json` and `BACKLOG.md`, and ends with `commit docs/pipeline/ on <mainBranch> now: git add docs/pipeline && git commit`: do that in this step, after steps 4 and 5 have fitted the config and written `rules.md`, with the attribution lines this session was given and no model identifier. The tool's files are versioned and never gitignored: the backlog, the ledgers and the rules are the project's record, and an uncommitted `docs/pipeline/` exists on one machine only.
4. **Fit the config to the project.** `config.json` is a file you edit (the backlog and ledgers are the tool's; the config is not). Read `package.json` scripts, the `Makefile`, the CI workflow under `.github/workflows/` and `git branch --show-current`, then set:
   - `mainBranch`: the default branch (`git symbolic-ref refs/remotes/origin/HEAD`, else `main`).
   - `checks.fast`: a per-edit check if one exists (`check:fast`, `lint:fast`); `checks.task`: the test command (`npm test`, `make test`, `go test ./...`, `cargo test`); `checks.gate`: the full gate (`make check`, a `ci`/`verify`/`check` script, else build + typecheck + test + lint joined with `&&`). Leave a tier out rather than invent one.
   - `riskyPaths`: real directories that hold auth, sessions, migrations, parsers of untrusted input, payments or pricing, concurrency; from the layout, not from guesses. Empty is fine.
   - `protectedPaths`: `.github/workflows/**` plus deploy and release folders that exist.
   - `merge`: `pr` unless the user has said auto-merge is on. Everything else keeps its default.
5. **rules.md.** Write `docs/pipeline/rules.md` with the five group headings (`before dispatch`, `in every implementer brief`, `in every reviewer brief`, `before the PR`, `after merge`) and only the rules `CLAUDE.md` already states that the config cannot express (a test account, a browser rule, an env var that makes tests skip, a hand-off step). No rule is better than an invented one.
6. **Answer** in one line: `pipeline set up · gate: make check · 2 risky paths · next: /pipeline add <request> or /pipeline migrate` (the migrate part only when step 2 found nothing but the user may still have notes elsewhere), then stop. Do not add items, do not start a run.
