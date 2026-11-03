# board

One panel for two questions that are hard to answer while a project is built with [superpowers](https://github.com/obra/superpowers) plans and subagents: **what is running now**, and **where the project stands**. Inspired by johnnyvizz's [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress), kept small.

- **Overview** (the panel's home when a project has a board): every milestone, grouped active, planned and done, with done out of total. An active milestone shows what needs attention: `1 blocked: WIP commit on task-7`, else what is in progress with the agent's model and time, else what is next. Planned milestones show what they wait for and their size (`needs q7 · M`); after four they fold to "and N more planned". A thin bar on top counts the project's goal, or its items.
- **A milestone**, one click away (or `/board show <id>`): its tasks grouped in progress, blocked, next, backlog and done, each with its note, the time since it changed, the commit range once done, and the other session working on it. Then the rows of the spec it closes.
- **Now**: this session's task list; its subagents, each with **what it is doing in words** (`editing grid.tsx`, `running npm run check:fast`, `searching "import_run"`, `waiting on a browser page`) instead of a list of truncated shell commands; and the other sessions open on the same project, in worktrees too, with the branch, the task they hold and their latest agent's activity. In a project without a board the panel is only this view, and never asks for a board.

`/board status` prints the same as text, for the phone over Remote Control and for SSH sessions.

## The board file

`docs/superpowers/board.json`, next to the plans and specs it points at: milestones (a plan, a slice, a phase) and their items (the plan's tasks), with a status, a one-line note and a link to the plan heading. Claude keeps it current through the plugin's skill at each task boundary: a plan written is imported, a dispatched task goes in progress, an accepted review marks it done with the commit range, a stopped worker marks it blocked. You do not edit it; it reads fine in a diff, and git carries it to your other machines.

A session in a worktree writes the **main checkout's** copy, never its own branch's, so parallel worktree sessions do not carry diverging boards into a merge. The skill never commits the board from a worktree.

In an existing project, the first session that finds plans and no board builds one: Claude reads the plans, any ledger (`.superpowers/sdd/progress.md` and the like), the status and queue sections of `CLAUDE.md`, and git, and marks anything it cannot prove as backlog with a note. It then shows the result and asks for corrections. `/board init` runs the same by hand, and on a project that already has a board it only refreshes titles, links and queue fields.

Which session is on what goes to `.git/board-live.json` (never committed), one entry per running session, refreshed every 30 seconds and when its agents change. An entry silent for 3 minutes draws as quiet; after an hour it is dropped. Outside a repository it goes to `~/.claude/board/`.

## The tool

One tool for Claude, `mcp__board__board`, in the main session only (a subagent's call is ignored, so a worker cannot mark its own task done):

- `get` reads the board and the live sessions.
- `update` adds or changes milestones and items by id; fields left out keep their value; `remove` drops a milestone, or one item as `q8/t3`.
- `import` reads a plan's `### Task N:` headings into a milestone.

A board file that does not parse is never overwritten: the tool refuses with the line, and the panel shows it.

## Commands

| Command | Does |
| --- | --- |
| `/board` | Show or hide the panel, on the overview |
| `/board open` | Bring the panel forward |
| `/board status` | The overview and Now as text |
| `/board status all` | Every milestone with every task |
| `/board status <id>` | One milestone in full |
| `/board show <id>` | Open a milestone in the panel |
| `/board find <text>` | Tasks whose title or note matches |
| `/board init` | Build the board from the plans, the ledger and git |

## Install

Needs Claude Code v2.1.287 or later, for mods; `claude --version` shows yours and `claude update` updates it. Tested on v2.1.310. The hook API is early access: an engine release may rename an event, and this note names the version it was tested on.

At the prompt of a terminal session:

```
/plugin install board --marketplace koderi-dp/claude-plugins
```

From a shell:

```bash
claude plugin install board --marketplace koderi-dp/claude-plugins
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `koderi-dp/claude-plugins`, then Add plugin.

Works beside superpowers-flow; the colours match. Neither needs the other.

## Settings

`autoOpen`: `always` (default) opens the panel the first time a session starts in a project with a board, and when the first subagent starts; `never` leaves it to `/board`.

## Limits

- Two sessions writing the board in the same second: the last write wins for the fields both changed. Each write re-reads the file first, so only those fields are at risk.
- Sessions on another machine show up once they commit the board; the live file is per machine.
- The panel cannot read a session's sidebar title: a session is named by its first prompt, or its branch.

## What it contains

| Part | Name |
| --- | --- |
| Skill | `board`, picked up when a superpowers plan is written or run, when a session starts in a project with plans or a board, and when you ask where the project stands |
| Tool | `mcp__board__board` |
| Mod | `hooks/register.tsx`, with `hooks/board.ts` (the board file, merge, import, text) and `hooks/live.ts` (the live file) |
