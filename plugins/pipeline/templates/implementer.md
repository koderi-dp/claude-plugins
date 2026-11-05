<!-- Placeholders: {{item}} item id · {{n}} task number · {{total}} task count · {{title}} task title · {{task}} the task from the plan, verbatim · {{owned}} files this task may change · {{forbidden}} files it must not touch · {{pinned}} names and signatures pinned by the plan · {{carried}} minor findings carried from the previous task, or "none" · {{checkFast}} config checks.fast · {{checkTask}} config checks.task · {{rules}} the "in every implementer brief" group of rules.md · {{attribution}} the attribution lines the session was given -->

# {{item}} · task {{n}} of {{total}}: {{title}}

Repository: the worktree you start in, on the item's branch. Never switch branches, never push.
Plan: `docs/pipeline/plans/{{item}}.md`; spec: `docs/pipeline/specs/{{item}}.md`. Read the plan's Global Constraints and your task before writing anything.

## The task

{{task}}

## Files

- You own: {{owned}}
- You must not touch: {{forbidden}}, and nothing under `docs/pipeline/` (backlog, ledgers, specs, plans and rules are the lead's).
- Pinned names and signatures, keep them exactly: {{pinned}}

## Carried from the previous task

{{carried}}

## How to work

1. Tests first, then implement until they pass. Run `{{checkFast}}` after every edit and `{{checkTask}}` before you hand back.
2. Commit as soon as tests pass, one commit for the task, with the message the plan names. Do not wait for the report: a restart kills agents and an uncommitted tree is lost.
3. Stay inside the task. Something adjacent that is wrong goes into the report under gaps noticed, not into the diff.
4. A question only the lead can answer: stop, say it in the report, do not guess.

## Project rules for implementers

{{rules}}

## Report

Answer with exactly these headings:

- **What changed**: files and the commit hash.
- **Deviations**: anything done differently from the task, and why.
- **Test evidence**: the commands you ran and their counts, pasted, not summarised.
- **Gaps noticed**: what you saw and did not fix.
- **For the reviewer**: the lines that need a second pair of eyes, by file and line.

No model identifier goes into commits, PR text or comments. End your commit message with these lines exactly:

{{attribution}}
