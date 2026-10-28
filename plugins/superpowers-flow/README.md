# superpowers-flow

Live status for [superpowers](https://github.com/obra/superpowers) plan runs, adapted from johnnyvizz's [savvy-flow](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-flow), [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress) and [session-band](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/session-band) (MIT, [LICENSE-savvy](LICENSE-savvy)). Superpowers stays in charge of the flow; this plugin adds what you see while it runs and the workers it runs on.

- **Progress bar** above the prompt: the plan's name, phase, accepted tasks out of planned, and a crew button that opens the panel.
- **Session row** beneath it, from the first turn on: turn number, output speed of the last response, cost of the last turn and of the session, a countdown of the 1-hour prompt cache, and context fill. The row gets an amber frame 20 minutes before the cache expires and a red one at 10, and a notification (or a toast) at 10 and 5 minutes. `×` hides it for the session; `/flow-session` shows or hides it, `/flow-session demo <minutes>` previews the warning. Drawn by the same mod as the progress bar, so the two never cover each other.
- **On the phone**: a device attached over Remote Control sees the conversation, not the bar or the panel, so three things carry the run there. The skill writes one status line per accepted task (`Tasks 4/6 · next: Task 5 (sp-light)`); `/flow-status` answers with the panel as text, from any device; and with notifications on (`/flow-notify on`, or the `notify` setting), a push notification (or a toast when it cannot be delivered) at each accepted task, a failed worker and the finish. Pushes reach the phone when **Push when Claude decides** is on in `/config`.
- **Agents panel** (`/flow-agents` toggles it; `/flow-agents open` brings it forward): running, finished and planned subagents with model, effort, their own step progress, context, estimated cost and time. Every subagent brief gets a one-line request to report its steps, so superpowers' implementers and reviewers draw a progress bar of their own instead of a grey context bar.
- **Five tiered workers** that superpowers dispatches in place of `general-purpose` plus a model. The skill maps superpowers' Model Selection onto them:

| Superpowers says | Worker | Model / effort |
| --- | --- | --- |
| fast, cheap model | `sp-light` | Opus / low |
| standard model | `sp-medium` | Opus / medium |
| standard model, delicate execution | `sp-careful` | Opus / high |
| most capable, for understanding | `sp-heavy` | Opus / xhigh |
| most capable, for architecture and the final review | `sp-fable` | Fable / high |

Each tier draws its own crab in the panel. A plan task may name a tier (`tier: sp-careful`) to override the table, and the settings below can fix a tier per role and change each tier's model and effort.

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

Disable savvy-progress and session-band if they are installed: this plugin draws what both do, and session-band covers any band loaded after it.

## Settings

`language`: `auto` (default), `en`, `ru` or `he`. Hebrew draws the bar and the panel right to left.

`notify`: `off` (default) or `milestones`: whether a session starts with milestone notifications on. `/flow-notify on|off` changes it for the session.

`autoOpen`: `tier` (default) opens the panel when an `sp-*` worker starts or a plan is reported; `any` also opens it, once per session, when any other subagent starts.

**`/flow-config`** lists every setting with its value and choices, and changes them anywhere: the desktop app (with or without its Settings tab), the terminal, a session over SSH, or the phone. `/flow-config coderTier=medium mediumModel=sonnet` saves both and the running session uses them from the next worker on; `/flow-config reset` puts everything back to the defaults. It writes the same values the Settings tab does.

**Roles and tiers.** `coderTier`, `reviewerTier` and `finalReviewTier` fix the tier each role runs on: `auto` (default) lets the skill choose by task difficulty, or one of `light`, `medium`, `careful`, `heavy`, `fable`. A fixed coder tier is the starting tier; a stuck coder is still re-dispatched one tier up. `<tier>Model` (`haiku`, `sonnet`, `opus`, `fable`) and `<tier>Effort` (`low` … `max`) change what a tier runs on; `default` keeps the agent file's. The mod applies them when each worker starts, and the panel shows them on planned rows. Settings are read when a session starts.

The settings page in the desktop app saves values for sessions on that computer only. On another machine, such as one you reach over SSH, put them in its `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "superpowers-flow@code101-plugins": {
      "options": {
        "coderTier": "medium",
        "reviewerTier": "careful",
        "finalReviewTier": "fable",
        "mediumModel": "sonnet",
        "mediumEffort": "high",
        "autoOpen": "any"
      }
    }
  }
}
```

## What it contains

| Part | Name |
| --- | --- |
| Skill | `superpowers-flow`, picked up when a superpowers plan runs with subagents |
| Agents | `sp-light`, `sp-medium`, `sp-careful`, `sp-heavy`, `sp-fable` |
| Settings | `hooks/tiers.ts`: role and tier settings, and the skill section they add |
| Mod | `hooks/register.tsx`: the bar, the panel, the `progress` and `step` tools, `/flow-agents`, `/flow-status`, `/flow-notify`, `/flow-config`; `hooks/session.tsx`: the session row and `/flow-session` |

The mod is built on function hooks, an early-access Claude Code API that may change between releases. Tests run with `claude plugin test plugins/superpowers-flow`.
