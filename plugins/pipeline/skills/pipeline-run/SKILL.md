---
name: pipeline-run
description: Use on /pipeline next, /pipeline run <id> (on a blocked item: resume it), /pipeline run all, on "continue the pipeline" in any wording, and when a session starts in a project with docs/pipeline/config.json and the mcp__pipeline__pipeline tool's get shows an item in planning, building or review. Runs one backlog item from pick to merge, plan, build with subagents from briefs the tool renders, final review, PR, close, through the tool and its ledger, and answers in one line per turn. Needs no other plugin.
---

# pipeline-run

One item at a time, from `ready` to `merged`. You are the lead: you write the plan, dispatch subagents, verify what they did and decide. The tool `mcp__pipeline__pipeline` does everything clerical: the worktree, the ledger, the briefs, the record commits, the pushes, the gate. You never write a brief, never commit a record, never push by hand.

| File beside this one | Read it when |
|---|---|
| `runner.md` | `get` answers `config.runner` = `session` |
| `resume.md` | `get` names an active item, or the user names a blocked one |
| `signals.md` | an answer carries a watchdog signal, or a wake-up asks for `signals` |

Never open one otherwise.

## How to work: the lead is the cost

Every turn of yours re-reads this whole conversation, so the number of turns is what an item costs.

- **Reason silently; text only at the end of the item.** The user watches the panel, not your steps. Between two tool calls you write nothing at all: the next thing you emit after a tool result is the next tool call.
  - Bad: `Verified. Accepting task 1 now.` then the `accept` call. Good: the `accept` call.
  - Bad: `The plan is written; registering it, then dispatching.` Good: the `plan` call, then the `brief` call.
  - Bad: `No GitHub here, so I'm skipping the PR.` Good: the `update` call; the reason goes in its `note`.
  - Self-check: if you are about to write `Now`, `Next`, `I'm`, `I'll`, `Let me`, `Verified`, `Done` or `Dispatching`, delete it and make the call.
  - The item's last message is one line, `p12 review · PR #31 · 3 tasks · gate green`; a stop adds the one sentence the user must act on. No summary of what was built: the PR has it.
- **Never pull more than 20 lines of raw output into the conversation.** A check or a test run goes through `tail -15`; a diff is `--stat` first, then only the hunks of the tests and the core change (`git diff <range> -- <file>`).
- **Independent calls in one message** (the diff stat and the check; two reads).
- **Agents in the foreground.** Never `run_in_background` for an Agent, and no background shell command: each completion wakes you for a turn. The one exception is step 8.
- **One simple command per shell call inside the worktree**: no `&&`, no `;`, no `cd`. A compound command is refused there and costs a retry.
- `get` once per item; never `get { "full": true }`; `status <id>` only when the user asks; never re-read a file to check a write.
- A subagent answers one line; its report is a file. Open a report only for the findings of a `FIX REQUIRED`, or when the diff raises a question.
- `config.superpowers` is `off` unless the project turned it on: invoke no superpowers skill and no other planning, brainstorming or dispatch skill during a run, whatever a `CLAUDE.md` says; this skill and the tool are the process. With `on`, a testing or debugging skill may be used inside a step.

## Steps

1. **Read.** `{ "action": "get" }`. `mergedPending` first: run Close (step 9) for each entry. A signal → `signals.md`. An active item → `resume.md`. `config.runner` = `session` → `runner.md`, and stop here. Read `docs/pipeline/rules.md` once: `before dispatch` is your checklist before each Agent call, `after merge` applies at Close; the tool puts the other groups into the briefs.
2. **Begin.** The first entry of `next` with reason `ready`, or the named id: `{ "action": "begin", "item": "p12" }`. It claims the item, makes the worktree and branch, records the base and answers the worktree to enter; then `EnterWorktree` with that `path` (not in a child session). A refusal says why: another session runs it (take the next), or it is not ready. An item with a `note` and no `spec` is not a stop: write the spec from the note with `templates/spec.md` at `docs/pipeline/specs/p12.md`, `update` with `"spec"`, then `begin`. An open question in the spec, or an unmerged `needs`, is a stop.
3. **Plan.** Read the spec, then only the code the item touches. Write `docs/pipeline/plans/p12.md` in the worktree, in the format below, then `{ "action": "plan", "item": "p12", "attribution": "<the attribution lines this session was given>" }`: it checks the plan, seeds the tasks, commits it and answers the first Agent call. No pause for plan review.
   - **Few tasks.** One task is one commit a test can prove alone: S is 1 or 2 tasks, M 2 to 4, L 4 to 7. No task for docs, wiring or cleanup alone.
   - **Exact.** The files, the functions with their signatures, the failing test to write first, the line that says done. An implementer that has to explore costs more than a longer task text.
   - **Seams.** A name one task produces and another consumes is stated the same in both under `Pinned`. A conflict with the spec or the code that you settle is a ruling: `ledger` with `"rulings": [{ "task": 2, "text": "...", "why": "...", "costIfWrong": "..." }]`.
4. **Dispatch.** `plan` and `accept` already answer the next Agent call (`Agent subagent_type … model … effort … · prompt: …`): make it with exactly those values. Ask for a brief yourself (`{ "action": "brief", "item": "p12", "kind": "implementer", "task": N }`) only on a resume.
5. **Verify**, yourself, on `DONE`: in one message `git diff --stat <verified>..HEAD` and the task's check (the plan's `Check`, else `checks.task`); then the hunks of the tests and of the core change. Accept only what you saw: a green run, a test that would fail without the change, no file outside the task's `Files`. Anything else → step 6. `BLOCKED` → answer it from the spec or a ruling and dispatch again, or Stop conditions.
6. **Fix round.** `brief` with `"kind": "fix"`, the `task`, `"findings"` verbatim (`file:line · what is wrong · how to show it`) and `"close": { "tokens": T, "minutes": M, "result": "fix round R" }` for the dispatch that just ended; then the Agent call. The tool counts the round; past `limits.fixRounds` add `"escalate": true` once with every failure; still failing → Stop conditions.
7. **Accept, or review first.** `{ "action": "accept", "item": "p12", "task": N, "tokens": T, "minutes": M, "carried": "<minor findings, or omit>" }`. It closes the dispatch, records the range, commits the records, pushes and answers the next Agent call: the next task's implementer (step 4), or the final review after the last task (step 8). When the implementer's line ended with `fact: …`, pass it as `"fact"`: the tool keeps it for every later brief. When the config asks for an independent review of this diff it answers `review first` with the `brief` call to make: that call, then the Agent call; `FIX REQUIRED` → the report's Critical and Important into step 6, then the same `brief` call with the fix range and `"findings"` for a scoped re-review; Minor findings are `carried`. `APPROVED` → `accept` again.
8. **Final review and gate.** The Agent call the last `accept` answered. `FIX REQUIRED` → one fix wave (a `fix` brief per task touched), then one scoped re-review (`kind: "final"` with `"findings"`). Then `{ "action": "gate", "item": "p12", "verdict": "approved", "tokens": T }`: the tool runs `checks.gate` itself, records it and pushes. A red gate answers the output's tail: one fix wave, then `gate` again. A `MISSING` acceptance line after the wave, or a gate red twice, is a stop. The call returns when the gate ends, however long it runs.
9. **PR and Close.** Open the PR against `mainBranch`: the title, the Acceptance list ticked, the rulings, what was parked, the token totals of `status p12`, the attribution footer. `ledger` and `update` with `"pr": "#31"`; `subscribe_pr_activity`. `merge: pr` → `update` to `review`, say `p12 review · PR #31` and, under `run all`, step 1; Close runs when a later `get` reports the item in `mergedPending`. `merge: auto` → wait for CI through the subscription; green with no open Critical or Important → merge with `config.mergeMethod`; red → one fix wave; red again → Stop conditions. **Close**, once the PR is on `mainBranch`, from the main checkout: `git -C <root> checkout <mainBranch>`, `git -C <root> pull`; `update` to `merged` with its `pr`; `{ "action": "clean", "item": "p12" }` and remove what it lists (`git rm -r -q`, plain `rm -r` for untracked, `ExitWorktree` or `git worktree remove` for the worktree, `git branch -D` for a `branch:` line); commit `docs/pipeline/` with the removals on `mainBranch` and push; each `config.afterMerge` entry and the `after merge` rules. Reply `p12 merged · PR #31 · 6 tasks · 2 rulings · next: p13`.

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

`Files` is required and is the task's boundary. A project file `docs/pipeline/templates/<implementer|fix|review|final>.md` replaces a built-in brief. What you write by hand (the plan, a spec) goes in the worktree; the tool's files live in the main checkout and are committed on `mainBranch` at Close. No model identifier goes into commits, PR text or comments.

## Stop conditions

Before any of these: `{ "action": "update", "id": "p12", "set": { "status": "blocked", "note": "<reason>" } }`, `{ "action": "ledger", "item": "p12", "set": { "blockers": ["<reason>"] } }`, notify, and either wait for the user (`next`, `run <id>`) or take the next ready item (`run all`). The worktree stays for the resume.

Out of `blocked`: `/pipeline run <id>` on a blocked item resumes it. Read the item's `note` and the user's answer in the conversation; `update` to `building` (`ready` when nothing was built yet) with a `note` recording the resolution in a few words (the ledger's `blockers` list is history and stays); then read `resume.md`.

- Any entry of `config.stop` applies to what the task needs (read them as text; the defaults are a product decision the spec leaves open, a security trade-off, CI that cannot be made green, credentials or external services, new cost, a destructive data change).
- An implementer escalated once still fails (step 6).
- CI or `checks.gate` is red after one fix wave (steps 8 and 9).
- The ledger's `tokens` reaches `limits.itemTokens`, or a task passes `limits.taskMinutes`: finish the running task, then block.
- The spec's Open heading is not empty, found at pick or during the build.
- A protected path (`config.protectedPaths`) must change and the spec does not say so.
