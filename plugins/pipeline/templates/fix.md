<!-- Placeholders: {{item}} item id · {{n}} task number · {{title}} task title · {{round}} this fix round · {{max}} config limits.fixRounds · {{findings}} the findings, verbatim from the lead's diff reading or the reviewer's verdict · {{checkFast}} config checks.fast · {{checkTask}} config checks.task · {{attribution}} the attribution lines the session was given -->

# {{item}} · task {{n}}: {{title}} · fix round {{round}} of {{max}}

You implemented this task; the same worktree and branch, your commit is in place. Fix what is listed below, nothing else.

## Findings

{{findings}}

## How to work

1. Scope is the findings. A Critical or Important finding needs a test that fails before your fix and passes after it; say which test.
2. Run `{{checkFast}}` after every edit and `{{checkTask}}` before you hand back.
3. Commit as soon as tests pass, one commit for the round, message `fix: <task title>, round {{round}}`. Never amend or rewrite the earlier commit.
4. Nothing under `docs/pipeline/` is yours.
5. A finding you believe is wrong: do not fix it, say why in the report with the evidence; the lead decides.

## Report

- **Fixed**: each finding, what changed, the commit hash.
- **Disputed**: findings you did not fix, with the evidence.
- **Test evidence**: commands and counts, pasted.
- **For the reviewer**: lines a scoped re-review should look at.

No model identifier goes into commits, PR text or comments. End your commit message with these lines exactly:

{{attribution}}
