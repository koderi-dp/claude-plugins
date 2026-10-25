---
name: init
description: Use when the user asks to set up, install or initialise the Fable subagent team in a project so it works without the plugin - copies builder, research and reviewer into the project's .claude/agents and adds the Subagent routing section to its CLAUDE.md.
---

# fable-team init

Set up the current project the way the "Give Fable a team" guide describes: three agent files under `.claude/agents/` and a `## Subagent routing` section in `CLAUDE.md`. Once done, the project no longer needs the fable-team plugin.

## Steps

1. Confirm the project root. It is the current working directory unless the user named another folder. Create the folder first if the user asked for a new project.
2. Run the setup script from the plugin:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" "<project root>"
   ```

   It copies `templates/builder.md`, `templates/research.md` and `templates/reviewer.md` into `<project root>/.claude/agents/`, and appends the routing section to `CLAUDE.md`, creating the file when it is missing. It never overwrites a differing file or section unless `--force` is passed.
3. Read the script's report. For every line marked `kept`, tell the user what differs and ask whether to rerun with `--force`. Do not pass `--force` on your own.
4. If `node` is not available, do the same by hand: copy the three files from `${CLAUDE_PLUGIN_ROOT}/templates/` with the Read and Write tools, keeping the opening `---` block intact, and add the section below to `CLAUDE.md`.
5. Tell the user, in its own paragraph so it is not missed, that project agents are read only at session start: they must end this session and start a new one in the project before `builder`, `research` and `reviewer` appear in `/agents`. The plugin registers no agents itself, so it can stay enabled.

Do not commit. The user decides when the new files go into git.

## The routing section

The project copies use bare agent names, because project agents are not namespaced:

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

If `CLAUDE.md` already has an older routing rule under a different heading that conflicts with this one, point it out and let the user decide which to keep.
