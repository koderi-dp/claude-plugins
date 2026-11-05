# pipeline: backlog to merged PR with one lead session

Status: draft from the brainstorm of 2026-11-05. Decisions below were taken in that conversation.

## 1. Purpose

catalo and openhuddle are built the same way: one lead session plans a slice, briefs a cheap implementer and a stronger reviewer, judges the results, runs the gate, merges, records a ledger, and asks the user only when blocked. Each project encodes that in its own prose (catalo: CLAUDE.md, a 629-line backlog.md, sdd ledgers, an `agent-dispatch` skill; openhuddle: CLAUDE.md with an MVP table and queue, a 440-line WORKFLOW.md, SLICES.md, ledgers). The costs showed up in both:

- Every session re-reads hundreds of lines of workflow prose before it can start.
- Status is prose and drifts: openhuddle's audit found 21 of 37 MVP rows partly done with leftovers lost in old item text; catalo keeps a "last reconciled" date on its queue.
- Nothing watches agents. Container restarts kill them silently while the clock runs; escalation rules (three fix rounds, then a stronger model) depend on the lead remembering them.
- A user request becomes work only when the lead edits the backlog file by hand.

`pipeline` is one plugin that owns the workflow for any project. The project keeps a small config file and its code conventions; the plugin keeps the backlog, drives an item from request to merged PR, watches the workers, and shows where things stand.

Who it is for: the user, running several apps with Claude Code on two machines, who wants to say what to build and read a status line, not operate the process.

### Non-goals

- Not built on `board` or `superpowers-flow`; neither is required and neither is reused. The plugin may draw in a panel of its own.
- No replacement of superpowers' engineering skills (TDD, writing-plans, subagent-driven-development, finishing a branch). The plugin calls them.
- No GitHub issues or external tracker in version 1.
- No parallel items in version 1 (the design leaves room: one worktree per item).

## 2. Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Gates | None. The runner stops only for the stop conditions in the config. | Both projects arrived there on their own. |
| Backlog and status | `docs/pipeline/backlog.json`, written only by the plugin's tool. A generated `docs/pipeline/BACKLOG.md` for humans. | Machine-readable, no drift, git carries it between machines. |
| Stuck worker | Stop it, re-dispatch once one tier up with the failure in the brief; then block the item, notify, continue with the next ready item. | Matches the escalation both projects wrote in prose, now enforced. |
| Workflow home | The plugin's skills own the loop, roles, briefs, escalation, ledger and resume. The project keeps `docs/pipeline/config.json` (about 30 lines). | One place to improve the process for every project. |
| Execution | The user's open session is the lead; each item runs in a git worktree in that session; subagents do the work. | Debuggable: you can talk to the lead. Parallel items can later be child sessions, one per worktree. |
| Reviews | Final whole-branch review always. An independent task review only when a task touches a risky path from the config. Other tasks are accepted on their tests and the lead's diff read. | openhuddle's data: probes on risky code found the real defects; reviews of mechanical diffs found style. |
| Ledger | One compact structured ledger per item, `docs/pipeline/ledgers/<id>.json`, written by the tool, rendered as text on demand. | Resume reads a record, not prose. |

## 3. Files in a project

```
docs/pipeline/
  config.json          the project's rules the plugin enforces (section 4)
  rules.md             project process rules the config cannot express, read by the run skill (section 4.1)
  backlog.json         items and their state (section 5)
  BACKLOG.md           generated view of backlog.json; never edited
  specs/<id>.md        one page per item: what, why, acceptance, out of scope
  plans/<id>.md        the superpowers plan for the item
  ledgers/<id>.json    the item's record (section 6)
  ledgers/<id>/        briefs and reports, written by the lead, not re-read on resume
```

Everything under `docs/pipeline/` is committed on the item's branch and merges with the code, except `backlog.json`, which the lead updates on the main branch (see 7.6) so two worktrees never carry diverging copies.

## 4. The config

`docs/pipeline/config.json`, written once by `/pipeline init` from what it finds (package manifests, Makefile, CI workflow, existing CLAUDE.md) and then edited by the user or the lead when a rule changes:

```json
{
  "version": 1,
  "mainBranch": "main",
  "branch": "feat/<id>",
  "checks": {
    "fast": "npm run check:fast",
    "task": "npm run test -w @catalo/web",
    "gate": "npm run build && npm run typecheck && npm run test && npm run lint"
  },
  "riskyPaths": ["apps/web/src/server/auth/**", "apps/web/migrations/**", "packages/domain/src/pricing/**"],
  "protectedPaths": [".github/workflows/**", "deploy/**"],
  "models": {
    "implementer": { "model": "sonnet", "effort": "medium" },
    "reviewer":    { "model": "opus",   "effort": "high" },
    "final":       { "model": "opus",   "effort": "xhigh" },
    "escalate":    { "model": "opus",   "effort": "high" }
  },
  "limits": { "fixRounds": 3, "silentMinutes": 10, "taskMinutes": 45, "itemTokens": 4000000 },
  "merge": "auto",
  "stop": ["product decision the spec leaves open", "security trade-off", "CI that cannot be made green", "credentials or external services", "new cost", "destructive data change"],
  "afterMerge": ["docs/pipeline/BACKLOG.md"],
  "notify": "milestones"
}
```

- `checks`: three tiers, as catalo verifies: per edit, per task, per item before the PR. Any tier may be omitted.
- `riskyPaths`: a task whose diff touches one gets an independent reviewer who probes (revert the fix and see the test fail, hostile inputs, race detector where it applies).
- `protectedPaths`: the mod denies a subagent's Edit or Write there (the `tool.call` hook). The lead may still edit them when the item's spec says so.
- `models`: tiers, not exact ids; `escalate` is where a stuck implementer goes.
- `limits`: what the watchdog enforces (section 8).
- `merge`: `auto` merges on green CI with no open Critical or Important finding; `pr` stops at an open PR.
- `stop`: the conditions on which the runner halts an item and asks. Free text: the skill reads it.
- `notify`: `off`, `milestones` (item started, PR open, merged, blocked), `all` (every task).

### 4.1 rules.md

`docs/pipeline/rules.md` holds the project's process rules that are not a config key: short, numbered, one line each, grouped by when they apply (`before dispatch`, `in every implementer brief`, `in every reviewer brief`, `before the PR`, `after merge`). Examples from the two projects: "only one agent uses a browser at a time, through playwright-cli"; "sign up only once per fresh dev server, reuse qa@catalo.test"; "integration tests skip silently without OH_TEST_DATABASE_URL, check they ran"; "after each merged increment bring up the review stack with the increment-review-stack skill". The run skill reads it at item start and pastes each group into the brief or step it names. It is written by the migration from the project's prose and edited by the user or the lead when a rule is learned; the run skill may append a rule after a defect taught one, and says so in its one-line reply. Kept under about 40 lines: a rule nobody needs is deleted, not kept.

## 5. The backlog

`docs/pipeline/backlog.json`:

```json
{
  "version": 1,
  "items": [
    {
      "id": "p12",
      "title": "CSV export of a catalog",
      "status": "ready",
      "size": "M",
      "needs": ["p9"],
      "source": "user, 2026-11-05: \"we need csv export of catalogs for the ERP people\"",
      "spec": "docs/pipeline/specs/p12.md",
      "plan": null,
      "branch": null,
      "pr": null,
      "ledger": null,
      "note": "",
      "updatedAt": "2026-11-05T09:00:00Z"
    }
  ]
}
```

Statuses, in order: `inbox` (written at intake, spec not yet confirmed to be complete), `ready` (spec exists, dependencies merged), `planning`, `building`, `review` (final review or PR open), `merged`, `blocked`, `parked` (the user said later). Array order is priority; `/pipeline add` appends, `/pipeline move <id> top|after <id>` reorders. An item is ready when its `needs` are merged.

`BACKLOG.md` is regenerated by the tool after every write: a table of active items, then ready, then inbox, then parked, then merged with the PR link. It exists so the backlog reads on GitHub and on a phone.

## 6. The ledger

`docs/pipeline/ledgers/<id>.json`, written by the tool at each boundary:

```json
{
  "item": "p12", "plan": "docs/pipeline/plans/p12.md", "branch": "feat/p12", "worktree": ".claude/worktrees/p12",
  "base": "a3f91c2", "pr": null,
  "resume": { "task": 3, "state": "fix round 2 dispatched", "lastVerified": "b70de44", "at": "2026-11-05T11:02:00Z" },
  "tasks": [
    { "n": 1, "title": "Export job schema", "status": "accepted", "commits": "a3f91c2..c1d2e3f",
      "dispatches": [{ "role": "implementer", "model": "sonnet", "effort": "medium", "tokens": 182000, "minutes": 23, "result": "done" }],
      "review": { "kind": "lead-diff", "verdict": "accepted" } },
    { "n": 2, "title": "Export runner", "status": "accepted", "commits": "c1d2e3f..9e8d7c6",
      "dispatches": [
        { "role": "implementer", "model": "sonnet", "effort": "medium", "tokens": 240000, "minutes": 31, "result": "fix round 1" },
        { "role": "implementer", "model": "sonnet", "effort": "medium", "tokens": 60000, "minutes": 9, "result": "done" },
        { "role": "reviewer", "model": "opus", "effort": "high", "tokens": 110000, "minutes": 12, "result": "FIX REQUIRED: 1 important", "risky": "apps/web/migrations/0021_export_jobs.sql" }
      ],
      "review": { "kind": "independent", "verdict": "approved after fix round 1", "carried": ["minor: log line wording"] } }
  ],
  "rulings": [{ "n": 1, "task": 2, "text": "Export jobs keep the snapshot id, not the catalog id", "why": "approved catalogs are immutable", "costIfWrong": "exports of a re-approved catalog would silently change" }],
  "blockers": [],
  "final": null,
  "tokens": 592000
}
```

`/pipeline status <id>` renders it as text. Briefs and reports go to `ledgers/<id>/task-N-brief.md` and `task-N-report.md` for the record; resume reads `resume`, not them.

## 7. The skills

Four skills in the plugin. They call superpowers where it fits and do not repeat it.

### 7.1 `pipeline-intake`

Triggers when the user asks for something to be built, fixed or changed, in any wording, and on `/pipeline add <text>`.

1. Match against the backlog: the same request already there is a note on that item, not a new one.
2. Write the item with `status: inbox`, a size guess, `needs` from what the request depends on, and `source` quoting the user.
3. Write `specs/<id>.md`: one page, four headings. What (two to five sentences). Why (one). Acceptance (a checklist the final review ticks). Out of scope (what a reader might expect and will not get). Facts the lead can establish from the code and the project's own spec go in; a question only the user can answer goes under a fifth heading, Open, and the item stays `inbox`.
4. Answer in one line: `p12 added · M · needs p9 · open: none` or `… · open: which users may export?`. At most one question, asked only when the spec cannot be written without it. The user answers in a later turn, or not; a `/pipeline next` on an `inbox` item with an open question stops with that question.
5. An item with no open question goes to `ready` when its needs are merged.

Intake runs in any session, including a phone session over Remote Control, and never starts the build.

### 7.2 `pipeline-run`

Triggers on `/pipeline next`, `/pipeline run <id>`, `/pipeline run all` (until the backlog has no ready item or a stop condition fires), and on "continue the pipeline" after a resume.

1. **Pick.** The first `ready` item in backlog order, or the named one. Set `planning`, create the worktree and branch from `mainBranch`, write the ledger header.
2. **Plan.** `superpowers:writing-plans` from the spec, into `plans/<id>.md`. Pre-flight scan: every producer/consumer pair between tasks; a conflict becomes a ruling. No pause for plan review.
3. **Build**, with `superpowers:subagent-driven-development` and the briefs in section 7.4, task by task:
   - dispatch the implementer at `models.implementer`;
   - read its report, diff and test file; a defect goes back as a fix round to the same implementer, up to `limits.fixRounds`;
   - if the diff touches a `riskyPaths` entry: an independent reviewer at `models.reviewer` with the probe brief; FIX REQUIRED goes to the same implementer, then a scoped re-review;
   - accepted: ledger entry with commits and tokens, item stays `building`, `resume` advances. Minor findings carry into the next brief.
4. **Final review** at `models.final` over the merge base..head diff, the plan, the spec's acceptance list and the ledger; one fix wave, one scoped re-review. Then the lead runs `checks.gate` itself. Red is not done.
5. **PR.** Open it with the spec's acceptance list ticked, the rulings, what was parked, and the token total. Subscribe to its events. `merge: auto`: merge on green with no open Critical or Important. Set `merged`, record the PR. `merge: pr`: set `review`, notify, go to the next item.
6. **Close.** Regenerate `BACKLOG.md`; commit `backlog.json` and the generated view on `mainBranch` (a worktree writes the main checkout's copy). Remove the worktree. One line to the user: `p12 merged · PR #31 · 6 tasks · 2 rulings · 1.4M tokens · next: p13`. With `run all`, continue.

**Stop conditions.** Before any of these the runner sets the item `blocked` with the reason, notifies, and either waits (`run <id>`) or takes the next ready item (`run all`): a `stop` entry from the config applies; an implementer escalated once still fails; CI is red after one fix; `limits.itemTokens` is reached; the spec's Open heading is not empty.

**Resume.** On session start in a project with `docs/pipeline/`, the mod gives the skill the item in `building` or `review`, if any, and its `resume` block. The skill checks the worktree, the last verified commit and the working tree (a WIP commit is not verification), then continues at `resume.task` and says so in one line. Without an active item it says the status line (section 9) and waits.

### 7.3 `pipeline-rules`

Loaded in every session of a project that has `docs/pipeline/config.json`. Small: it tells the lead where the config, backlog and ledgers are, that only the tool writes them, that subagents never write them, and the one-line reply format. The 400 lines of workflow prose in the projects are retired by this skill and the two above; CLAUDE.md keeps code conventions.

### 7.4 `pipeline-migrate`

Triggers on `/pipeline migrate` and when a session starts in a project that has a queue, a workflow document or a ledger but no `docs/pipeline/`; then it offers the migration in one line and does nothing until asked. It is a skill, not only a tool action, because the work is reading how this project runs today and deciding what each piece becomes: a config key, a rules.md line, a backlog item, a ledger, or history. Section 12 is its procedure; the tool's `migrate` action does the file reading and the writes, the skill does the judgment and the one confirmation.

### 7.5 Briefs

Templates in the plugin, filled by the lead. They are the part of openhuddle's WORKFLOW §3 that worked:

- **Implementer**: the task from the plan verbatim; the files it owns and the files it must not touch; names and signatures pinned; tests first; `checks.fast` per edit and `checks.task` before the hand-back; one commit per task as soon as tests pass (restarts kill agents); a report with: what changed, deviations, test evidence, gaps noticed, and the lines that need a reviewer's eye. Never the backlog, never the ledger.
- **Reviewer** (risky tasks only): read-only; the plan, brief, report and diff; the review focus questions from the plan; probes required: revert the fix in a scratch copy and show the failing test, hostile inputs, mutation checks, race detector where it applies; verdict APPROVED or FIX REQUIRED with Critical, Important, Minor.
- **Fix round**: the findings verbatim, the same implementer, scoped to the findings, `fix round N of 3`.
- **Final**: the whole diff, the plan, the spec's acceptance list, the ledger's rulings; the worst-case failure traced end to end; every acceptance line met or named as missing.

Every brief ends with the attribution lines the session was given and the rule that no model identifier goes into commits, PR text or comments.

## 8. The watchdog

A mod (`hooks/register.ts`) that follows every subagent of the session through `agent.spawn`, `turn.step` and `turn.complete`, keeps a small in-memory and on-disk table (`.git/pipeline-live.json`, never committed), and acts on four signals:

| Signal | Detection | Action |
| --- | --- | --- |
| Silent | no `turn.step` from the agent for `limits.silentMinutes` | once: a tool message to the lead naming the agent and its last activity; the lead asks it to report or stops it |
| Dead | the session restarted (a new `session.start` while the live file lists running agents) | the lead is told which agents died and the item's `resume` block; it re-dispatches from the surviving working tree |
| Looping | the same failing shell command (normalised) three times in a row, or a fix round count over `limits.fixRounds` | the lead stops the agent and re-dispatches once at `models.escalate` with the failures in the brief; the ledger records the escalation |
| Over budget | the task passes `limits.taskMinutes` or the item passes `limits.itemTokens` | the lead finishes the running task, then blocks the item |

The mod cannot stop an agent itself; it writes the signal to the live file and the next lead turn reads it through the `mcp__pipeline__pipeline` tool's `get` (section 10), which prepends any open signal. When the lead is idle between items in `run all`, the mod schedules a wake-up (`ScheduleWakeup` or `send_later`, whichever the host offers) every `limits.silentMinutes` so a silent agent is noticed without a user turn.

Activity in words, as the live file keeps it: `editing export.server.ts`, `running npm run check:fast`, `reading the plan`; derived from the agent's tool calls, throttled to one write per two seconds.

## 9. Monitoring

Text first, so the phone and SSH see the same as the desktop:

- `/pipeline status`: one block. The active item with its task counter, running agents with their activity and minutes, open signals; then the ready queue (first five), blocked items with reasons, inbox items with open questions, merged this week. `/pipeline status <id>` renders the item's ledger.
- Every lead reply during a run is one line: `p12 · task 3/6 · implementer sonnet 14 min · fix round 1`.
- Push notifications per `notify`: item started, PR open, merged, blocked, a watchdog signal.
- A panel (the same mod API as the session's other panes): the status block, live. Opens on the first dispatch, `/pipeline panel` toggles it. The panel is a view of the same text; nothing is only in the panel.

## 10. The tool

`mcp__pipeline__pipeline`, registered by the mod, main session only (a subagent's call answers "ignored"):

- `get`: config, backlog, the active item's ledger `resume` block, open watchdog signals.
- `add`, `update`, `move`, `remove` on backlog items by id; `update` merges fields, stamps `updatedAt`, regenerates `BACKLOG.md`.
- `ledger`: `{ item, set: {...} }` merges into the item's ledger (a task entry, a dispatch, a ruling, `resume`, `final`).
- `status`: the text of `/pipeline status`.
- `init`: writes `config.json` from what it finds in the project and an empty backlog. For a project that already has a queue, `/pipeline migrate` (section 12) runs first and calls `init` itself.
- `migrate`: the import step of section 12: reads the named sources and answers the drafted items and the config for the lead to show the user.

Every write re-reads the file, merges, writes through a temp file and renames. A file that fails to parse is never overwritten.

## 11. Commands

| Command | Does |
| --- | --- |
| `/pipeline init` | Config and an empty backlog for a new project |
| `/pipeline migrate` | Move an existing project onto the pipeline (section 12) |
| `/pipeline add <text>` | Intake (7.1) |
| `/pipeline next` | Run the first ready item |
| `/pipeline run <id>` / `run all` | Run one item, or until nothing is ready |
| `/pipeline status [id]` | The status block, or one item's ledger |
| `/pipeline move <id> top` / `after <id>` | Reorder |
| `/pipeline park <id>` / `unpark <id>` | Take out of, back into, the queue |
| `/pipeline stop` | Finish the running task, leave the branch pushed and the ledger current, stop |
| `/pipeline panel` | Toggle the panel |
| `/pipeline config [key=value]` | Show or change the project config |

## 12. Migration of an existing project

`/pipeline migrate` moves a project that already runs its own process (catalo, openhuddle) onto the pipeline in one session, without losing status or history. It is one command, run once, in the main checkout on a clean `mainBranch`.

1. **Read the sources.** The command names what it found and reads, in this order: `CLAUDE.md` and every `*/CLAUDE.md`; `docs/WORKFLOW.md`, `docs/backlog.md`, `docs/SLICES.md` and any file CLAUDE.md links as a queue, status, workflow or ledger; `docs/superpowers/{specs,plans}/`; `.superpowers/sdd/**/progress.md` and `docs/superpowers/ledgers/`; project skills under `.claude/skills/` that concern dispatch, review or models; the Makefile, package scripts and the CI workflow; `git log --merges` and open `feat/*` branches.
2. **Draft the config and the rules.** `checks` from the scripts and CI (catalo: `check:fast`, the workspace tests, the five-check gate; openhuddle: `make check`, `make gen-check`); `riskyPaths` from the prose that names risky code (auth, sessions, parsers, migrations, concurrency, money) mapped onto real directories; `models` from the project's dispatch rules (openhuddle §2: Sonnet implements, Opus reviews; catalo's `agent-dispatch` skill); `limits` from the prose (three fix rounds) or the defaults; `merge` from the stated mode (openhuddle: auto); `stop` from the project's own "ask the user only for" list. Every value carries a `source` line in the migration report so the user sees where it came from. Every process rule in the prose that is not a config key (browser use, test accounts, environment traps, hand-off steps, standing user instructions) becomes a line in `rules.md` under the group where it applies, with the file it came from in the report; a rule the config already enforces is dropped, and a rule that contradicts another is shown to the user as a question in step 6.
3. **Draft the items.** One backlog item per queue entry, in the queue's order: catalo from the unchecked items of `docs/backlog.md` and its named follow-ups; openhuddle from the "MVP queue" entries, each carrying the MVP rows it closes in `note`. Status: `merged` for what git proves is on `mainBranch` (a checked item with a PR, a struck slice with a merge sha); `building` for an open `feat/*` branch with a ledger, with `resume` reconstructed from the ledger's current-status block; `parked` for what the prose marks later or V1; everything else `inbox` with `note: "imported from <file>, unverified"`. A deferral that lives only in an old item's prose (openhuddle's lost-leftover problem) becomes its own `inbox` item with the source quoted. Existing specs and plans are linked from the items they belong to; nothing is moved or rewritten.
4. **Keep the history.** Old ledgers, SLICES.md and the old backlog stay where they are, untouched; each gets one line at the top: "Historical. The queue is docs/pipeline/backlog.json since <date>." The migration report lists every file it read and what it took from it.
5. **Retire the workflow prose.** In CLAUDE.md the sections about how work is run (the loop, roles and models, dispatch, approval gates, ledgers, resume, standing instructions on process) are replaced by one paragraph: the project runs on the pipeline plugin, the config is `docs/pipeline/config.json`, start with `/pipeline status`. Code conventions, layout, commands, decisions already made and the definition of done stay. Project skills that only restated dispatch rules (catalo's `agent-dispatch`) are deleted; skills that do something else (catalo's `increment-review-stack`) stay and the config's `afterMerge` names them. `docs/WORKFLOW.md` becomes the one-paragraph pointer with its "what the slices taught" section kept.
6. **Show and confirm once.** The command answers with the status block, the config with its source lines, the list of removed and rewritten sections, and one sentence asking for corrections. This is the one interaction: the user answers in a sentence or two ("p3 is done, p7 before p5, merge stays manual") and the lead applies it. Then everything is committed on a branch `chore/pipeline-migration` with a PR, under the project's own merge rule.
7. **First run.** `/pipeline status` in a fresh session must show the same picture the old docs gave, and the first item's briefs must carry the rules the old prose carried; if it cannot (an item the old ledger calls done that git cannot prove), the item stays `inbox` with the note and the status block says how many are unverified.

The migration is idempotent: a second `/pipeline migrate` on a migrated project refreshes links and the config's sources and changes no status. Done for catalo first; openhuddle after a week of use, when the first migration's rough edges are fixed.

## 13. Open questions

- Whether a headless child session per item (parallel items) comes in version 1.1 or later; the worktree-per-item layout is ready for it.
- Whether `checks.task` should be derived from the diff (catalo's `check:fast` does it) or named per task in the plan.

## 14. What it contains

| Part | Name |
| --- | --- |
| Skills | `pipeline-intake`, `pipeline-run`, `pipeline-rules`, `pipeline-migrate` |
| Brief templates | `templates/implementer.md`, `reviewer.md`, `fix.md`, `final.md` |
| Tool | `mcp__pipeline__pipeline` |
| Mod | `hooks/register.ts`: the tool, the commands, the watchdog, the panel, the live file |
| Tests | `claude plugin test plugins/pipeline` |
