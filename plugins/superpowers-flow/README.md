# superpowers-flow

Live status for [superpowers](https://github.com/obra/superpowers) plan runs, adapted from johnnyvizz's [savvy-flow](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-flow) and [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress) (MIT, [LICENSE-savvy](LICENSE-savvy)). Superpowers stays in charge of the flow; this plugin adds what you see while it runs and the workers it runs on.

- **Progress bar** above the prompt: the plan's name, phase, accepted tasks out of planned, and a crew button that opens the panel.
- **Agents panel** (`/flow-agents` toggles it; `/flow-agents open` brings it forward): running, finished and planned subagents with model, effort, their own step progress, context, estimated cost and time. Every subagent brief gets a one-line request to report its steps, so superpowers' implementers and reviewers draw a progress bar of their own instead of a grey context bar.
- **Five tiered workers** that superpowers dispatches in place of `general-purpose` plus a model. The skill maps superpowers' Model Selection onto them:

| Superpowers says | Worker | Model / effort |
| --- | --- | --- |
| fast, cheap model | `sp-light` | Opus / low |
| standard model | `sp-medium` | Opus / medium |
| standard model, delicate execution | `sp-careful` | Opus / high |
| most capable, for understanding | `sp-heavy` | Opus / xhigh |
| most capable, for architecture and the final review | `sp-fable` | Fable / high |

Each tier draws its own crab in the panel. A plan task may name a tier (`tier: sp-careful`) to override the table.

Cost is a rough estimate from token counts and a per-model price table (`PRICES` in `hooks/register.tsx`), not a bill.

## Install

At the prompt of a terminal session:

```
/plugin install superpowers-flow --marketplace koderi-dp/claude-plugins
```

From a shell:

```bash
claude plugin install superpowers-flow --marketplace koderi-dp/claude-plugins
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `koderi-dp/claude-plugins`, then Add plugin.

Disable savvy-progress if it is installed: both mods draw a bar and a panel.

## Settings

`language`: `auto` (default), `en`, `ru` or `he`. Hebrew draws the bar and the panel right to left.

`autoOpen`: `tier` (default) opens the panel when an `sp-*` worker starts or a plan is reported; `any` also opens it, once per session, when any other subagent starts.

```json
{ "pluginConfigs": { "superpowers-flow": { "options": { "autoOpen": "any" } } } }
```

## What it contains

| Part | Name |
| --- | --- |
| Skill | `superpowers-flow`, picked up when a superpowers plan runs with subagents |
| Agents | `sp-light`, `sp-medium`, `sp-careful`, `sp-heavy`, `sp-fable` |
| Mod | `hooks/register.tsx`: the bar, the panel, the `progress` and `step` tools, `/flow-agents` |

The mod is built on function hooks, an early-access Claude Code API that may change between releases. Tests run with `claude plugin test plugins/superpowers-flow`.
