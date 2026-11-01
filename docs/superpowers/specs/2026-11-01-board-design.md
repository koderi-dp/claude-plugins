# board: a task, agents and sessions view, and a project board, for Claude Code

Status: approved in conversation 2026-11-02. First draft 2026-11-01.

## 1. Purpose

Two things are hard to see today when a project is built with superpowers plans and subagents:

- **Now.** What the session's subagents are doing, and what the other sessions the user opened on the same project are doing. The desktop app's Background tasks pane lists every shell command a subagent ran, truncated, 43 rows for one implementer. It does not say what the agent is doing in words, how far it is, or which model it runs on, and it knows nothing of sibling sessions in worktrees.
- **Where we are.** Across sessions and machines, what is done, what is in progress, what is blocked and what comes next. Superpowers writes plans (instructions, with step checkboxes nobody ticks) and each project invents its own ledger: catalo keeps a free-form `.superpowers/sdd/progress.md`; openhuddle keeps an "MVP status" table and an "MVP queue" in `CLAUDE.md`, a slice history in `docs/SLICES.md`, and JSON files behind a hand-kept dashboard. None of it is machine-readable, so the user asks Claude "where are we" every time.

`board` is one plugin with two layers that answer both, in a panel beside the prompt and as text for the phone. It records; superpowers stays in charge of the flow.

Who it is for: the user running MVPs with superpowers across several sessions and two machines. Success: opening a session in catalo or openhuddle shows, without asking, every milestone with its state and the one that needs attention; one click opens a milestone's tasks; while agents and sibling sessions run, the panel says in one line each what every one is doing. In a project without a board the panel is only the Now view and never asks for one.

### Non-goals

- No tiers, workers, cost estimates, cache countdowns or session row: superpowers-flow has those.
- No third level (goal rows above milestones). openhuddle's MVP rows map onto a milestone's `closes` list and the project goal line.
- No parsing of ledgers or `CLAUDE.md` tables by the mod. Claude reads those once at init; the mod reads only `board.json`.
- No editing of the board by hand. Claude maintains it through the tool; the file is readable in a diff but not meant to be edited.
- No view of sessions on another machine until they commit the board, and no view of a session's sidebar title: the mod has no app API.

## 2. Key decisions

- One plugin, `plugins/board/`, a mod plus a skill. Both layers draw in one panel, so splitting them would double the UI code.
- The project layer is a JSON file in the repo, `docs/superpowers/board.json`, next to the plans and specs it points at. JSON because only Claude writes it. Git carries it to the other machine.
- One board per project, in the main checkout. A session in a worktree writes the main checkout's copy, found through the git common directory, so parallel worktree sessions never carry three diverging copies into a merge.
- Two levels: milestones (a plan, a slice, a phase) and items (its tasks). A milestone carries what the queue text already says about it (what it needs, its size, which spec rows it closes), so the overview shows dependency order without a third level.
- The home view is the overview of every milestone; a milestone opens in place. The active milestone's detail is one click away, not the home.
- Live state that does not belong in git (which session works on what, with which agents) goes in a shared file in the git common directory. Sessions see each other through it; no server, no app API.
- The mod never guesses status. The skill records at task boundaries; the init reconstructs once from what the project has and marks the unsure items backlog with a note.
- Built on the same function-hooks API as superpowers-flow (an early-access API that may change), with `$.fs.read`, `$.fs.write`, `$.fs.stat` and `$.fs.ancestors`. Agent tracking is cribbed from superpowers-flow's `agent.spawn`, `turn.step` and `turn.complete` handlers.

## 3. The board file

`docs/superpowers/board.json` in the main checkout, created by the tool, pretty-printed with two spaces and a trailing newline so diffs stay small.

```json
{
  "version": 1,
  "goal": { "title": "MVP rows on main", "done": 21, "total": 36 },
  "milestones": [
    {
      "id": "q8",
      "title": "Thread following and threads view",
      "status": "active",
      "ref": "docs/superpowers/plans/2026-11-02-q8-threads.md",
      "branch": "feat/q8-threads",
      "needs": ["q7"],
      "size": "M",
      "closes": ["18 Thread following (SPEC §3.4)", "34 Threads view (SPEC §3.4)"],
      "items": [
        {
          "id": "t2",
          "title": "Threads I follow view",
          "status": "in_progress",
          "note": "sp-medium in worktree q8, port 3002, round 1",
          "ref": "#task-2-threads-i-follow-view",
          "updatedAt": "2026-11-02T10:12:00Z"
        }
      ]
    }
  ]
}
```

- `goal` (optional): one line for the top bar of the overview. For openhuddle the MVP rows done out of all; for catalo it is omitted and the bar counts items. Claude updates `done` when a milestone's `closes` rows are finished.
- `milestones[].status`: `planned`, `active` or `done`. Array order is the project's order, dependency order for a queue.
- `milestones[].branch`, `needs`, `size`, `closes` (all optional): the branch it builds on, the ids it waits for, `S`, `M` or `L`, and the spec rows or goals it finishes, as short strings. Written by Claude at import or init from the plan and the queue text.
- `items[].status`: `backlog`, `next`, `in_progress`, `blocked` or `done`. Array order is the plan's order.
- `ref`: a repo-relative path, optionally with a `#heading` anchor, or a PR URL. Shown as a link in the desktop app, as text in the terminal.
- `note`: one line. Where the status came from, or what blocks the item. Kept short on purpose; the ledger stays the long form.
- `updatedAt`: ISO time of the last status change, set by the tool.
- `id`: short and stable. `import` gives items `tN` from the task number; Claude picks milestone ids (`phase1`, `q8`). Upserts match on it.

Unknown fields are kept on read and written back, so a later version can add fields without breaking an older plugin.

**Finding the file.** The mod resolves the project root once per session: the git common directory through `$.fs.ancestors` on `.git` (a file with `gitdir:` in a worktree points at `<main>/.git/worktrees/<name>`, whose parent's parent is the main checkout), else the working directory. The board path is `<main checkout>/docs/superpowers/board.json`. A worktree session reads and writes that file, not its own branch's copy, and the skill never commits it from a worktree.

## 4. The live file

`<git common dir>/board-live.json` (`.git/board-live.json` in the main checkout), never committed, one entry per live session:

```json
{
  "sessions": {
    "6f1c…": {
      "title": "Implement Q8 threads",
      "cwd": "C:/source/projects/openhuddle-wt/q8",
      "branch": "feat/q8-threads",
      "item": "q8/t2",
      "startedAt": "2026-11-02T09:58:00Z",
      "seenAt": "2026-11-02T10:12:40Z",
      "agents": [
        { "name": "Implement Task 2: threads I follow view", "model": "opus", "startedAt": "2026-11-02T10:00:10Z", "activity": "editing web/src/threads/following.tsx" }
      ]
    }
  }
}
```

- Each mod writes only its own entry: at session start, on every `turn.complete`, when an agent starts or ends, when its activity line changes (throttled to once per 2 seconds), and when the board tool marks an item in_progress from that session (that sets `item`). `title` is the session's first user message cut to 60 characters, or the branch when there is none yet.
- Each mod reads the whole file when it redraws and at most every 5 seconds while the panel is open. An entry with `seenAt` older than 3 minutes draws as quiet; older than 60 minutes it is dropped on the next write by any session. A session that ends removes its entry when the engine gives it the chance (`session.end` if the API has it; the staleness rule covers the rest).
- Writes are whole-file through a temp file and rename after a fresh read, so two sessions writing in the same second lose at most one heartbeat.
- Without a git directory the live file goes to `~/.claude/board/<hash of cwd>.json`, and sessions in the same folder still see each other.

## 5. The tool

One tool, `mcp__board__board`, registered by the mod and listed without loading. Input is `{ action, ... }`:

- `get`: answers the board as JSON, or `{ exists: false }`, plus the live sessions.
- `update`: `{ goal?, milestones?: [...] }` with the same shape as the file, partial. Milestones and items match by `id` and merge field by field; a new id is appended, or placed after an optional `after` id. A status change stamps `updatedAt`; an item set to `in_progress` also sets this session's `item` in the live file. `update` never deletes; `{ remove: ["t3"] }` removes ids.
- `import`: `{ plan: "docs/superpowers/plans/x.md", milestone?: { id, title, needs, size, closes, branch } }`. Reads the plan, takes every `### Task N: title` heading as an item with id `tN`, status `backlog`, `ref` the file plus the heading anchor; adds or refreshes the milestone (title from the plan's `# ` heading unless given; status `planned`, or `active` when it is the only milestone). Existing items keep their status and note; only titles and refs refresh.

Every write re-reads the file first, merges, and writes through a temp file and rename. A file that fails to parse is never overwritten: the tool answers the parse error and the line, and the skill tells the user. The tool answers the resulting board as text (the same renderer as `/board status`) so Claude sees what it wrote.

Only the main session's calls count: a call that carries an `agentId` is answered "ignored: subagents do not write the board", so a worker cannot mark its own task done.

## 6. The skill

`skills/board/SKILL.md`, picked up whenever a superpowers plan is written or run, when a session starts in a project that has plans or a board, and when the user asks where the project stands or what is next. Rules, all through the tool:

1. **Session start.** If the board exists, `get` it and open with one line: the milestone that needs attention, done out of total, what is in progress, what is blocked, what is next. If it does not exist but `docs/superpowers/plans/` has files, run the init (rule 6) before anything else and report the same line. Neither: say nothing and never propose a board; `/board init` is there if the user wants one.
2. **After writing-plans** writes a plan: `import` it, with `needs`, `size` and `closes` when the queue or spec names them. The milestone turns `active` when the user starts executing it.
3. **At each dispatch** of an implementer: that item `in_progress`, note the worker and branch or worktree. The following item in plan order becomes `next` if it is `backlog`.
4. **When a review accepts** a task: `done`, note the commit range. A fix round keeps `in_progress` with a note counting the round.
5. **When a worker stops early** (DONE_WITH_CONCERNS the reviewer cannot clear, BLOCKED, an interrupted run, a review that requested changes nobody is fixing yet): `blocked` with a one-line reason. The user's "stop new work" turns the remaining `next` items back to `backlog`.
6. **Init** (`/board init`, or rule 1): read, in order, the plans (skeleton via `import`), any ledger the plans or `CLAUDE.md` name (`.superpowers/sdd/progress.md` and the like), `CLAUDE.md` sections that track status or a queue (openhuddle's "MVP status" table gives `goal` and the `closes` lists; its "MVP queue" entries become `planned` milestones with `needs` and `size` from the text and one `backlog` item each until a plan exists; the done rows become one `done` milestone "On main"), then `git log` and branches as a cross-check. Where the sources disagree or say nothing the item is `backlog` with a note naming what was read. Then answer with the `/board status` text and one sentence asking for corrections. Init runs once; a later `/board init` refreshes titles, refs and queue fields and only changes a status it can prove from git.
7. **Milestone done** when every item is done or the user says the branch is finished; `goal.done` moves by its `closes` rows; the next `planned` milestone becomes `active` when its plan is run.
8. **Answering "where are we"**: from the board, as the status text, never from memory.
9. **In a worktree session**: the board is the main checkout's; do not commit it from the worktree, and say so in the handoff note if the user asks to commit everything.

The skill adds no instruction to subagent briefs and changes nothing in superpowers' templates.

## 7. The views

One panel, pane id `board`. `/board` toggles it, `/board open` brings it forward. It opens by itself the first time a session starts in a project with a board, and when a subagent starts (setting `autoOpen`: `always`, the default, or `never`). With no board, no agents and no task list it stays closed.

**Home: the overview.**

- Top line: project name, `goal.done / goal.total` when a goal exists, else items done out of all; a thin bar.
- Milestones grouped active, planned, done, in array order. One row each: mark, title, `done/total`, and on the right what the queue says (`needs Q7 · M`). An active milestone adds a second line with one chip for what needs attention, in this order: `n blocked` with the first reason, else `n in progress` with the item, the agent's model and its elapsed time, else `next: <item>`. Planned rows after the first 4 fold to "and N more planned"; done milestones fold to one line with their count and the latest title. A project with one milestone shows its row and the fold lines never appear.
- Now, as one line with counts (`1 agent · 2 tasks · 2 sessions`), opening the Now view.

**A milestone, opened** by clicking its row or `/board show <id>`; `‹ Board` or `/board` goes back:

- Header: title, `done/total`, bar, then plan path and branch as one dim line.
- Items grouped in_progress, blocked, next, done, each: status mark, title, note in dimmer text, elapsed since `updatedAt` for in_progress and blocked, commit range for done. The session that holds an in_progress item (from the live file) is named on its line.
- `Rows this milestone closes`: its `closes` strings, when any.
- Now filtered to the agents and sessions working on this milestone.

**Now** (the whole of the panel when no board exists):

- Tasks: the session's native task list, read from `TaskCreate` and `TaskUpdate` tool calls of the main session: one line per task with its status mark and subject, in_progress first. Hidden when empty.
- Agents, running first: name (the Agent call's `description`), model, elapsed, and **what it is doing now** in words, derived from its latest `tool.call` (the events carry `agentId`): `editing src/catalog/grid.tsx`, `running npm run check:fast`, `reading progress.md`, `searching "import_run"`, `waiting on a browser page`. A long command keeps its first word and the script name. Finished agents: one line with name, duration, tool-call count and done or failed. The latest 8 finished draw; a count stands for the rest. No per-command history: that is what the Background tasks pane already does badly.
- Sessions: every other live session on this project, from the live file: title, branch, the item it is on, how many agents run and the latest one's activity line, and quiet after 3 minutes without a heartbeat. This session is not listed; its agents are above.
- Step reports through superpowers-flow's `step` tool are not read here; this plugin has no step tool.

**Text.** `/board status` prints the overview and Now as text in the conversation, so the phone and an SSH session see the same. `/board status all` prints every milestone with every item, done included; `/board status <id>` one milestone in full. `/board find <text>` lists the items whose title or note matches, each with its milestone.

Language: English only. Colours follow superpowers-flow's palette so the two panels match when both are installed; superpowers-flow is not required.

## 8. Error handling

- A hook never throws into the engine: every handler wraps its work and leaves state as it was on failure, as shipright's does.
- `import` on a plan without `### Task` headings answers an error and writes nothing.
- A `ref` that does not exist is kept and drawn without a link.
- Two sessions writing the board in the same second: the last writer wins per field; the re-read before each write keeps losses to the fields changed in that second. Noted in the README; not solved.
- A live file that fails to parse is replaced by this session's entry alone; the others rewrite theirs on their next heartbeat.
- A worktree whose main checkout cannot be resolved (bare repository, `.git` file without `gitdir`) falls back to its own `docs/superpowers/board.json` and the panel says so in one dim line.
- The engine may rename hook events between releases: the README names the version the plugin was tested on, as superpowers-flow's does.

## 9. Layout and testing

```
plugins/board/
  .claude-plugin/plugin.json      name, version 0.1.0, types, userConfig: autoOpen
  README.md
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/register.tsx              hooks, panel views, tool, commands
  hooks/board.ts                  pure: parse, merge, import, text renderer, activity line, overview grouping
  hooks/live.ts                   pure: live entry merge, staleness, project root from a .git file or dir
  hooks/board.test.ts             merge rules, import against a copy of catalo's plan headings, text renderer, activity line from sample tool calls, overview chips
  hooks/live.test.ts              root resolution for a main checkout and a worktree, staleness, same-second writes
  hooks/register.test.tsx         smoke: the mod registers, the pane renders overview, milestone and Now with and without a board
  skills/board/SKILL.md
  types/index.d.ts                Board, Goal, Milestone, Item, Live, LiveSession, AgentRun, NativeTask, Panel state
```

Tests run with `claude plugin test plugins/board`. The marketplace listing and the root README table gain a row. No Rust, no build step.
