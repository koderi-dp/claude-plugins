# superpowers-flow

Faster, visible [superpowers](https://github.com/obra/superpowers) plan runs. Superpowers stays in charge of the flow; this plugin adds:

- **Speed profiles**: `thorough` (superpowers as it ships), `balanced` and `fast`, plus the models per role, chosen when superpowers asks how to run a plan.
- **Parallel slices**: independent parts of a plan run at the same time, in git worktrees or in their own Claude Code sessions.
- **A live view**: a progress bar above the prompt, a session row (turn, speed, cost, cache countdown, context) and an agents panel with every worker's model, steps, cost and time.
- **EGM handoff**: an approved [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model) design goes straight to a superpowers build.

## Install

Needs Claude Code v2.1.287 or later (`claude --version`; `claude update` updates it) and the superpowers plugin.

```bash
claude plugin install superpowers-flow --marketplace koderi-dp/claude-plugins
```

At a terminal session's prompt: `/plugin install superpowers-flow --marketplace koderi-dp/claude-plugins`. In the desktop app: + next to the prompt box, Plugins, Add marketplace `koderi-dp/claude-plugins`, then Add plugin.

If savvy-progress or session-band is installed, disable it: this plugin draws what both do.

## Update

```bash
claude plugin marketplace update code101-plugins
claude plugin update superpowers-flow@code101-plugins
```

Then start a new session (or run `/reload-plugins`). `claude plugin list` shows the installed version. In the desktop app, update from the Plugins menu.

## How to use it

### Plan and build a feature

```text
I want to add CSV export to the todo CLI. Let's brainstorm it with superpowers.
```

Superpowers brainstorms, writes a spec and a plan, then asks how to run it. With this plugin the question is:

> **Which execution approach?**
> - Subagent-driven · balanced (Recommended): one reviewer per task, independent slices in parallel worktrees
> - Subagent-driven · fast: no per-task reviews, only the final review
> - Subagent-driven · thorough: superpowers as it ships
> - Native: Claude implements everything in this session
>
> **Models for this run?** Auto (Recommended) · Economy · Strong · or say your own

Pick one; the run starts and the panel opens.

### Run a plan you already have

```text
Execute docs/superpowers/plans/2026-10-28-csv-export.md with subagents.
Run it fast, with Economy models.
```

```text
Run this plan balanced; coders on sonnet medium, final review on fable high.
```

```text
Skip task reviews for this run.          (fast for this run only)
Continue the plan from where it stopped.  (superpowers resumes from its ledger)
```

### Design with EGM first

For features with real design decisions (APIs, data models, anything others depend on), install EGM (`claude plugin install egm@egm`) and run its steps:

```text
/egm:egm-brainstorm Add webhook delivery to this project.
/egm:egm-draft
/egm:egm-review docs/designs/webhooks.md
```

When the review ends, Claude asks **Build this design with superpowers?** (fast, balanced, thorough, or resolve the open findings first) and the models. Superpowers plans the build from the design without reopening its decisions. Afterwards, `/egm:egm-drift-report` checks the code still matches the design. Small, clear features need no EGM.

### Run each slice in its own session

```text
/flow-config runner=session
```

The next run starts one headless Claude Code session per independent slice. The panel shows each one with its tasks, current step and workers, and **■ Stop** and **Log** buttons. From any device:

```text
/flow-log email      the end of slice "email"'s log
/flow-stop email     stop it; its branch and commits stay
```

### Watch and control

| Command | Does |
| --- | --- |
| `/flow-agents` | Opens or closes the agents panel (`/flow-agents open` brings it forward) |
| `/flow-status` | The panel as text: works on a phone over Remote Control |
| `/flow-notify on` | A push notification at each accepted task, a failed worker and the finish |
| `/flow-session` | Shows or hides the session row (`/flow-session demo 12` previews the cache warning) |
| `/flow-config` | Lists and changes every setting (below) |

## Speed profiles

| | `thorough` (default) | `balanced` | `fast` |
| --- | --- | --- | --- |
| Reviews after each task | superpowers' own | one reviewer | none: only the final review |
| Independent tasks | one at a time | in parallel worktrees | in parallel worktrees |
| Small mechanical tasks | one worker each | batched | batched |
| Small fixes checked by | a reviewer | Claude | Claude |
| Tests per task | full suite | the task's own, full suite at the end | the task's own, full suite at the end |
| Final review on | `sp-fable` | `sp-careful` | `sp-careful` |
| Use it for | risky code: security, money, migrations, public APIs | everyday work | mechanical, well-specified plans |

On a 4-task test plan, `fast` finished in 3.6 minutes against 11.7 for `thorough`, at less than half the cost.

## Settings

Change them with `/flow-config` (desktop, terminal, SSH or phone) or the plugin's Settings tab:

```text
/flow-config                                  list every setting, its value and choices
/flow-config profile=balanced                 the default profile
/flow-config profile=fast taskReview=combined fast, but one reviewer per task
/flow-config lightModel=sonnet mediumEffort=high
/flow-config reset                            back to the defaults
```

| Setting | Values |
| --- | --- |
| `profile` | `thorough` (default), `balanced`, `fast` |
| `taskReview`, `parallel`, `batchTasks`, `reReview`, `testScope` | the profile's single knobs; `profile` (default) follows it, any other value wins |
| `runner` | `subagent`, `worktree` (balanced and fast), `session` (set it yourself) |
| `coderTier`, `reviewerTier`, `finalReviewTier` | `auto` (default) or a tier: `light`, `medium`, `careful`, `heavy`, `fable` |
| `<tier>Model`, `<tier>Effort` | `haiku`, `sonnet`, `opus`, `fable`; `low` … `max`; `default` keeps the agent file's |
| `notify` | `off` (default), `milestones` |
| `autoOpen` | `tier` (default) opens the panel for `sp-*` workers; `any` for any subagent |

A profile or models chosen at a plan's handoff apply to that run only and win over the saved settings.

On a machine without the desktop app, put settings in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "superpowers-flow@code101-plugins": {
      "options": { "profile": "balanced", "mediumModel": "sonnet", "notify": "milestones" }
    }
  }
}
```

## How it works

<details>
<summary>Workers, runners, child sessions and the panel</summary>

**Tiered workers.** Superpowers dispatches five `sp-*` workers in place of `general-purpose` plus a model:

| Superpowers says | Worker | Model / effort |
| --- | --- | --- |
| fast, cheap model | `sp-light` | Opus / low |
| standard model | `sp-medium` | Opus / medium |
| standard model, delicate execution | `sp-careful` | Opus / high |
| most capable, for understanding | `sp-heavy` | Opus / xhigh |
| most capable, for architecture and the final review | `sp-fable` | Fable / high |

A plan task may name a tier (`tier: sp-careful`). A stuck coder is re-dispatched one tier up. Models chosen for a run reach each worker through a `Role: coder|reviewer|final` line in its brief.

**Runners.** A slice is a chain of tasks that depend on each other.

- `subagent`: workers in this session, one folder; with `parallel`, tasks whose files do not overlap run together.
- `worktree`: one git worktree and branch per slice (`.worktrees/<slice>`), merged into the feature branch when done; the final review runs on the merged branch.
- `session`: one headless `claude -p` per slice in its worktree. Each reports to `.git/superpowers-flow/<run>/` (shared by every worktree, never committed, removed 3 days after the run finishes) and logs to `.worktrees/<slice>.log`. A slice silent for 5 minutes shows as failed. A headless session cannot ask for permission: it runs on your permission rules, in this session's mode when that is `acceptEdits`, `auto`, `dontAsk` or `bypassPermissions`; otherwise Claude asks you first.

**The panel** draws every running worker, the latest 8 finished (Show more: 24), the next 8 planned and up to 3 running workers per child session, and counts the rest, so long runs keep drawing; `/flow-status` lists everything. Costs are estimates from token counts (`PRICES` in `hooks/register.tsx`), not a bill.

</details>

| Part | Where |
| --- | --- |
| Skill | `skills/superpowers-flow`, used when a superpowers plan runs with subagents |
| Agents | `agents/sp-light.md` … `agents/sp-fable.md` |
| Profiles, settings, handoff texts | `hooks/tiers.ts` |
| Child-session files | `hooks/bridge.ts` |
| Bar, panel, tools and commands | `hooks/register.tsx`, `hooks/session.tsx` |

Built on function hooks, an early-access Claude Code API that may change between releases. Tests: `claude plugin test plugins/superpowers-flow`.

Adapted from johnnyvizz's [savvy-flow](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-flow), [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress) and [session-band](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/session-band) (MIT, [LICENSE-savvy](LICENSE-savvy)).
