---
name: shipright
description: Use when the user asks to build, add or implement a feature and wants it done natively in this session. Covers the whole road from design discussion to pull request - spec, lean plan, new branch, one task at a time with code, unit test and a quick review, then a full review of the whole branch before the PR. Not for one-file fixes or questions.
---

# Shipright

A fast pipeline. One session builds the feature end to end and keeps the context, so nothing is explained twice and nothing rescans the branch. Reviews are separate read-only agents on models the user picks, and they get their inputs handed to them instead of searching for them.

Three rules make it fast:

- **Write each thing once.** The plan holds decisions, not code. The code is written during the build.
- **Hand over, don't search.** Every agent prompt carries exactly what the agent needs: the task block, the ledger lines, the diff. Agents read files only to confirm a finding.
- **Batch.** Calls that don't depend on each other go out in one message: the test file and the implementation together, then the narrow check; the commit together with the next task's first reads.

All artifacts live under `.shipright/` in the repo root, committed on the feature branch: `specs/`, `plans/`, and `ledger.md`.

## Phase 0: Agree the shape

If the user is still thinking out loud, answer the design question first and stop. Only start building when they say so. When they do, write `.shipright/specs/YYYY-MM-DD-<feature>-design.md`: why, goals, non-goals, the design decisions with exact names and values, and a Later section. If the repo has engineering rules (AGENTS.md, CLAUDE.md, a skill), read them first and follow them in the spec.

## Phase 1: Lean plan

Read the files the feature touches, in one batch. Then write `.shipright/plans/YYYY-MM-DD-<feature>.md` in this format and nothing more:

```
# <Feature> plan
Spec: .shipright/specs/<file>
Goal: <one sentence>

## Constraints
- <one line each: import rules, naming, exact messages, file numbering, commands>

## Review focus
- <input or failure mode a user will hit> -> Task N pins it
(five lines, most likely first)

## Task N: <deliverable>
Files: create a.mjs, a.test.ts; modify b.mjs (fn name)
Produces: `fnName(arg: Type): Return` - what later tasks call, exact
Tests: a.test.ts
- <test name>: <key assertion with the spec's exact values>
- <test name>: <key assertion>
Decide: <the one choice the signature and tests leave open, or omit>
Done: `<narrow check command>` passes
```

What goes in verbatim, because it is a decision: error messages, env variable names, SQL migrations, protocol frame shapes, file paths. What stays out, because the build writes it: test bodies, function bodies, imports, anything the signature and the assertions already determine. A task block is usually under 20 lines.

Before showing the plan, check three things and fix the plan:

1. Every name a task uses from another task appears in an earlier task's Produces line.
2. Every Review focus line names a task whose Tests cover it.
3. Every assumption about the repo is true: read the test helpers, script names, fixtures and config the plan relies on.

Show the user the plan path and go to Phase 1b. Do not offer subagent-driven execution; the method is the phases below.

## Phase 1b: Choose models and effort

The code is written by this session, on whatever model and effort it runs on. A session cannot switch its own model or effort (tools such as `set_session_model` act only on other sessions) and cannot read its own effort reliably, so do not call those tools, do not claim what the current settings are, and do not ask which model should write the code. Say it in one line before the question: "This session writes the code on its current model; switch it in the model menu first if you want another one."

Count the plan's tasks. Then ask one `AskUserQuestion` call with these questions, each offering four `<model> <effort>` presets and letting Other take any pair such as `opus low`:

1. **Task review**, only when the plan has three or more tasks. Presets: `Sonnet low` (recommended), `Haiku low`, `Opus medium`, `Fable medium`.
2. **Final review**. Presets: `Fable high` (recommended), `Opus high`, `Fable max`, `Opus max`.

With one or two tasks, skip question 1 and the per-task review, and say so in one line; the final review covers it. The answers hold for the whole run and go to the agents as the Agent tool's `model` and `effort` overrides.

## Phase 2: Branch

If the current branch is already the feature branch for this work, stay on it. Otherwise create `feature/<slug>` from the current branch. Never work on the default branch. Commit the spec, the plan and an empty `.shipright/ledger.md` together.

## Phase 3: Build, one task at a time

Keep the pinned task list current: one entry per plan task, then gate, final review, pull request.

For each task:

1. **Test and code in one batch.** Write the test file and the implementation in the same message, then run the narrow check. If you are unsure the test fails for the right reason (a new assertion on existing code), run it before the implementation instead.
2. **Green.** Fix until the narrow check passes. Fix the implementation for a real bug; never weaken an assertion.
3. **Review.** With the per-task review on, launch `shipright:task-reviewer` with the chosen `model` and `effort`, and paste into its prompt: the task block from the plan, the Constraints section, the ledger lines of earlier tasks this one depends on, and the output of `git diff` for this task's files (use `git diff --cached` after staging new files). Fix every confirmed finding and rerun the narrow check. With it off, read the diff once yourself for a secret reaching a log, a forbidden path, a name that drifted from Produces, and a file outside the task.
4. **Prove packaging.** If the task changes what a build or image depends on (a Dockerfile COPY, a dockerignore, a lockfile), run the real build once.
5. **Commit and record, in one message.** Append the task's entry to `.shipright/ledger.md`, stage it with the task's files, commit with one or two sentences about why. Commit locally; never push here.
6. **Next.** Advance the pinned task list and start the next task in the same message where it can.

Ledger entry, three lines at most, only what a later task or a reviewer would otherwise have to dig for:

```
## Task N <title> - <short sha>
Produced: <names, files, env vars actually created, if different from or beyond the plan>
Deviated: <what changed from the plan and why, or none>
Next needs: <anything a later task must know, or omit>
```

If the conversation was summarized mid-build, read the plan's next task block and the ledger, nothing else, then continue.

If a step cannot run on this machine (no Docker, no /proc), write that in the ledger's Deviated line and carry it to the final report.

## Phase 4: Release gate

Run the repo's full gate (`npm run check:release` or equivalent) and any end-to-end check the plan names. Fix real failures in the owning task's files and commit with a ledger line. Keep the gate's summary: commands, pass or fail, counts.

## Phase 5: Final review

Launch `shipright:final-reviewer` with the chosen `model` and `effort`. Paste into its prompt: the plan's header (goal, Constraints, Review focus), the full ledger, the gate summary, the base branch and branch names, and the output of `git diff <base>...HEAD --stat`. Give the spec path only for the reviewer to open when a finding needs it.

Act on each finding: fix and commit with a ledger line, or say in the report why it stands. If a fix touched more than one task's files, rerun the gate.

## Phase 6: Pull request

Push the branch and open the pull request: the goal in one paragraph, the decisions worth a reviewer's attention, what was verified and how, what could not be verified and why, which models reviewed it, and links to the spec, plan and ledger under `.shipright/`. Bind the PR so CI is watched. Report to the user: branch, PR link, what passed, what is left.

## Rules

- Commits are local until Phase 6. Pushing before the final review skips the review.
- A task is done when its test passes, its review is clean or fixed, its ledger entry is written, and it is committed.
- Report outcomes faithfully. A skipped check is reported as skipped, with the reason.
