# The full loop (`config.mode` = `full`, or an item whose ledger already has tasks)

You write a plan, dispatch subagents, verify what they did and decide. The tool renders every brief and records every boundary. Steps 1, 2 and 9 are the main file's; these replace its step 3.

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
- **Agents in the foreground.** Never `run_in_background` for an Agent, and no background shell command: each completion wakes you for a turn. The exceptions are step 8 and, when the `merge` action is refused, the CI watch of step 9.
- **Work in the worktree by its path**: `cd` to it in your shell commands and use its path for file edits; do not call `EnterWorktree`. Every brief names the worktree, so the subagents work there whatever folder your shell is in.
- `get` once per item; never `get { "full": true }`; `status <id>` only when the user asks; never re-read a file to check a write.
- A subagent answers one line; its report is a file. Open a report only for the findings of a `FIX REQUIRED`, or when the diff raises a question.
- `config.superpowers` is `off` unless the project turned it on: invoke no superpowers skill and no other planning, brainstorming or dispatch skill during a run, whatever a `CLAUDE.md` says; this skill and the tool are the process. With `on`, a testing or debugging skill may be used inside a step.

## Steps

3. **Plan.** Read the spec, then only the code the item touches. Write the plan in the worktree at the path `begin` answered (`docs/pipeline/plans/p12.md`; with queue: github `.pipeline/<id>/plan.md`), in the format below, then `{ "action": "plan", "item": "p12", "attribution": "<the attribution lines this session was given, copied as they are, one per line: the commit trailer and the pull request line>" }`: it checks the plan, seeds the tasks, commits it and answers the first Agent call. No pause for plan review.
   - **Few tasks.** One task is one commit a test can prove alone: S is 1 or 2 tasks, M 2 to 4, L 4 to 7. No task for docs, wiring or cleanup alone.
   - **Exact.** The files, the functions with their signatures, the failing test to write first, the line that says done. An implementer that has to explore costs more than a longer task text.
   - **Seams.** A name one task produces and another consumes is stated the same in both under `Pinned`. A conflict with the spec or the code that you settle is a ruling: `ledger` with `"rulings": [{ "task": 2, "text": "...", "why": "...", "costIfWrong": "..." }]`.
4. **Dispatch.** `plan` and `accept` already answer the next Agent call (`Agent subagent_type … model … effort … · prompt: …`): make it with exactly those values. Ask for a brief yourself (`{ "action": "brief", "item": "p12", "kind": "implementer", "task": N }`) only on a resume.
5. **Verify**, yourself, on `DONE`: in one message `git diff --stat <verified>..HEAD` and the task's check (the plan's `Check`, else `checks.task`); then the hunks of the tests and of the core change. Accept only what you saw: a green run, a test that would fail without the change, no file outside the task's `Files`. Anything else → step 6. `BLOCKED` → answer it from the spec or a ruling and dispatch again, or Stop conditions.
6. **Fix round.** `brief` with `"kind": "fix"`, the `task`, `"findings"` verbatim (`file:line · what is wrong · how to show it`) and `"close": { "tokens": T, "minutes": M, "result": "fix round R" }` for the dispatch that just ended; then the Agent call. The tool counts the round; past `limits.fixRounds` add `"escalate": true` once with every failure; still failing → Stop conditions.
7. **Accept, or review first.** `{ "action": "accept", "item": "p12", "task": N, "tokens": T, "minutes": M, "carried": "<minor findings, or omit>" }`. It closes the dispatch, records the range, commits the records, pushes and answers the next Agent call: the next task's implementer (step 4), or the final review after the last task (step 8). When the implementer's line ended with `fact: …`, pass it as `"fact"`: the tool keeps it for every later brief. When the config asks for an independent review of this diff it answers `review first` with the `brief` call to make: that call, then the Agent call; `FIX REQUIRED` → the report's Critical and Important into step 6, then the same `brief` call with the fix range and `"findings"` for a scoped re-review; Minor findings are `carried`. `APPROVED` → `accept` again.
8. **Final review and gate.** The Agent call the last `accept` answered. `FIX REQUIRED` → one fix wave (a `fix` brief per task touched), then one scoped re-review (`kind: "final"` with `"findings"`). Then one call ends the item: `{ "action": "ship", "item": "p12", "verdict": "approved", "tokens": T }`. The tool runs `checks.gate` itself, records it with the verdict, pushes, opens the pull request and, under `merge: auto`, waits for CI, merges and closes. A red gate answers the output's tail: one fix wave, then `ship` again. A `MISSING` acceptance line after the wave, or a gate red twice, is a stop. The call returns when the gate ends, however long it runs.

`ship` is the end: no `gate`, `pr`, `merge` or `close` call after it, and none after an answer that says `merged`, also when it says a worktree was left. Under `merge: pr` the answer ends at the open pull request, as in the main file's step 3.

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
