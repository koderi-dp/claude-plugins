---
name: pipeline-rules
description: Use when a session starts in a project that has docs/pipeline/config.json, and in every turn of such a project before touching the backlog, a spec, a plan or a ledger. Tells the lead where the pipeline's files are, that only the mcp__pipeline__pipeline tool writes backlog.json and the ledgers, that subagents never touch them, and how to answer during a run.
---

# pipeline-rules

This project runs on the pipeline plugin. The files live under `docs/pipeline/` in the main checkout of the repository (from a worktree too):

- `config.json`: the rules the plugin enforces (checks, risky and protected paths, models, limits, merge mode, stop conditions, the runner). `/pipeline config` shows or changes it.
- `rules.md`: process rules the config cannot express, numbered, grouped by when they apply (`before dispatch`, `in every implementer brief`, `in every reviewer brief`, `before the PR`, `after merge`). The run skill pastes each group into the brief or step it names. Keep it under about 40 lines; delete a rule nobody needs.
- `backlog.json`: the items and their status; array order is priority. `BACKLOG.md` is its generated view, never edited.
- `specs/<id>.md` and `plans/<id>.md`: one spec and one plan per item, ordinary files you write with Write.
- `ledgers/<id>.json`: the item's record; `ledgers/<id>/`: briefs and reports for the record.

## Rules

1. **Only the tool writes `backlog.json` and `ledgers/<id>.json`.** Use `mcp__pipeline__pipeline` (`add`, `update`, `move`, `remove`, `park`, `unpark`, `ledger`); never Edit or Write those files, and never write `BACKLOG.md`, the tool regenerates it after every write.
2. **Subagents never touch them.** A subagent's tool call is ignored and changes nothing; never put a backlog or ledger instruction in a brief. The lead records a task's outcome after reading the report.
3. **Read before you say.** `{ "action": "get" }` answers the config, the backlog, the active item's `resume` block and any open watchdog signal; `{ "action": "status" }` answers the status block. Where the project stands comes from there, never from memory.
4. **Statuses**: `inbox`, `ready`, `planning`, `building`, `review`, `merged`, `blocked`, `parked`. An item is `ready` only when its spec has no open question and every id in `needs` is `merged`.
5. **One line per reply during a run**: `p12 · task 3/6 · implementer sonnet 14 min · fix round 1`. A milestone adds what changed: `p12 merged · PR #31 · 6 tasks · 2 rulings · 1.4M tokens · next: p13`. A watchdog signal in a `get` answer is acted on in that turn and named in the line.
6. **`rules.md` applies at the step its group names.** Read it at item start; a rule learned from a defect may be appended, said in the one-line reply.
7. **Session start.** If `get` reports an item in `building` or `review`, say its `resume` block in one line and continue with the run skill when asked; otherwise say the status line and wait. A new request goes through the intake skill; the build starts only on `/pipeline next` or `/pipeline run`.
8. **Runners.** `runner: subagent` (the default) runs an item in this session with subagents. `runner: session` runs each item in a headless child session of its own: the lead calls `start { item }` and answers its line, the child does the rest in the item's worktree, and `stop { item }` and `log { item }` (`/pipeline stop <id>`, `/pipeline log <id>`, the panel's buttons) kill it or show its log. An item whose note says `session runner` belongs to a child; `get` answers `children` (this session's) and `siblings` (other sessions on the repository, from the live file). A child session is a normal session of the project and follows these rules; it never starts children.
9. **Commits.** Everything under `docs/pipeline/` goes on the item's branch, except `backlog.json` and `BACKLOG.md`, which the lead commits on the main branch. No model identifier in commits, PR text or comments.
