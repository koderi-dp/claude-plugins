<!-- Placeholders: {{item}} item id · {{title}} item title · {{base}} the merge base commit · {{head}} the branch head · {{acceptance}} the spec's Acceptance checklist, verbatim · {{rulings}} the ledger's rulings, numbered · {{parked}} what the plan parked, or "nothing" · {{checkGate}} config checks.gate · {{rules}} the "before the PR" group of rules.md · {{attribution}} the attribution lines the session was given -->

# {{item}} · final review: {{title}}

You are the final reviewer, read-only: no edit, no commit, nothing under `docs/pipeline/`. Probes run in a scratch copy you remove when done.

## What to read, all of it

- The whole diff: `git diff {{base}}..{{head}}`, every file, not a sample.
- The plan `docs/pipeline/plans/{{item}}.md` and the spec `docs/pipeline/specs/{{item}}.md`.
- The rulings below: each one is a decision the lead made during the build; check that the code keeps it.

## Rulings

{{rulings}}

Parked: {{parked}}

## What to do

1. **Acceptance, line by line.** Copy the list below and tick each line only when you can name the file and test that proves it. A line you cannot prove is `MISSING`, with what is absent.

{{acceptance}}

2. **Worst-case failure, traced end to end.** Name the single worst thing this change can do in production (lost data, a wrong amount, an open door, a stuck job). Follow it from the input through every function in the diff to the effect, and say what stops it, or that nothing does.
3. **Across tasks.** Each task was reviewed alone; look at the seams: a name one task produces and another consumes, a migration and its reader, an error that one layer throws and the next swallows.
4. **Run `{{checkGate}}`** in the scratch copy and paste the result. The lead runs it again; your run catches what depends on a clean tree.

## Project rules before the PR

{{rules}}

## Verdict

- **Verdict**: `APPROVED` or `FIX REQUIRED`
- **Acceptance**: the ticked list, each line with its proof or `MISSING`.
- **Critical** / **Important** / **Minor**: as for a task review, each with file, line, what is wrong, how to show it.
- **Worst case**: the trace from step 2.
- **Gate**: the command and its output.

Any Critical, Important or MISSING line means `FIX REQUIRED`. No model identifier goes into commits, PR text or comments.

{{attribution}}
