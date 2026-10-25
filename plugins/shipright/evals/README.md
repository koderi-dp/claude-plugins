# Shipright evals

Two cases run the skill through planning (Phase 0 and Phase 1) and stop before Phase 1b, so each run is a few minutes and most graders are plain regex on the plan file. Needs Claude Code 2.1.269 or newer and a CLI login (`claude login`): the runner spawns child `claude` processes on the CLI's own credential.

| Case | What it proves |
| --- | --- |
| `greenfield-plan` | In an empty folder: the spec and plan are written, the plan has Gate, Branch, Code map, Constraints, a Review focus whose lines name tests, Done lines, no placeholders and no code; no app code was written. |
| `existing-repo-plan` | With a small Node project supplied read-only (`resources/notes-cli`, with a CLAUDE.md): an Explore agent ran before the plan; the gate is the repo's own test command; the Code map names the existing files to modify; the plan follows the repo's conventions. |

Run both, one run each (the default `--threshold` is 1.0, so every grader must pass; `--ablation none` skips the no-plugin baseline arm, which halves the cost):

```bash
claude plugin eval plugins/shipright --allow-tools Write Edit --runs 1 --ablation none --max-cost-usd 10
```

`Write` and `Edit` are granted so the skill can write the spec and plan. No shell is granted: the runner refuses a shell grant on Windows, where it has no sandbox, so the prompts tell the skill to skip the gate dry run and record that. On Linux or macOS you can add `Bash` to the grant and the dry run happens, but no grader checks it.

One case:

```bash
claude plugin eval plugins/shipright --case greenfield-plan --allow-tools Write Edit --runs 1 --ablation none
```

Results land in `evals/results/<timestamp>/` (ignored by git). Add `--json out.json` for the raw scores.

Known limits:

- The existing-project fixture is static files under `add_dirs`, not a `scaffold_script`: on Windows the runner strips the backslashes from the script path it hands to bash, so no scaffold runs there.
- A full build (Phases 2 to 6) is not covered. It needs an answer to the Phase 1b question, and the runner has no documented way to pre-answer `AskUserQuestion`.
