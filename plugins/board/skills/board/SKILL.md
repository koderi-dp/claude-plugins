---
name: board
description: Use when a superpowers plan is written or executed (writing-plans, executing-plans, subagent-driven-development), when a session starts in a project that has docs/superpowers/plans/ or docs/superpowers/board.json, and when the user asks where the project stands, what is done, what is in progress or what is next. Keeps the project board in docs/superpowers/board.json current through the mcp__board__board tool.
---

# board

The board records; superpowers stays in charge of the flow. It is a JSON file, `docs/superpowers/board.json`, in the main checkout of the repository: milestones (a plan, a slice, a phase) and their items (the plan's tasks). The user never edits it by hand. You keep it current through one tool, `mcp__board__board`, and the panel and `/board status` draw from it.

Every change goes through the tool. Never write `board.json` with Edit or Write.

## The tool

- `{ "action": "get" }` answers the board as JSON (`exists: false` when there is none) and the other live sessions on this project.
- `{ "action": "update", "milestones": [...], "goal": {...}, "remove": [...] }` upserts by `id`. Fields you leave out keep their value; a new id is appended, or placed right after an `after` id. A status change stamps `updatedAt`. `goal` merges the same way (`{ "done": 22 }` keeps its title and total). `remove` drops a milestone by its id, or one item as `<milestone>/<item>` (`q8/t3`): every plan has a `t3`, so a bare item id removes nothing. It answers the board as text: read it to check what you wrote.
- `{ "action": "import", "plan": "docs/superpowers/plans/<file>.md", "milestone": { "id", "title", "needs", "size", "closes", "branch" } }` reads the plan's `### Task N:` headings into a milestone with items `t1`, `t2`, … Existing items keep their status and note; titles and refs refresh.

Item statuses: `backlog`, `next`, `in_progress`, `blocked`, `done`. Milestone statuses: `planned`, `active`, `done`. A `note` is one line: where the status came from, or what blocks the item.

Only the main session writes the board. A subagent's call is ignored, so never ask a worker to update it and never add board instructions to a subagent brief.

## Rules

1. **Session start.** If the board exists (`get`), open with one line: the milestone that needs attention, done out of total, what is in progress, what is blocked, what is next. If it does not exist but `docs/superpowers/plans/` has files, run the init (rule 6) before anything else and report the same line. Neither: say nothing about a board and never propose one; `/board init` is there if the user wants one.

2. **After writing-plans** writes a plan: `import` it, with `needs`, `size` and `closes` when the queue or the spec names them. Set the milestone `active` (an `update` with its id and `"status": "active"`) when the user starts executing it.

3. **At each dispatch** of an implementer: `update` that item to `in_progress`, with a note naming the worker and its branch or worktree. If the next item in plan order is `backlog`, set it to `next` in the same call.

4. **When a review accepts** a task: `done`, with the commit range as the note (`a3f91c2..b70de44`). A fix round keeps `in_progress`, with a note counting the round (`fix round 2`).

5. **When a worker stops early** (DONE_WITH_CONCERNS the reviewer cannot clear, BLOCKED, an interrupted run, a review that requested changes nobody is fixing yet): `blocked` with a one-line reason. When the user says to stop new work, turn the remaining `next` items back to `backlog`.

6. **Init** (`/board init`, or rule 1). Read, in this order:
   1. The plans in `docs/superpowers/plans/`: `import` each one for the skeleton.
   2. Any ledger the plans or `CLAUDE.md` name (`.superpowers/sdd/progress.md`, `.superpowers/sdd/*/progress.md` and the like): a `Task N: complete` line, or prose saying a task was accepted, makes that item `done` with the commit range as the note.
   3. `CLAUDE.md` sections that track status or a queue. An "MVP status" table gives `goal` (rows done out of all) and each milestone's `closes` list. An "MVP queue" gives one `planned` milestone per entry, with `needs` and `size` from its text and one `backlog` item each until a plan exists. The rows already done become one `done` milestone, "On main".
   4. `git log` and the branches, as a cross-check: a task whose commits are on the main branch is `done`; a branch with work for a task makes it `in_progress` or `blocked`.
   Where the sources disagree or say nothing, the item is `backlog` with a note naming what you read (`not in the ledger; plan only`). Never guess a status you cannot point at. Then answer with the `/board status` text and one sentence asking for corrections.
   Init runs once. A later `/board init` refreshes titles, refs and queue fields, and changes a status only when git proves it.

7. **Milestone done** when every item is done, or the user says the branch is finished. Move `goal.done` by the rows its `closes` list finishes. The next `planned` milestone becomes `active` when its plan is run.

8. **Where are we.** When the user asks what is done, where the project stands or what is next, answer from the board (`get`, or the text an `update` answered), as the status text. Never from memory.

9. **In a worktree session** the board is the main checkout's: the tool writes that file. Do not commit `board.json` from the worktree. If the user asks to commit everything, leave it out and say so in the handoff note.

## Commands the user has

`/board` toggles the panel; `/board open` brings it forward; `/board status`, `/board status all` and `/board status <id>` print the board as text; `/board show <id>` opens a milestone in the panel; `/board find <text>` lists matching items; `/board init` asks you to build the board (rule 6).
