---
name: pipeline-run
description: Use on /pipeline next, /pipeline run <id> (on a blocked item: resume it), /pipeline run all, on "continue the pipeline" in any wording, and when a session starts in a project with docs/pipeline/config.json and the mcp__pipeline__pipeline tool's get shows an item in planning, building or review. Runs one backlog item from pick to merge, plan, build with subagents from briefs the tool renders, final review, PR, close, through the tool and its ledger, and answers in one line per turn. Needs no other plugin.
---

# pipeline-run

One item at a time, from `ready` to `merged`. You are the lead: you write the plan, dispatch subagents and record every boundary through `mcp__pipeline__pipeline`. The tool does the clerical work: `plan` checks your plan and seeds the ledger, `brief` renders each brief from the plan, the config, `rules.md` and the spec, writes it, opens the dispatch in the ledger and answers the Agent call to make. You never write a brief by hand and never paste one. Nothing here needs another plugin; a skill the session has for testing or debugging may be used inside a step.

**One line per reply**: `p12 · task 3/6 · implementer sonnet 14 min · fix round 1`. A milestone adds what changed. No summaries, no offers.

**Cost rules.** Every tool answer stays in this conversation and is re-read on every later call.
- `get` once at the start of an item and after a restart; `signals` for a watchdog check; `status <id>` only when the user asks; never `get { "full": true }`.
- A write answers one line; never re-read a file to check it.
- A subagent answers one line (`DONE …`, `APPROVED …`, `FIX REQUIRED …`, `BLOCKED …`); its report is a file. Open a report only when the line or the diff raises a question, or for the findings of a `FIX REQUIRED`.
- Read a result as `git diff --stat <range>` first, then only the hunks that matter. Pipe a check through `tail -15`.
- Independent calls go in one message (a `git diff --stat` and a check; the ledger write and the push).

**Two homes.** What you write by hand (the plan, a spec written at pick) goes in the worktree at its relative path and reaches `mainBranch` through the PR; inside the worktree the engine refuses a hand edit at the main checkout's path. What the tool writes (`backlog.json`, `BACKLOG.md`, `ledgers/<id>.json`) lives in the main checkout and is committed on `mainBranch` at Close. Briefs and reports land in the worktree under `docs/pipeline/ledgers/<id>/` and are committed on the branch with the next accept. No model identifier goes into commits, PR text or comments.

## Steps

1. **Read.** `{ "action": "get" }`: the active item with its `resume` block, the open signals, the next items, the config keys. **`mergedPending` first**: each entry is an item whose PR was merged by hand; run Close (step 10) for each before anything else. Then act on a signal (Watchdog signals). Read `docs/pipeline/rules.md` once: `before dispatch` is your checklist before each Agent call and `after merge` applies at Close; the tool puts the other groups into the briefs.
2. **Pick.** The first `ready` item, or the named id. An item with a `note` and no `spec` (named, or the first `inbox` item when nothing is ready) does not stop: write the spec from the note with `templates/spec.md`, `update` with `"spec": "docs/pipeline/specs/p12.md"`, continue. Any other item that is not `ready` stops with the reason, except a `blocked` item named by id, which resumes (Stop conditions). **Runner session, the parent**: call `{ "action": "start", "item": "p12" }`, answer its line and stop (Runner session). **In a child session**: skip the status change and the worktree; make the ledger call and go to step 3. Otherwise: `update` to `planning`; `EnterWorktree` named `p12`, branch from `config.branch` off `mainBranch`; `{ "action": "ledger", "item": "p12", "set": { "branch": "feat/p12", "worktree": ".claude/worktrees/p12", "base": "<merge base sha>" } }`.
3. **Plan.** Read the spec, then only the code the item touches (Grep, an Explore agent for a wide search). Write `docs/pipeline/plans/p12.md` in the format below and commit it. No pause for plan review.
   - **Few tasks.** One task is one commit an implementer finishes in one sitting and a test can prove alone: S is 1 or 2 tasks, M 2 to 4, L 4 to 7. Never a task for docs, wiring or "cleanup" alone; fold those into the task that needs them.
   - **Exact.** Name the files, the functions with their signatures, the failing test to write first and the line that says done. An implementer that has to explore costs more than a longer task text.
   - **Seams.** For every name one task produces and another consumes, both tasks state the same file, signature and shape under `Pinned`. A conflict with the spec or the existing code that you settle is a ruling: `ledger` with `"rulings": [{ "task": 2, "text": "...", "why": "...", "costIfWrong": "..." }]`.
   - Then `{ "action": "plan", "item": "p12", "attribution": "<the attribution lines this session was given>" }`: it answers the problems to fix, or seeds the tasks and sets the item `building`.
4. **Dispatch.** `{ "action": "brief", "item": "p12", "kind": "implementer", "task": N, "carried": "<minor findings of the previous review, or omit>" }`, then the Agent tool with exactly the model, effort and prompt the answer names.
5. **Verify**, yourself, when the agent answers `DONE`: in one message, `git diff --stat <lastVerified>..HEAD` and the task's check (`Check` of the plan, else `checks.task`) piped through `tail -15`; then the hunks of the tests and the core change. Accept only what you saw: a green run, a test that fails without the change by its reading, no file outside the task's `Files`. A defect, a red check, a missing test, a stray file → step 6. `BLOCKED` → answer the question from the spec or a ruling and dispatch again, or Stop conditions.
6. **Fix round.** `ledger` with `"tasks": [{ "n": N, "close": { "tokens": T, "minutes": M, "result": "fix round R" } }]`, then `brief` with `"kind": "fix"`, the `task` and `"findings"` verbatim (`file:line · what is wrong · how to show it`), then the Agent call (the same agent resumed where the host allows it). The tool counts the round; past `limits.fixRounds` add `"escalate": true` once, with every failure in the findings; still failing → Stop conditions.
7. **Review.** With `config.taskReview` `off`, skip to step 8. Otherwise `brief` with `"kind": "review"`, the `task` and `"commits": "<lastVerified>..<head>"`. `no review: …` → step 8 with `kind: "lead-diff"`. Else the Agent call. `FIX REQUIRED` → read the report's Critical and Important, step 6 with them verbatim, then a scoped re-review: the same `brief` call with the fix commit range and `"findings"`. Minor findings are not fixed now: they are `carried` in the next implementer brief.
8. **Accept**, in one message: `ledger` with `"tasks": [{ "n": N, "close": { "tokens": T, "minutes": M, "result": "done" }, "status": "accepted", "commits": "<range>", "review": { "kind": "lead-diff" | "independent", "verdict": "...", "carried": [...] } }], "resume": { "task": N+1, "state": "task N accepted", "lastVerified": "<head>" }`, and `git add docs/pipeline/ledgers/p12 && git commit -q -m "p12: task N record" ; git push -q -u origin feat/p12`. Tokens and minutes are the Agent result's; a review's dispatch is closed the same way before its fix round. Next task from step 4; after the last, step 9.
9. **Final review and gate.** `{ "action": "brief", "item": "p12", "kind": "final" }` and the Agent call; in the same message start `checks.gate` in the background when the host allows it, else run it after. `FIX REQUIRED` → one fix wave (a `fix` brief per task touched), then one scoped re-review (`kind: "final"` with `"findings"`). A `MISSING` acceptance line after that wave, or a gate red after one fix wave, is a stop. Record: `ledger` with `"final": { "verdict": "approved", "gate": "green", "tokens": T }`.
10. **PR and Close.** Push; open the PR against `mainBranch`: the title, the Acceptance list ticked, the rulings, what was parked, the token total, the attribution footer. `ledger` and `update` with `"pr": "#31"`; `subscribe_pr_activity`. `merge: pr` → `update` to `review`, say `p12 review · PR #31 · …` and take the next item under `run all`; Close runs when a later `get` or `signals` reports the item in `mergedPending`. `merge: auto` → wait for CI through the subscription; green with no open Critical or Important → merge with `config.mergeMethod`; red → one fix wave and one push; red again → Stop conditions. **Close**, once the PR is on `mainBranch`, from the main checkout: `git -C <root> checkout <mainBranch> && git pull`; `update` to `merged` with its `pr`; `{ "action": "clean", "item": "p12" }` and remove what it lists (`git rm -r -q`, plain `rm -r` for untracked, `ExitWorktree` or `git worktree remove` for the worktree, `git branch -D` for a `branch:` line); commit `docs/pipeline/` with the removals on `mainBranch` and push; run each `config.afterMerge` entry and the `after merge` rules. Reply `p12 merged · PR #31 · 6 tasks · 2 rulings · 1.4M tokens · next: p13`. Under `run all`, back to step 1.

## The plan format

```
# p12: <title>

## Constraints
<what holds for every task: conventions, what must not change>

## Parked
<what the spec implies and this plan leaves out, or "nothing">

### Task 1: <title>
- Files: <path>, <path>
- Pinned: <names and signatures other tasks rely on, or none>
- Needs: <earlier task numbers, or none>
- Check: <the command that proves this task; default checks.task>
- Commit: <the commit message>
- Focus: <what a reviewer should doubt>

<the steps: the failing test first, then what to build, exact names, the done line>
```

`Files` is required and is the task's boundary: the brief lists every other task's files as not the implementer's. A project file `docs/pipeline/templates/<implementer|fix|review|final>.md` replaces a built-in brief.

## Runner session

`config.runner` = `session` runs each item in a headless Claude Code child of its own (`claude -p` in the item's worktree, the installed plugins loaded, this session's permission mode) instead of in this session. The child cannot ask anyone anything: it runs only when this session's mode is `acceptEdits`, `auto`, `dontAsk` or `bypassPermissions`, and `start` refuses otherwise, naming the modes.

- **The parent** (`/pipeline next`, `/pipeline run <id>`): `{ "action": "get" }`, then `{ "action": "start", "item": "p12" }` for the first ready item or the named one (a `blocked` item resumes), and answer the tool's one line (`started p12 in .claude/worktrees/p12 · session <id> · log .git/pipeline/p12.log`). The tool makes the worktree, sets the item `building` with the note `session runner`, records `branch` and `worktree` in the ledger and spawns the child; the child's one-line replies and tool uses stream into the log. Never plan, dispatch or merge in the parent while a child runs the item.
- **`run all`**: `start` up to `limits.parallel` items whose `needs` are merged (the tool refuses the one past the limit; the refusal is the signal to wait). Each `get` answers `children` with each child's `status`; when one is `finished` or `failed` and a slot is free, `start` the next ready item. Between starts the mod schedules a wake-up every `limits.silentMinutes` while a child runs, so you are brought back without a user turn; on the wake-up, `signals`, then `get` for `children` before starting the next item. A `failed` child left its item `blocked` with the exit code and the log tail in the note.
- **The child** runs this skill from step 2's ledger call to step 10 in its own session, with `runner subagent` (a child never starts children). Its `/pipeline`-free prompt already names the item; its first tool call is `get`. The parent's panel shows the task counter from the ledger the child writes, with Stop and Log.
- **`stop { item }`** (`/pipeline stop p12`, the panel's Stop) kills the child and sets the item `blocked` with `stopped by the user`; `log { item }` (`/pipeline log p12`, the panel's Log) answers the last 60 lines. A stopped or failed item is started again with `/pipeline run p12`: the worktree and branch are reused and the child resumes from the ledger.
- Signals for a child in a `get` answer name the agent `child p12`: **silent** (its live entry has had no heartbeat for three minutes while its process runs) → read `log`; a child that is working shows tool uses there; one that is stuck → `stop`, then `run p12`. **dead** (its process exited with the item still `building`) → `run p12` resumes it.

## Stop conditions

Before any of these: `{ "action": "update", "id": "p12", "set": { "status": "blocked", "note": "<reason>" } }`, `{ "action": "ledger", "item": "p12", "set": { "blockers": ["<reason>"] } }`, notify, and either wait for the user (`next`, `run <id>`) or take the next ready item (`run all`). The worktree stays for the resume.

Out of `blocked`: `/pipeline run <id>` on a blocked item resumes it. Read the item's `note` and the user's answer in the conversation; `update` to `building` (`ready` when nothing was built yet) with a `note` recording the resolution in a few words (the ledger's `blockers` list is history and stays); then Resume.

- Any entry of `config.stop` applies to what the task needs (read them as text; the defaults are a product decision the spec leaves open, a security trade-off, CI that cannot be made green, credentials or external services, new cost, a destructive data change).
- An implementer escalated once still fails (step 6).
- CI or `checks.gate` is red after one fix wave (steps 9 and 10).
- The ledger's `tokens` reaches `limits.itemTokens`, or a task passes `limits.taskMinutes`: finish the running task, then block.
- The spec's Open heading is not empty, found at pick or during the build.
- A protected path (`config.protectedPaths`) must change and the spec does not say so.

## Resume

1. `{ "action": "get" }`: the active item (`planning`, `building` or `review`) and its `resume` block. An item in `planning` with no resume block restarts at steps 2 and 3, reusing the worktree and branch when they exist (never a second one). No active item: say the status line and wait.
2. Enter the worktree before any dispatch: `EnterWorktree` with the ledger's `worktree` path. When the folder is gone, fetch the branch (`git fetch origin <ledger.branch>`, pushed at every accept) and recreate it: `git worktree add <path> <branch>`. In a child session you are already in the worktree: skip this step's `EnterWorktree` and recreation (never run `EnterWorktree`, never create another worktree) and go on with the checks. Then check the branch is checked out there and `resume.lastVerified` is on it. The working tree: `git status --porcelain` and `git log lastVerified..HEAD`. A commit after `lastVerified` is the implementer's claim, not verification, and a WIP commit is not verification either: re-run the task's check yourself, and treat the result as step 5 of that task. Uncommitted changes from a dead agent: keep them, they are the surviving tree the re-dispatch starts from.
3. Continue at `resume.task` in the state named (`planned` or `task N accepted` → step 4; `implementer dispatched`, `fix round R dispatched` or `review dispatched` → the Agent call again with the brief already on disk, named by the open dispatch's `brief` in `status p12`, and a line saying what the tree already holds, or, when the file is gone, the `brief` call again; `final review dispatched` → step 9; a `pr` on the item → step 10's wait). Say so in one line: `p12 · resumed at task 3/6 · fix round 2 · tree verified at b70de44`.

## Watchdog signals

Check with `{ "action": "signals" }`: it answers only the open signals from the mod (or `no signals`; with a PR merged by hand it answers `{ signals, mergedPending }`, and the `mergedPending` items get their Close, step 10), and `get` carries them too; each is delivered once, so act in the turn you read it and name it in the line. A wake-up from the mod asks for exactly this call.

- **silent** (no step for `limits.silentMinutes`): once, send the agent a request for a report; no answer by the next check → stop it (`TaskStop`), `close` the dispatch with `result: "stopped: silent"`, dispatch again from the surviving tree.
- **dead** (the session restarted with agents running): the signal names them; go to Resume and re-dispatch from the surviving working tree, never from `lastVerified` alone.
- **looping** (the same failing command three times, or fix rounds over `limits.fixRounds`): stop the agent, then one `fix` brief with `"escalate": true` and the failures as findings; a second failure → Stop conditions.
- **budget** (`limits.taskMinutes` or `limits.itemTokens`): finish the running task, then Stop conditions.

Between items under `run all`, schedule a wake-up every `limits.silentMinutes` (`send_later` or the host's equivalent) so a silent agent is noticed without a user turn; the mod schedules one itself while a subagent or a child session runs, where the host offers `ScheduleWakeup`.
