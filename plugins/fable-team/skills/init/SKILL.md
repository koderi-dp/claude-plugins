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

   It copies `agents/builder.md`, `agents/research.md` and `agents/reviewer.md` into `<project root>/.claude/agents/`, and appends the routing section to `CLAUDE.md`, creating the file when it is missing. It never overwrites a differing file or section unless `--force` is passed.
3. Read the script's report. For every line marked `kept`, tell the user what differs and ask whether to rerun with `--force`. Do not pass `--force` on your own.
4. If `node` is not available, do the same by hand: copy the three files from `${CLAUDE_PLUGIN_ROOT}/agents/` with the Read and Write tools, keeping the opening `---` block intact, and add the section below to `CLAUDE.md`.
5. Tell the user to start a fresh Claude Code session in the project so the agents are detected, and that they can now disable the plugin (`claude plugin disable fable-team@code101-plugins`) to avoid the agents appearing twice.

Do not commit. The user decides when the new files go into git.

## The routing section

The project copies use bare agent names, because project agents are not namespaced:

```markdown
## Subagent routing

Keep Fable as the lead: plan, assign work and accept the result.
Use built-in Explore on Sonnet for local file discovery.
Use research for outside docs and facts.
Use builder once the files, approach and done criteria are clear.
Use reviewer to check the finished change against the original brief.
Keep the custom agents on their configured models and effort.
Do not use Fable for workers.

Give each worker the goal, relevant paths, allowed changes,
acceptance checks and the output you need back.
Send concrete review findings back to builder, then recheck.
Handle tiny changes directly. Do not spawn every role for every task.
```

If `CLAUDE.md` already has an older routing rule under a different heading that conflicts with this one, point it out and let the user decide which to keep.
