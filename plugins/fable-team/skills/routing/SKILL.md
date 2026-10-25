---
name: routing
description: Use at the start of any task that is more than a tiny edit, before planning or delegating. Keeps the lead session (Fable) in charge and routes work to the fable-team subagents - Explore for local file discovery, research for outside docs, builder for a planned bounded change, reviewer for checking the result against the brief.
---

# Subagent routing

Keep Fable as the lead: plan, assign work and accept the result.
Use built-in Explore on Sonnet for local file discovery.
Use `fable-team:research` for outside docs and facts.
Use `fable-team:builder` once the files, approach and done criteria are clear.
Use `fable-team:reviewer` to check the finished change against the original brief.
Keep the custom agents on their configured models and effort.
Do not use Fable for workers.

Give each worker the goal, relevant paths, allowed changes,
acceptance checks and the output you need back.
Send concrete review findings back to builder, then recheck.
Handle tiny changes directly. Do not spawn every role for every task.

## Briefing a worker

Every brief names:

- the goal in one or two sentences, and the done criteria
- the files the worker may change (builder) or the scope it reviews (reviewer)
- the exact validation command, e.g. the project's single-test runner on the touched test file
- the output you need back, in the format the agent file defines

Workers never commit, push, deploy, install packages or run formatters. If a worker reports a blocker, bring it back to the user instead of working around it.

## Typical run

1. Explore finds the relevant paths and current behaviour. No edits.
2. The lead writes the brief. research is called only when an outside fact is missing.
3. builder implements and validates, and returns Changed / Files / Validation / Risks.
4. reviewer gets the original brief, the change set and the same validation command, and returns Findings / Validation / Risks.
5. The lead hands concrete findings back to builder, then rechecks, then accepts.
