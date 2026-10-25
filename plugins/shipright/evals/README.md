# Shipright evals

Two cases run the skill through planning (Phase 0 and Phase 1) and stop before Phase 1b, so each run is a few minutes and most graders are plain regex on the plan file. Needs Claude Code 2.1.269 or newer.

| Case | What it proves |
| --- | --- |
| `greenfield-plan` | In an empty folder: the spec and plan are written, the plan has Gate, Branch, Code map, Constraints, a Review focus whose lines name tests, Done lines, no placeholders and no code; the gate was run once while planning; no app code was written. |
| `existing-repo-plan` | In a scaffolded Node project with a CLAUDE.md: an Explore agent ran before the plan; the gate is the repo's own test command; the Code map names the existing files to modify; the plan follows the repo's conventions. |

Run both, one run each (the default `--threshold` is 1.0, so every grader must pass):

```bash
claude plugin eval plugins/shipright --scaffold --allow-tools Write Edit Bash --runs 1 --max-cost-usd 10
```

`--scaffold` runs `existing-repo-plan/fixture.sh` as you (it only writes files). `Write`, `Edit` and `Bash` are granted so the skill can write the artifacts and run the gate dry run; everything runs under the eval's sandbox.

One case:

```bash
claude plugin eval plugins/shipright --case greenfield-plan --allow-tools Write Edit Bash --runs 1
```

Results land in `evals/results/<timestamp>/` (ignored by git). Add `--json out.json` for the raw scores.

Not covered yet: a full build (Phases 2 to 6). It needs an answer to the Phase 1b question, and the eval runner has no documented way to pre-answer `AskUserQuestion`.
