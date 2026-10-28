# superpowers-flow: speed profiles, runners and the slice bridge

Goal: let the user trade review depth for speed with one setting, run independent parts of a plan at the same time, and see child sessions in the agents panel.

## 1. Settings

One `profile` setting, plus one setting per knob. Every knob defaults to `profile` (follow the profile); any other value wins over the profile. `thorough` with every knob at `profile` leaves the skill text exactly as today.

| Setting | Values | thorough | balanced | fast |
| --- | --- | --- | --- | --- |
| `taskReview` | each, combined, final | each | combined | final |
| `parallel` | off, independent | off | independent | independent |
| `batchTasks` | off, small | off | small | small |
| `reReview` | always, self | always | self | self |
| `testScope` | full, targeted | full | targeted | targeted |
| `runner` | subagent, worktree, session | subagent | worktree | worktree |
| `reviewerTier` (existing, `auto`) | | auto | auto | light |
| `finalReviewTier` (existing, `auto`) | | auto (fable) | careful | careful |

`runner: session` is never picked by a profile; the user sets it.

Code: `hooks/tiers.ts` gains `PROFILES`, `effectiveOf(options)` and a skill section per knob; `plugin.json` declares the settings; `CONFIG_DEFAULTS` lists them for `/flow-config reset`.

### Choosing a profile at the plan's handoff

The mod rewrites superpowers:writing-plans as it loads (`skill.prompt`): its single Subagent-driven option becomes one per profile, with rules for recommending one from the spec and plan, and Native kept. The chosen profile goes in the first `progress` call (`profile`), which stores it on the flow for this run, answers with that profile's instructions, and makes the superpowers-flow skill load with it. A run profile wins over the saved profile, knobs and reviewer tiers; models, efforts and the coder tier stay as saved. A second question picks models per role for the run (Auto, Economy, Strong, or the user's words); `progress({ models })` stores them on the flow and in `_run.json`, briefs carry `Role: coder|reviewer|final`, and `agent.spawn` sets that role's model while `turn.step` sends its effort.

## 2. Runners

- **subagent**: today's flow. With `parallel: independent`, tasks whose dependencies are accepted and whose files do not overlap are dispatched together.
- **worktree**: the controller groups tasks into slices (a chain of dependent tasks), makes one git worktree and branch per slice (`git worktree add .worktrees/<slice>`), and puts `Worktree: <absolute path>` in every brief for that slice. The mod's `agent.spawn` hook reads that line and starts the worker in that directory (`cwd`). Slices without unaccepted dependencies run at once; each finished slice is merged into the feature branch, then the final review runs on the merged branch.
- **session**: as worktree, but each slice is a headless `claude -p` process started in its worktree, in the background. It runs the slice's tasks with subagents and reports through the bridge. The child is told not to start sessions of its own.

## 3. The slice bridge

- Location: `<git common dir>/superpowers-flow/<run-id>/<slice>.json` (`git rev-parse --path-format=absolute --git-common-dir`): shared by every worktree, never committed, independent of branches.
- Run id: `<date>-<branch>-<plan slug>`, made by the parent's first `progress` call and returned in its result.
- Child: `progress` takes `run` and `slice`; from then on the child's mod rewrites its own file (one file per slice, so writers never collide) with its title, done/total, phase, note, model, cost, tokens, start and update time.
- Parent: every 2 seconds while a flow is open, lists the run's folder, reads files that changed, and keeps them in a `slices` atom. The panel and `/flow-status` show each slice as a row (progress = its tasks done/total); planned tasks a slice reported are not listed again as planned.
- Child sessions in the panel: each report carries the child's own workers, listed under its row while it runs, with a **Log** button (end of `.worktrees/<slice>.log`, stream-json, in the transcript) and a **Stop** button (writes `<slice>.stop`; the child's tick finds it, reports stopped and ends its turn). `/flow-log` and `/flow-stop` do the same from any device.
- Launch: `claude -p ... --settings '{"env":{"SUPERPOWERS_FLOW_RUN":...,"SUPERPOWERS_FLOW_SLICE":...}}'`; the child reads the run's settings from `_run.json` and never starts slices of its own. Logs live in `.worktrees/`, since Claude Code guards writes under `.git/`.
- Cleanup: on session start, run folders whose slices are all finished and untouched for 3 days are removed.
- English only: the `language` setting and the Russian and Hebrew strings are gone.

## 4. Tests

- Unit (`claude plugin test`): profile resolution and the skill text for each knob; `Worktree:` line sets the spawn's `cwd`; a child's `progress({ run, slice })` writes its file; the parent reads slice files into the panel and `/flow-status`; cleanup of old finished runs.
- End to end, in this cloud container: two dummy apps (a Node CLI and a Python module) with small superpowers plans, run headless with superpowers and this plugin loaded from disk: `fast` + `worktree` on one, `session` on the other, and a `thorough` baseline for time. Check: tests pass on the merged branch, every task's change is there, worktree briefs ran in their worktree, slice files were written and finished.

## 5. Not in scope

- Child sessions in separate cloud containers (`create_session`): they share no disk with the parent, need the branch pushed first, and may lack the plugins. A later step could read their progress from their session events.
