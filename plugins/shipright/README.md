# shipright

Ship it right: build a feature in one Claude Code session, from design to pull request, fast.

- **Spec and lean plan.** The agreed design goes to `.shipright/specs/`. The plan in `.shipright/plans/` holds decisions only: files, exact signatures, test assertions, the one judgment call per task. No code is written twice.
- **Your models.** The session you start it in writes the code on its current model. After the plan, you pick model and effort once for the per-task review and the final review.
- **Task by task on a feature branch.** Test and code, a fast review by a read-only agent (skipped when the plan has two tasks or fewer), then a local commit with a short entry in `.shipright/ledger.md` that the next task reads instead of rescanning the branch.
- **One full review before the pull request.** The release gate runs, a final reviewer checks the whole branch from the plan header, the ledger and the diff, and only then is the branch pushed and the pull request opened.
- **Live progress pane.** A pane shows the phase, a progress bar, the task list, time elapsed and time left. Plugin hooks keep it current by watching the session's own tool calls, so the session spends nothing on it.

## Install

At the prompt of a terminal session:

```
/plugin install shipright --marketplace koderi-dp/claude-plugins
```

From a shell:

```bash
claude plugin install shipright --marketplace koderi-dp/claude-plugins
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `koderi-dp/claude-plugins`, then Add plugin.

## Use

```
/shipright add CSV export to the reports page
```

Open the progress pane any time with `/shipright-progress`. It also opens by itself when a run starts, and picks an unfinished run back up from `.shipright/` after a restart.

## What it contains

| Part | Name |
| --- | --- |
| Slash command | `/shipright` |
| Skill | `shipright` |
| Per-task reviewer | `shipright:task-reviewer` |
| Final reviewer | `shipright:final-reviewer` |
| Progress pane | `/shipright-progress` |
