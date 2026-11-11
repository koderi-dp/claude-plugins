# pipeline

Owns a project's workflow: a structured backlog in `docs/pipeline`, skills that take a request to a merged PR, a watchdog over subagents, and a status block as text and as a panel. The project keeps a small config file and its code conventions; the plugin keeps the backlog, drives an item from request to merged PR with no approval gates, watches the workers, and shows where things stand. It is for the person who wants to say what to build and read a status line, not operate the process.

## The files in a project

```
docs/pipeline/
  config.json          the rules the plugin enforces (table below)
  rules.md             process rules the config cannot express, grouped by when they apply
  backlog.json         the items and their status; array order is priority
  BACKLOG.md           generated view of backlog.json, never edited
  specs/<id>.md        one page per item: what, why, acceptance, out of scope, open
  plans/<id>.md        the plan for the item, in the format the run skill gives
  ledgers/<id>.json    the item's record: tasks, dispatches, rulings, resume block
  ledgers/<id>/        briefs and reports, for the record: task-N-brief.md and task-N-report.md,
                       task-N-fix-R-brief.md and -report.md, task-N-review-brief.md and -report.md
                       (a re-review: task-N-review-R-), final-brief.md and final-report.md
```

Only the plugin's tool writes `backlog.json` and the ledgers; a subagent's call is ignored. Everything under `docs/pipeline/` goes on the item's branch except `backlog.json` and `BACKLOG.md`, which the lead commits on the main branch, so two worktrees never carry diverging copies.

Under `merge: pr` you merge the PR yourself. The next `get` or `signals` sees the branch tip on `origin/<mainBranch>` and reports the item as `mergedPending`; the run skill then runs its Close first: the item becomes `merged`, the clean-up runs, the tool's files are committed on the main branch and pushed, and the worktree and local branch go. A session that starts with such an item says so in a toast and in the status block.

## The loop

A request becomes an `inbox` item with a spec (`/pipeline add`, or any wording that asks for something to be built). It is `ready` once the spec has no open question and its `needs` are merged. `/pipeline next` picks the first ready item (an item that has only a note gets its spec written from it on pick, and stops only for an open question or an unmerged need): a worktree and branch, a plan in the plugin's own format that the tool checks (`plan`), then task by task an implementer from a brief the tool renders (`brief`), the lead's own run of the task's check, fix rounds up to the limit, an independent reviewer per `taskReview` (by default only when the diff touches a risky path), a final review over the whole branch, the gate, the PR, the merge, the ledger, the clean-up, and one line to you. Statuses: `inbox`, `ready`, `planning`, `building`, `review`, `merged`, `blocked`, `parked`.

## Commands

| Command | Does |
| --- | --- |
| `/pipeline init` | Config and an empty backlog for a new project; offers `migrate` when the project has a queue |
| `/pipeline migrate` | Move an existing project onto the pipeline (below) |
| `/pipeline add <text>` | Intake: an item and its spec, in one line back; never starts the build |
| `/pipeline next` | Run the first ready item (under `runner: session`, start its child session) |
| `/pipeline run <id>` / `run all` | Run one item, or until nothing is ready or a stop condition fires |
| `/pipeline status [id]` | The status block, or one item's ledger as text; works on a phone over Remote Control |
| `/pipeline move <id> top` / `after <id>` | Reorder |
| `/pipeline park <id>` / `unpark <id>` | Take out of, back into, the queue |
| `/pipeline stop [id]` | Finish the running task, leave the branch pushed and the ledger current, stop; with an id, kill that item's child session and block the item |
| `/pipeline log <id>` | The last 60 lines of an item's child session log |
| `/pipeline clean` | List and remove what `retain` says may go for every merged item, with its worktree and local branch |
| `/pipeline panel` | Toggle the panel |
| `/pipeline config [key=value]` | Show or change the project config |

## The config

`docs/pipeline/config.json`, written by `/pipeline init` or `/pipeline migrate` and edited by you or the lead when a rule changes. Every key has a default; a wrong type is named and the default used; unknown keys survive.

| Key | Default | Means |
| --- | --- | --- |
| `mainBranch` | `main` | Where items branch from and merge to |
| `branch` | `feat/<id>` | The branch name per item |
| `checks` | `{}` | `fast` per edit, `task` before each hand-back, `gate` before the PR; any tier may be omitted |
| `riskyPaths` | `[]` | Globs; a task whose diff touches one gets an independent reviewer who probes |
| `taskReview` | `risky` | Per-task review: `risky` gives a task an independent reviewer only when its diff touches `riskyPaths`; `always` gives every task one; `off` gives none, the lead's own reading of the diff is the review. The final review runs whatever the setting. `/pipeline config taskReview=off` |
| `protectedPaths` | `[".github/workflows/**"]` | Globs; a subagent's Edit or Write there is denied by the mod |
| `models` | sonnet medium, opus high, opus xhigh, opus high | `implementer`, `reviewer`, `final`, `escalate`, each `{ model, effort }` |
| `limits` | `fixRounds` 3, `silentMinutes` 10, `taskMinutes` 45, `itemTokens` 4000000, `parallel` 1 | What the watchdog and the run skill enforce; `parallel` is how many child sessions `run all` keeps going under `runner: session` |
| `runner` | `subagent` | `subagent` runs an item in your session with subagents; `session` runs each item in a headless child session of its own (below) |
| `merge` | `pr` | `auto` merges on green CI with no open Critical or Important finding; `pr` stops at an open PR |
| `mergeMethod` | `merge` | `merge` (a merge commit) or `squash` |
| `stop` | six conditions | Free text the run skill reads: when it blocks the item and asks instead of deciding |
| `afterMerge` | `["docs/pipeline/BACKLOG.md"]` | Paths to regenerate, commands to run or skills to invoke after a merge |
| `pushMain` | `true` | Whether `close` pushes the commit of `docs/pipeline/` to `mainBranch`; `false` leaves it local for you to push |
| `superpowers` | `off` | `off`: the lead and every brief use the pipeline's own process and invoke no superpowers skill, even when the plugin is installed; `on`: testing and debugging skills may be used inside a step |
| `retain` | `plans` true, `briefs` false, `superpowers` false | What stays after an item merges; the spec and the ledger always stay |
| `notify` | `milestones` | `off`, `milestones` (started, PR open, merged, blocked, a watchdog signal) or `all` |
| `renameSession` | `true` | Name the session after the item it runs (`p12 · CSV export`) when an update starts it, and a child session from its start; `false` leaves the names alone |

## Runners

`runner: subagent` (the default) runs the item in the session you are in: the lead you talk to dispatches the subagents, and you can answer a question it has along the way. `runner: session` runs each item in a headless child session of its own: `/pipeline next` (or `run <id>`) makes the item's worktree, marks the item building with the note `session runner` and starts `claude -p` in that worktree with the installed plugins and your session's permission mode; the child is a normal session of the project, plans, builds, reviews and opens the PR, writes the ledger and heartbeats into the live file, and your panel shows it with its task counter, Stop and Log. The trade-off: a child cannot ask you anything (anything that would prompt is denied), so it runs only while your session is in `acceptEdits`, `auto`, `dontAsk` or `bypassPermissions` mode (`start` refuses otherwise and names the modes; Shift+Tab switches), and a stop condition ends the child with the item blocked and the reason in its note, as in-session. The gain: `run all` keeps up to `limits.parallel` items going at once, each in its own worktree, and starts the next ready one when a child finishes. Stop kills the child and blocks the item with `stopped by the user`; a child that exits non-zero blocks it with the exit code and the log tail; `/pipeline run <id>` starts it again from the ledger in the same worktree. A child does not outlive the parent session: when the parent ends or restarts (a reload of the plugin included), its children end with it, each item is blocked with `the parent session restarted` and a dead signal names it; resume each with `/pipeline run <id>`. The log is `.git/pipeline/<id>.log`, never committed.

Other sessions on the same repository (a second terminal, a desktop window, a child) write the same live file, and the panel lists them under Other sessions with their item and running agents; one that has not heartbeat for three minutes shows dim, and its entry goes once the watchdog has reported its agents dead.

## Several sessions, one backlog

Only the tool writes `backlog.json`, `BACKLOG.md`, `facts.md` and the ledgers. An edit of one of them, or a shell command that writes one, is refused for the lead and for subagents alike and pointed at the action that does it; reading them and `git` on them pass. Every writing action takes a lock shared by all sessions on the repository (a folder under `.git` only one session can create), re-reads the file, changes it and releases the lock, so two sessions never overwrite each other and two sessions asking for the next item get two different items. A session waits up to thirty seconds for another's lock, then takes it over. Specs, plans, `rules.md` and `config.json` stay ordinary files.

## The watchdog

The mod follows every subagent of the session and keeps a live file (`.git/pipeline-live.json`, never committed). It cannot stop an agent itself: a signal reaches the lead through the tool's `signals` (or `get`) on its next turn, and as a push notification per `notify`. Between items under `run all` it schedules a wake-up every `silentMinutes` where the host offers one.

| Signal | Detection | Action |
| --- | --- | --- |
| Silent | no step from the agent for `limits.silentMinutes`; or no heartbeat from a child session for three minutes while its process runs | once: the lead asks the agent to report, then stops and re-dispatches it; for a child, `/pipeline log <id>`, then Stop and `run <id>` |
| Dead | the session restarted while the live file lists running agents; or a child session's process exited with its item still building | the lead re-dispatches from the surviving working tree; `/pipeline run <id>` resumes a child's item |
| Looping | the same failing shell command three times in a row, or more failed commands than `fixRounds` | the lead stops the agent and re-dispatches once at `models.escalate` with the failures in the brief |
| Over budget | the task passes `limits.taskMinutes` or the item passes `limits.itemTokens` | the lead finishes the running task, then blocks the item |

## Token use

Every tool answer stays in the lead's conversation and is read again on every later call, so a large answer costs its size again at each step. The tool answers lean:

| Action | Answers |
| --- | --- |
| `get` | Compact JSON: the active item (id, title, status, note, spec, plan, branch, worktree), its resume block, the open signals, the children, the count per status, the next three items and the config keys a run reads; about 1.8k characters on a 71-item backlog. `get { id }` adds one item in full, `get { titles: true }` every title (the intake's duplicate check), `get { full: true }` the whole config, backlog and readiness (about 80k characters on the same backlog, never needed during a run) |
| `signals` | Only the open watchdog signals, or `no signals`; the wake-up's check |
| `add`, `update`, `move`, `park`, `unpark`, `remove` | One line: `added p29 · inbox · no spec`, `p12 · building`, `removed p2 · 70 items left` |
| `ledger` | One line: `ledger p12 · task 3/6 running · 2 rulings · 674k tokens` |
| `begin` | One line: the status, the branch, the base and the worktree to enter; refused when another live session runs the item |
| `plan` | One line: `p12 · building · 5 tasks · plan committed · next: brief task 1`, or the problems of the plan |
| `brief` | One line with the Agent call: `p12 · task 2/5 · Agent subagent_type pipeline:implementer model sonnet effort medium · prompt: Read docs/pipeline/ledgers/p12/task-2-brief.md and follow it.` |
| `accept` | One line: `p12 · task 2 accepted · 2/5 · a1b2c3d..c0de111 · pushed · next: brief task 3` |
| `gate` | One line: `p12 · gate green · final approved · pushed · next: open the PR`, or the red gate's last lines |
| `close` | One line: `p12 merged · PR #31 · 6 tasks · records committed on main · pushed · next: p13` |

`plan` and `accept` end their line with the next Agent call, so the lead never asks for a brief in a normal run. `gate` runs to the end however long the gate takes. A subagent that runs the same failing command a fourth time is told so directly and the command is not run. `docs/pipeline/facts.md` keeps up to twelve one-line facts runs learned about working in the repository (a command's working spelling, a step that must come first); every implementer brief carries them, and an implementer reports a new one in its closing line.
| `status`, `status { id }` | The full status block, or one item's whole ledger: the explicit way to read them |

The lead's turns are most of an item's cost, because every turn re-reads the conversation; in a measured run the lead was 95% of it. So the tool does the clerical work of a run in single calls: it makes the worktree and claims the item (`begin`), checks the plan, seeds the ledger's tasks and commits the plan, renders every brief from the plan task, the config, `rules.md` and the spec, opens the dispatch in the ledger, and decides from the diff whether a task needs an independent review. It commits the records and pushes at each accept, and runs `checks.gate` itself (`gate`), so a gate is never green by assumption. The lead writes no brief, no task list, no record commit. Subagents run as the plugin's own agent types, `pipeline:implementer` and `pipeline:reviewer`, which carry only the tools they need. The ledger records the lead's own tokens as `lead`, and an agent's count in the panel is fresh tokens, not what is re-read from the cache. A subagent answers one line (`DONE <hash> · 14/14 tests`, `FIX REQUIRED · 1 critical`) and writes its report to a file the lead opens only when it needs the findings. The lead runs each task's check itself before it accepts.

The run skill calls `get` once per item and after a restart, `signals` for watchdog checks and `status` only when you ask; it passes briefs and reports to subagents by path and reads a result with `git diff --stat` first. With `runner: session` each item runs in a fresh child context, so one item's history never weighs on the next. The lead runs on the session's model while the subagents use `models`: starting the lead session on Opus or Sonnet keeps a Fable budget for the final reviews.

## The skills

- `pipeline-intake`: a request in any wording becomes an item and a spec; at most one question, never a build.
- `pipeline-run`: one item from pick to merge, with the plan format, briefs rendered by the tool, the ledger and one line per turn; resumes from the ledger's `resume` block after a restart.
- `pipeline-init`: sets a new project up: config fitted to its scripts and layout, an empty backlog, a rules.md; hands over to migrate when a queue exists. Also reachable as the `/pipeline-init` skill when the `/pipeline` command is not listed.
- `pipeline-rules`: loaded in every session of a project with a pipeline; where the files are, who writes them, the reply shape.
- `pipeline-migrate`: moves a project that runs its own process onto the pipeline in one session.

## The panel and the progress bar

In the desktop app a panel shows the status block live: the active item with its task counter, the running agents with what each is doing in words and its minutes, open signals, the queue, blocked and inbox items, and what merged. Idle, it says so in one line (`idle · 28 inbox · next: p1 Grid row and column sizes`) and keeps the queue short: five rows each of Ready, Inbox and Merged this week with `and N more · /pipeline status` for the rest and a Show more button, the readiness reason on the first inbox item only, `Parked: 10` as a count, and a merged item's PR as its number, linked. A title migrated from a project's old queue (`grid-track-sizes — Grid row and column sizes`) is shown without its slug; the file and `/pipeline status <id>` keep it whole. The text block shows eight rows a section, every reason and the parked ids. It opens the first time a session starts in a project with a pipeline and when a subagent starts (`autoOpen` setting; `never` leaves it to `/pipeline panel`). While an item is building, a bar above the prompt counts accepted tasks over the total, with the running agent and its minutes. In a terminal the bar is text and `/pipeline status` is the panel; nothing is only in the panel.

Look. The panel and the bar above the prompt are drawn from one kit. `hooks/ui/tokens.ts` holds every colour, radius, spacing step and type size, each colour with a light and a dark value: neutral surfaces, borders and greys, purple for what runs, green, amber and red for states. No drawing paints a background: every surface, border and bar track is a faint overlay (white on dark, black on light), so the drawings sit on whatever grey the app gives the panel. `hooks/ui/kit.ts` holds the drawn parts: text, surface, badge, dot, separator, progress bar, segmented bar and a few icons. Every drawing in `hooks/draw.ts` is composed from those parts and names no colour of its own, so a card, a badge or a row looks the same wherever it appears. `preview/` renders a sheet of every part and every drawing in each tone and state, in both colour schemes; a new section is checked against that sheet.

## Migration

`/pipeline migrate` reads the project's `CLAUDE.md` files, `docs/backlog.md`, `docs/WORKFLOW.md`, `docs/SLICES.md`, the files `CLAUDE.md` links as a queue or ledger, the superpowers specs and plans, every `.superpowers/sdd/**/progress.md` and the top-level `progress-archive.md`, the project skills, the Makefile, the package scripts, the CI workflows and the branches, and drafts the config with the source of every key, the `rules.md` lines by group, one item per queue entry (`merged` when the queue proves it, `parked` for what it marks later, otherwise `inbox` marked unverified) and a `building` item per open `feat/*` branch with a ledger. It asks one question, for corrections, then writes the files, prepends a Historical line to the old queue and ledgers, and lists the bulk of merged increments under `.superpowers/sdd/` (briefs, reports, logs, screenshots) to remove with `git rm`; `retain.superpowers: true` keeps it. The lead then retires the workflow prose in `CLAUDE.md` to one paragraph and deletes skills that only restated dispatch rules. A second `migrate` refreshes titles, sources and links and changes no status.

## Install

Needs Claude Code v2.1.287 or later, for mods; `claude --version` shows yours and `claude update` updates it. Tested on v2.1.318. The mod API is early access: an engine release may rename an event, and this note names the version it was tested on. No other plugin is needed: the plan format, the briefs and the build loop are the plugin's own. `retain.superpowers` and the migration only concern files an earlier superpowers workflow left in a project.

At the prompt of a terminal session:

```
/plugin install pipeline --marketplace koderi-dp/claude-plugins
```

From a shell:

```bash
claude plugin install pipeline --marketplace koderi-dp/claude-plugins
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `koderi-dp/claude-plugins`, then Add plugin.

## Update

```bash
claude plugin marketplace update code101-plugins
claude plugin update pipeline@code101-plugins
```

Then start a new session (or run `/reload-plugins`). `claude plugin list` shows the installed version.

## Limits

- The mod API cannot delete files: `clean` and `migrate` list what may go, and the lead removes it with `git rm` and commits. Every write is a plain file write; the API has no rename.
- A blocked item is resumed with `/pipeline run <id>`: the lead reads the note and your answer, sets the status back and continues from the ledger.
- The branch is pushed at every accepted task, so a lost worktree costs at most the running task.
- The live file is per machine: agents on another machine are not watched from this one; the backlog travels with git.
- A `backlog.json`, config or ledger that does not parse is never overwritten: the tool refuses with the line, and the status block shows it.
- Under `runner: subagent`, one item at a time. Parallel items need `runner: session`, whose children cannot ask you anything and run only in a permission mode that does not prompt.
- A child session is started on this machine from the installed `claude`; the parent sees its live entry and its log, not its conversation. The permission mode a child runs in is the one the engine last reported to the mod (on a prompt or a subagent spawn), else the settings' `permissions.defaultMode`.
- No GitHub issues or external tracker.

## What it contains

| Part | Name |
| --- | --- |
| Skills | `pipeline-init`, `pipeline-intake`, `pipeline-run`, `pipeline-rules`, `pipeline-migrate` |
| Templates | `templates/spec.md`; the four briefs (implementer, fix, review, final) are in `hooks/templates.ts` and rendered by the tool's `brief` action; a project file `docs/pipeline/templates/<kind>.md` replaces one |
| Tool | `mcp__pipeline__pipeline` |
| Mod | `hooks/register.tsx`: the tool, the commands, the watchdog, the session runner, the panel, the band, the live file; with `answers.ts`, `backlog.ts`, `config.ts`, `ledger.ts`, `status.ts`, `watch.ts`, `runner.ts`, `migrate.ts`, `clean.ts`, `merged.ts`, `live.ts`, `files.ts`, `pane.tsx`, `draw.ts` |
| Tests | `claude plugin test plugins/pipeline` |

License: MIT.
