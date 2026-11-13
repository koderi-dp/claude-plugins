---
name: pipeline-rules
description: Use when a session starts in a project that has docs/pipeline/config.json, and in every turn of such a project before touching the backlog, a spec, a plan or a ledger. Tells the lead where the pipeline's files are, that only the mcp__pipeline__pipeline tool writes backlog.json and the ledgers, that subagents never touch them, and how to answer during a run.
---

# pipeline-rules

This project runs on the pipeline plugin. The files live under `docs/pipeline/`. The tool's files (`backlog.json`, `BACKLOG.md`, `ledgers/<id>.json`) are always the main checkout's, from a worktree too; the files the lead writes by hand (a plan, briefs, reports) go into the worktree it is in, at the relative path, and reach the main branch through the item's PR (the engine refuses a hand edit at the main checkout's path from inside a worktree):

- `config.json`: the rules the plugin enforces (checks, risky and protected paths, models, limits, merge mode, stop conditions, the runner). `/pipeline config` shows or changes it.
- `rules.md`: process rules the config cannot express, numbered, grouped by when they apply (`before dispatch`, `in every implementer brief`, `in every reviewer brief`, `before the PR`, `after merge`). The run skill pastes each group into the brief or step it names. Keep it under about 40 lines; delete a rule nobody needs.
- `backlog.json`: the items and their status; array order is priority. `BACKLOG.md` is its generated view, never edited.
- `specs/<id>.md` and `plans/<id>.md`: one spec and one plan per item, ordinary files you write with Write.
- `ledgers/<id>.json`: the item's record; `ledgers/<id>/`: briefs and reports for the record. The tool renders every brief (`brief`) and checks the plan (`plan`); the lead writes neither a brief nor a ledger task list by hand.

## Rules

1. **Only the tool writes `backlog.json`, `BACKLOG.md`, `facts.md` and `ledgers/<id>.json`.** Use `mcp__pipeline__pipeline` (`add`, `update`, `move`, `remove`, `park`, `unpark`, `ledger`, and the run's own actions). The plugin enforces it: an edit of one of those files, or a shell command that writes one, is refused for the lead and for subagents alike, with the action to use. Never look for a way round it (a script, a temp copy moved into place): a repair goes through `ledger` (text for `resume` is its state, `null` removes a key) or `update`. Every write takes a lock shared by all sessions on the repository, so two sessions never overwrite each other; a write may wait a moment for another session's.
2. **Subagents never touch them.** A subagent's tool call is ignored and changes nothing; never put a backlog or ledger instruction in a brief. The lead records a task's outcome after reading the report.
3. **Read before you say.** `{ "action": "get" }` answers the active item with its `resume` block, the open watchdog signals, the counts, the next three items and the config keys a run reads; `{ "action": "signals" }` the open signals alone; `{ "action": "status" }` the status block and `status { id }` an item's ledger. Where the project stands comes from there, never from memory. Every answer stays in the conversation and is read again on every later call: `get` once per item and after a restart, `signals` for watchdog checks, `status` when the user asks, never `get { "full": true }` during a run.
4. **Statuses**: `inbox`, `ready`, `planning`, `building`, `review`, `merged`, `blocked`, `parked`. An item is `ready` only when its spec has no open question and every id in `needs` is `merged`.
5. **One line per reply during a run**: `p12 · task 3/6 · implementer sonnet 14 min · fix round 1`. A milestone adds what changed: `p12 merged · PR #31 · 6 tasks · 2 rulings · 1.4M tokens · next: p13`. A watchdog signal in a `get` or `signals` answer is acted on in that turn and named in the line. The write actions answer one line each; never re-read a file to check one.
6. **`rules.md` applies at the step its group names.** Read it at item start; a rule learned from a defect may be appended, said in the one-line reply.
7. **Session start.** If `get` reports an item in `building` or `review`, say its `resume` block in one line and continue with the run skill when asked; otherwise say the status line and wait. A new request goes through the intake skill; the build starts only on `/pipeline next` or `/pipeline run`.
8. **Runners.** `runner: subagent` (the default) runs an item in this session with subagents. `runner: session` runs each item in a headless child session of its own: the lead calls `start { item }` and answers its line, the child does the rest in the item's worktree, and `stop { item }` and `log { item }` (`/pipeline stop <id>`, `/pipeline log <id>`, the panel's buttons) kill it or show its log. An item whose note says `session runner` belongs to a child; `get` answers `children` (this session's) and `siblings` (other sessions on the repository, from the live file). A child session is a normal session of the project and follows these rules; it never starts children.
9. **Commits.** Everything under `docs/pipeline/` goes on the item's branch, except `backlog.json` and `BACKLOG.md`, which the lead commits on the main branch. No model identifier in commits, PR text or comments.

## With queue: github

When `config.queue` is `github`, the open issues with the queue label are the backlog, an issue number is the id, and only `config.json` and `rules.md` stay under `docs/pipeline/`. The rules above hold for these files:

| File | Written by | Committed |
| --- | --- | --- |
| `docs/pipeline/config.json`, `docs/pipeline/rules.md` | you or the user, by hand | yes, on `mainBranch` |
| The issue's spec comment and labels | the tool (`add`, `spec`, `question`, `update`, `park`, `unpark`, `begin`, `close`) | on GitHub |
| The issue's title, body and `Needs:` line | the tool: `update` with `set: { title?, body?, needs? }`; a new body keeps the dependencies unless `needs` is given, `needs: []` removes them | on GitHub |
| `.git/pipeline/issues.json`, `items.json`, `facts.md`, `<id>/ledger.json` | the tool only | never |
| `<worktree>/.pipeline/<id>/spec.md` | the tool, at `begin` and `spec` | never |
| `<worktree>/.pipeline/<id>/plan.md` | you | never |
| `<worktree>/.pipeline/<id>/` briefs; reports | the tool; the subagents | never |

`.pipeline/` is ignored through `.git/info/exclude`, so `git status` shows none of it. Never write under `.git/pipeline/` and never change an issue with `gh` yourself: the tool's actions do both. There is no `move` in this mode. An item is `ready` once its issue has a spec comment, no open question, and no open issue named on a `Needs: #12` line of its body.
