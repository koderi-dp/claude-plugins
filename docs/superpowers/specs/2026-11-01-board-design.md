# board: a task and agents view, and a project board, for Claude Code

Status: draft for review. Date: 2026-11-01.

## 1. Purpose

Two things are hard to see today when a project is built with superpowers plans and subagents:

- **Now.** What the session's subagents are doing. The desktop app's Background tasks pane lists every shell command a subagent ran, truncated, 43 rows for one implementer. It does not say what the agent is doing in words, how far it is, or which model it runs on.
- **Where we are.** Across sessions and machines, what is done, what is in progress, what is blocked and what comes next. Superpowers writes plans (instructions, with step checkboxes nobody ticks) and each project invents its own ledger: catalo keeps a free-form `.superpowers/sdd/progress.md`; openhuddle keeps an "MVP status" table and an "MVP queue" in `CLAUDE.md`, a slice history in `docs/SLICES.md`, and JSON files behind a hand-kept dashboard. None of it is machine-readable, so the user asks Claude "where are we" every time.

`board` is one plugin with two layers that answer both, in a panel beside the prompt and as text for the phone. It records; superpowers stays in charge of the flow.

Who it is for: the user running MVPs with superpowers across several sessions and two machines. Success: opening a session in catalo or openhuddle shows, without asking, the active milestone with done out of total, what is in progress, what is blocked and what is next; and while agents run, the panel says in one line each what every agent is doing.

### Non-goals

- No tiers, workers, cost estimates, cache countdowns or session row: superpowers-flow has those.
- No third level (goal rows above milestones). openhuddle's MVP rows map onto milestones and notes.
- No parsing of ledgers or `CLAUDE.md` tables by the mod. Claude reads those once at init; the mod reads only `board.json`.
- No editing of the board by hand. Claude maintains it through the tool; the file is readable in a diff but not meant to be edited.

## 2. Key decisions

- One plugin, `plugins/board/`, a mod plus a skill. Both layers draw in one panel, so splitting them would double the UI code.
- The project layer is a JSON file in the repo, `docs/superpowers/board.json`, next to the plans and specs it points at. JSON because only Claude writes it. Git carries it to the other machine.
- Two levels: milestones (a plan, a slice, a phase) and items (its tasks). Enough for catalo (one phase, nine tasks) and openhuddle (queued slices Q8 to Q31) without mirroring a 36-row spec table.
- The mod never guesses status. The skill records at task boundaries; the init reconstructs once from what the project has and marks the unsure items backlog with a note.
- Built on the same function-hooks API as superpowers-flow (an early-access API that may change), with `$.fs.read` and `$.fs.write` for the file. Agent tracking is cribbed from superpowers-flow's `agent.spawn`, `turn.step` and `turn.complete` handlers.

## 3. The file

`docs/superpowers/board.json`, created by the tool, pretty-printed with two spaces and a trailing newline so diffs stay small.

```json
{
  "version": 1,
  "milestones": [
    {
      "id": "phase1",
      "title": "Phase 1 Foundation",
      "status": "active",
      "ref": "docs/superpowers/plans/2026-10-29-phase1-foundation.md",
      "items": [
        {
          "id": "t7",
          "title": "Articles and prices",
          "status": "blocked",
          "note": "WIP commit on task-7 after an interrupted fix round; checks not run",
          "ref": "#task-7-articles-and-prices",
          "updatedAt": "2026-11-01T10:12:00Z"
        }
      ]
    }
  ]
}
```

- `milestones[].status`: `planned`, `active` or `done`. Array order is the project's order; the first `active` milestone is the one the panel expands.
- `items[].status`: `backlog`, `next`, `in_progress`, `blocked` or `done`. Array order is the plan's order.
- `ref`: a repo-relative path, optionally with a `#heading` anchor, or a PR URL. Shown as a link in the desktop app, as text in the terminal.
- `note`: one line. Where the status came from, or what blocks the item. Kept short on purpose; the ledger stays the long form.
- `updatedAt`: ISO time of the last status change, set by the tool.
- `id`: short and stable. `import` gives items `tN` from the task number; Claude picks milestone ids (`phase1`, `q8`). Upserts match on it.

Unknown fields are kept on read and written back, so a later version can add fields without breaking an older plugin.

## 4. The tool

One tool, `mcp__board__board`, registered by the mod and listed without loading. Input is `{ action, ... }`:

- `get`: answers the board as JSON, or `{ exists: false }`.
- `update`: `{ milestones: [...] }` with the same shape as the file, partial. Milestones and items match by `id` and merge field by field; a new id is appended, or placed after an optional `after` id. A status change stamps `updatedAt`. `update` never deletes; `{ remove: ["t3"] }` removes ids.
- `import`: `{ plan: "docs/superpowers/plans/x.md", milestone?: { id, title } }`. Reads the plan, takes every `### Task N: title` heading as an item with id `tN`, status `backlog`, `ref` the file plus the heading anchor; adds or refreshes the milestone (title from the plan's `# ` heading unless given; status `planned`, or `active` when it is the only milestone). Existing items keep their status and note; only titles and refs refresh.

Every write re-reads the file first, merges, and writes through a temp file and rename. A file that fails to parse is never overwritten: the tool answers the parse error and the line, and the skill tells the user. The tool answers the resulting board as text (the same renderer as `/board status`) so Claude sees what it wrote.

Only the main session's calls count: a call that carries an `agentId` is answered "ignored: subagents do not write the board", so a worker cannot mark its own task done.

## 5. The skill

`skills/board/SKILL.md`, picked up whenever a superpowers plan is written or run, when a session starts in a project that has plans or a board, and when the user asks where the project stands or what is next. Rules, all through the tool:

1. **Session start.** If `docs/superpowers/board.json` exists, `get` it and open with one line: active milestone, done out of total, what is in progress, what is blocked, what is next. If it does not exist but `docs/superpowers/plans/` has files, run the init (rule 6) before anything else and report the same line. Nothing to read: say nothing.
2. **After writing-plans** writes a plan: `import` it. The milestone turns `active` when the user starts executing it.
3. **At each dispatch** of an implementer: that item `in_progress`, note the worker and branch or worktree. The following item in plan order becomes `next` if it is `backlog`.
4. **When a review accepts** a task: `done`, note the commit range. A fix round keeps `in_progress` with a note counting the round.
5. **When a worker stops early** (DONE_WITH_CONCERNS the reviewer cannot clear, BLOCKED, an interrupted run, a review that requested changes nobody is fixing yet): `blocked` with a one-line reason. The user's "stop new work" turns the remaining `next` items back to `backlog`.
6. **Init** (`/board init`, or rule 1): read, in order, the plans (skeleton via `import`), any ledger the plans or `CLAUDE.md` name (`.superpowers/sdd/progress.md` and the like), `CLAUDE.md` sections that track status or a queue (openhuddle's "MVP status" table becomes notes on a `done` milestone "MVP on main"; its "MVP queue" entries become `planned` milestones with one `backlog` item each until a plan exists), then `git log` and branches as a cross-check. Where the sources disagree or say nothing the item is `backlog` with a note naming what was read. Then answer with the `/board status` text and one sentence asking for corrections. Init runs once; a later `/board init` refreshes titles and refs and only changes a status it can prove from git.
7. **Milestone done** when every item is done or the user says the branch is finished; the next `planned` milestone becomes `active` when its plan is run.
8. **Answering "where are we"**: from the board, as the status text, never from memory.

The skill adds no instruction to subagent briefs and changes nothing in superpowers' templates.

## 6. The views

One panel, pane id `board`. `/board` toggles it, `/board open` brings it forward. It opens by itself the first time a session starts in a project with a board, and when a subagent starts (setting `autoOpen`: `always`, the default, or `never`).

**Board section** (top):

- The active milestone: title, `done/total`, a thin bar. Items grouped in this order: in_progress, blocked, next, then done folded to one line with its count (`/board done` unfolds). Each item: status mark, title, note in dimmer text, elapsed since `updatedAt` for in_progress and blocked.
- Other milestones below it, one line each: mark (planned, active, done), title, `done/total`. The next 3 planned draw; the rest fold to "and N more", unfolded by a click or `/board milestones`. A project with one plan sees no fold.
- Any milestone opens in place: click its line, or `/board show <id>`, and its items draw under it in the same groups as the active one, done included. Click again, or `/board show`, collapses it. The active milestone stays on top.
- `/board find <text>` lists the items whose title or note matches, each with its milestone, for a project with 25 queued slices.
- No file: "No board. /board init reads the plans and the ledger." Broken file: the parse error and the line.

**Now section** (bottom):

- The session's native task list, read from `TaskCreate` and `TaskUpdate` tool calls of the main session: one line per task with its status mark and subject, in_progress first. Hidden when empty.
- Subagents, running first: name (the Agent call's `description`), model, elapsed, and **what it is doing now** in words, derived from its latest `tool.call` (the events carry `agentId`): `editing src/catalog/grid.tsx`, `running npm run check:fast`, `reading progress.md`, `searching "import_run"`, `waiting on a browser page`. A long command keeps its first word and the script name. Finished agents: one line with name, duration, tool-call count and done or failed. The latest 8 finished draw; a count stands for the rest. No per-command history: that is what the Background tasks pane already does badly.
- Step reports through superpowers-flow's `step` tool are not read here; this plugin has no step tool. The activity line is enough.

`/board status` prints both sections as text in the conversation, so the phone and an SSH session see the same. `/board status all` prints every milestone with every item, done included; `/board status <id>` one milestone in full.

Language: English only. Colours follow superpowers-flow's palette so the two panels match when both are installed; superpowers-flow is not required.

## 7. Error handling

- A hook never throws into the engine: every handler wraps its work and leaves state as it was on failure, as shipright's does.
- `import` on a plan without `### Task` headings answers an error and writes nothing.
- A `ref` that does not exist is kept and drawn without a link.
- Two sessions writing the same board: the last writer wins per field; the re-read before each write keeps losses to fields changed in the same second. Noted in the README; not solved.
- The engine may rename hook events between releases: the README names the version the plugin was tested on, as superpowers-flow's does.

## 8. Layout and testing

```
plugins/board/
  .claude-plugin/plugin.json      name, version 0.1.0, types, userConfig: autoOpen
  README.md
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/register.tsx              hooks, panel, tool, commands
  hooks/board.ts                  pure: parse, merge, import, text renderer, activity line
  hooks/board.test.ts             merge rules, import against a copy of catalo's plan headings, text renderer, activity line from sample tool calls
  hooks/register.test.tsx         smoke: the mod registers, the pane renders with and without a board
  skills/board/SKILL.md
  types/index.d.ts                Board, Milestone, Item, AgentRun, NativeTask, Panel state
```

Tests run with `claude plugin test plugins/board`. The marketplace listing and the root README table gain a row. No Rust, no build step.
