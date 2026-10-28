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

If the user asks for a faster run without per-task reviews ("skip task reviews", "review only at the end"), run it as the `taskReview: final` setting does: no spec or quality reviewer per task, accept a task once its tests pass and its self-review is clean, and let the final whole-branch review check every task against the plan. "One reviewer per task" means `combined`: spec and quality in a single review. The user's words for this run win over the settings. A profile the user picks for this run (at the plan's handoff, or in their own words: "run it fast") goes in the first `progress` call as `profile`; its result carries that profile's instructions, which win over the settings section below. Models they pick for the run go in the same call as `models`: `"economy"`, `"strong"`, or `{ coder, reviewer, final }` with each `{ model, effort }` for what they named ("coders sonnet medium"); the result says how to mark the briefs. A saved profile or another runner is set with `/flow-config profile=fast` (or `runner=...`).

Pass the task's title as the Agent tool's `description` and reuse it verbatim on a resume or re-review: the panel matches runs to planned tasks by it.

## 2. Progress bar

`mcp__superpowers-flow__progress` is in your tool list; it needs no loading. Call it **before the first dispatch**, whatever brought you there: a plan just written, or a resumed run picked up from the ledger. Without that first call the bar only shows what it counts by itself.

- First call: `title` (the plan's name, a few words), `total` (number of implementation tasks), `done` (tasks the ledger already marks accepted; 0 on a fresh run), `tasks` (`[{ title, tier, after }]` in plan order, `tier` without the `sp-` prefix, `after` the numbers of the tasks it waits for), `phase: "delegate"`.
- Each time a task's review accepts it: `done`. `phase: "review"` while a task review or the final review runs, back to `"delegate"` at the next dispatch.
- If the plan changes mid-run: the new `tasks` and `total`.
- Once the branch is finished: `finished: true`.

Fields left out keep their previous value. Workers report their own steps; the mod adds that request to every subagent brief, so you add nothing to the templates.

## 3. Status line

Phones and browsers attached through Remote Control see the conversation, not the bar or the panel. So each time a task is accepted, write one line in your reply, nothing more: `Tasks 4/6 · next: Task 5 (sp-light)`, or `Tasks 6/6 · final review (sp-careful)` once the last one is in. That line is the whole narration for the step; the ledger holds the record.

`/flow-status` answers with the panel's content as text, on any device.

`/flow-agents` opens or closes the panel; `/flow-agents open` brings it forward.
