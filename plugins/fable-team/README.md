# fable-team

Give Fable a team. One command, `/fable-team:init`, sets a project up the way the "Give Fable a team" field guide (FounderOS, September 2026) describes: three worker agents in the project's `.claude/agents/` and a `## Subagent routing` section in its `CLAUDE.md`. The plugin registers no agents or routing of its own, so it can stay enabled everywhere and only acts when you call it.

| Agent written | Model | Effort | Role |
| --- | --- | --- | --- |
| `research` | sonnet | medium | Outside docs, APIs and changelogs. Read-only, returns Answer / Evidence / Caveats / Recommendation. |
| `builder` | opus | medium | Implements a planned, bounded change on assigned files only, runs the checks, returns Changed / Files / Validation / Risks. |
| `reviewer` | opus | medium | Reviews the finished change against the original brief, runs the checks itself, returns Findings / Validation / Risks. Never implements. |

Local file discovery uses the built-in Explore agent, which needs no file.

## Install

At the prompt of a terminal session:

```
/plugin install fable-team --marketplace koderi-dp/claude-plugins
```

From a shell:

```bash
claude plugin install fable-team --marketplace koderi-dp/claude-plugins
```

If the marketplace is already added, address the plugin by marketplace name instead:

```bash
claude plugin marketplace update code101-plugins
claude plugin install fable-team@code101-plugins
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `koderi-dp/claude-plugins`, then Add plugin.

## Use

In a Claude Code session started in the project:

```
/fable-team:init
```

It writes `.claude/agents/builder.md`, `research.md` and `reviewer.md` and appends the section below to `CLAUDE.md`, creating the file if needed. Existing files or an existing routing section that differ are left alone and reported; rerun with `--force` to replace them. Nothing is committed.

Project agents are read when a session starts, so end the session and start a new one in the project. `/agents` then lists `builder`, `research` and `reviewer`.

The routing section the lead follows:

```markdown
## Subagent routing

Keep Fable as the lead: plan, assign work and accept the result.
Workers run on Opus or Sonnet, on their configured models and effort.
Never use Fable for any subagent.
Handle tiny changes directly. Do not spawn every role for every task.

### Agents

- **Explore** (built-in, Sonnet): local file discovery.
- **research:** docs and outside info.
- **builder:** implementation from a brief, once files, approach and done criteria are clear.
- **reviewer:** an independent check of the finished change against the original brief.

### Brief

Before launching a subagent, include:

- **Goal:** what to do and what finished looks like.
- **Scope:** relevant files or sources, what it can change.
- **Context:** what we already know and what we've tried.
- **Return:** a short result with evidence, checks performed.

Send concrete review findings back to builder, then recheck.
```

A first brief, from the guide:

```
Use Explore to find the signup form and its validation. Return the paths and
current behaviour, no edits. Then write a brief: reject an invalid email and
show an inline error. Name the allowed files and the exact validation command.
Delegate the change to builder, then give reviewer the brief, the change set
and the same command. If either reports a blocker, bring it back to me.
```

## Layout

| Path | Holds |
| --- | --- |
| `skills/init/SKILL.md` | The `/fable-team:init` skill |
| `scripts/init.mjs` | The copy and CLAUDE.md update, idempotent, keeps CRLF files CRLF |
| `templates/*.md` | The three agent files, kept outside `agents/` so the plugin registers none |

## Troubleshooting

- Agents missing after init: start a new session in the project. Then check `.claude/agents/` has the three `.md` files with their opening `---` block.
- Unexpected model: check `/tasks` for a model override on the call.
- An older project copy differs from the plugin's: `/fable-team:init --force` replaces it.
