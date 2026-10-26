---
name: superpowers-flow
description: Use whenever a superpowers plan is run with subagents (subagent-driven-development, the final review of executing-plans, dispatching-parallel-agents) and the Agent tool lists sp-light, sp-medium, sp-careful, sp-heavy or sp-fable. Picks the sp-* tier worker for each dispatch in place of general-purpose plus a model, and keeps the progress bar and agents panel current.
---

# superpowers-flow

Superpowers stays in charge: its skills decide what to dispatch, in what order, with which brief, and how reviews gate the work. This skill only changes two things at each dispatch: **which agent** runs the task, and **what the progress bar shows**.

## 1. Tier instead of model

Superpowers' Model Selection names a model per role. Translate it into a worker and pass no `model` and no `effort`: the worker fixes both, and a `model` on the call would override the tier.

| Superpowers says | `subagent_type` | Runs on |
| --- | --- | --- |
| fast, cheap model (mechanical task, clear spec, 1-2 files) | `sp-light` | Opus / low |
| standard model (integration, judgment, debugging with a known cause) | `sp-medium` | Opus / medium |
| standard model, but delicate: multi-file refactor, invariants, many edge cases | `sp-careful` | Opus / high |
| most capable model for understanding: unfamiliar or messy code, unclear root cause | `sp-heavy` | Opus / xhigh |
| most capable model: architecture, the final whole-branch review, a bug that survived sp-heavy | `sp-fable` | Fable / high |

Use the name exactly as the Agent tool lists it: `sp-medium`, or `superpowers-flow:sp-medium` when the agents ship in the plugin. Uncertain between two tiers, take the higher. A plan task that names a tier (`tier: sp-careful`) wins over the table. Reviewers follow the same table, scaled to the diff: a small mechanical diff reviews on `sp-light` or `sp-medium`, a subtle one on `sp-careful` or above.

Keep superpowers' prompt templates as they are; only the `Subagent (general-purpose)` line and the `model:` line change. Explore agents for wide searches stay as they are.

Pass the task's title as the Agent tool's `description` and reuse it verbatim on a resume or re-review: the panel matches runs to planned tasks by it.

## 2. Progress bar

`mcp__superpowers-flow__progress` is in your tools, deferred: load it once with ToolSearch (`select:mcp__superpowers-flow__progress`). Skip silently only if ToolSearch does not find it. Call it:

- when the plan is read and the dispatch order is known: `title` (the plan's name, a few words), `total` (number of implementation tasks), `tasks` (`[{ title, tier, after }]` in plan order, `tier` without the `sp-` prefix, `after` the numbers of the tasks it waits for), `phase: "delegate"`;
- while brainstorming or writing the plan, if this skill is active then: `phase: "plan"`;
- each time a task's review accepts it: `done` (accepted so far); `phase: "review"` while a task review or the final review runs, back to `"delegate"` when the next task is dispatched;
- if the plan changes mid-run: the new `tasks` and `total`;
- once the branch is finished: `finished: true`.

Fields left out keep their previous value. Workers report their own steps; the mod adds that request to every subagent brief, so you add nothing to the templates.

`/flow-agents` opens or closes the panel; `/flow-agents open` brings it forward.
