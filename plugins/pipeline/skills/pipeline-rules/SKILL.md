---
name: pipeline-rules
description: Use in a project that has docs/pipeline/config.json when you are about to touch the backlog, a spec or a ledger outside a pipeline run and are unsure which tool action does it. Says which files the mcp__pipeline__pipeline tool owns, where the project's state is read from, and how a request becomes an item.
---

# pipeline-rules

This project runs on the pipeline plugin: a backlog, and a tool (`mcp__pipeline__pipeline`) that takes an item from request to merged pull request. How to build is yours; these are the few things the plugin needs.

- **The tool owns its files.** `backlog.json`, `BACKLOG.md`, `facts.md` and `ledgers/<id>.json` under `docs/pipeline/` change only through the tool (`add`, `update`, `move`, `remove`, `park`, `unpark`, `ledger`, and the run's own actions). An edit of one, or a shell command that writes one, is refused. Specs, `rules.md` and `config.json` are ordinary files.
- **Where things stand comes from the tool**, never from memory: `get` for the active item and what is next, `status` for the whole block or one item's record.
- **A new request** goes through the intake skill and becomes an item; `add` takes the spec text in the same call. A build starts only on `/pipeline next`, `/pipeline run <id>` or `/pipeline run all`, or when the user asks in words.
- **Statuses**: `inbox`, `ready`, `planning`, `building`, `review`, `merged`, `blocked`, `parked`. An item is `ready` once its spec has no open question and every item it needs is merged.
- **`docs/pipeline/rules.md`**, when it lists rules, holds the project's own; follow them in the work.
- **Several sessions** can run on one repository: each claims its own item, and a write may wait a moment for another session's.
- No model identifier goes into commits, PR text or comments.

## With queue: github

When `config.queue` is `github`, the open issues with the queue label are the backlog, an issue number is the id, and only `config.json` and `rules.md` stay under `docs/pipeline/`. The rules above hold for these files:

| File | Written by | Committed |
| --- | --- | --- |
| `docs/pipeline/config.json`, `docs/pipeline/rules.md` | you or the user, by hand | yes, on `mainBranch` |
| The issue's spec comment and labels | the tool (`add`, `spec`, `question`, `answer`, `update`, `park`, `unpark`, `begin`, `close`) | on GitHub |
| A pull request that was opened without an issue | the tool: `adopt` with `pr`; it creates the issue, records the branch and the pull request and sets review | on GitHub |
| Closing an issue that will not be built | the tool: `remove` with `id` and `text`, the reason; it closes the issue as not planned and writes the reason on it | on GitHub |
| The issue's title, body and `Needs:` line | the tool: `update` with `set: { title?, body?, needs? }`; a new body keeps the dependencies unless `needs` is given, `needs: []` removes them | on GitHub |
| `.git/pipeline/issues.json`, `items.json`, `facts.md`, `<id>/ledger.json` | the tool only | never |
| `<worktree>/.pipeline/<id>/spec.md` | the tool, at `begin` and `spec` | never |
| `<worktree>/.pipeline/<id>/plan.md` | you | never |
| `<worktree>/.pipeline/<id>/` briefs; reports | the tool; the subagents | never |

`.pipeline/` is ignored through `.git/info/exclude`, so `git status` shows none of it. Never write under `.git/pipeline/` and never change an issue with `gh` yourself: the tool's actions do both. There is no `move` in this mode. An item is `ready` once its issue has a spec comment, no open question, and no open issue named on a `Needs: #12` line of its body.
