# fable-team

Give Fable a team. Keep the lead session in charge and give research, building and review their own workers on the models and effort they need.

| Agent | Model | Effort | Role |
| --- | --- | --- | --- |
| `fable-team:research` | sonnet | medium | Outside docs, APIs and changelogs. Read-only, returns Answer / Evidence / Caveats / Recommendation. |
| `fable-team:builder` | opus | medium | Implements a planned, bounded change on assigned files only, runs the checks, returns Changed / Files / Validation / Risks. |
| `fable-team:reviewer` | opus | medium | Reviews the finished change against the original brief, runs the checks itself, returns Findings / Validation / Risks. Never implements. |

Local file discovery uses the built-in Explore agent, which needs no file.

The `routing` skill holds the rule the lead follows: plan, brief, delegate, review, accept. It loads when a task is more than a tiny edit, or on demand with `/fable-team:routing`.

The agent files follow the "Give Fable a team" field guide (FounderOS, September 2026).

## Install

At the prompt of a terminal session:

```
/plugin install fable-team --marketplace koderi-dp/claude-plugins
```

From a shell:

```bash
claude plugin install fable-team --marketplace koderi-dp/claude-plugins
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `koderi-dp/claude-plugins`, then Add plugin.

## Use

Nothing to copy into the project. Ask the lead for a bounded change and name the roles if you want to be explicit:

```
Use Explore to find the signup form and its validation. Return the paths and
current behaviour, no edits. Then write a brief: reject an invalid email and
show an inline error. Name the allowed files and the exact validation command.
Delegate the change to builder, then give reviewer the brief, the change set
and the same command. If either reports a blocker, bring it back to me.
```

Optional: add this to the project's `CLAUDE.md` so every session routes the same way without loading the skill first.

```markdown
## Subagent routing

Keep Fable as the lead: plan, assign work and accept the result.
Use built-in Explore on Sonnet for local file discovery.
Use fable-team:research for outside docs and facts.
Use fable-team:builder once the files, approach and done criteria are clear.
Use fable-team:reviewer to check the finished change against the original brief.
Keep the custom agents on their configured models and effort.
Do not use Fable for workers.

Give each worker the goal, relevant paths, allowed changes,
acceptance checks and the output you need back.
Send concrete review findings back to builder, then recheck.
Handle tiny changes directly. Do not spawn every role for every task.
```

## Troubleshooting

- Agent missing: run `/agents` and look for the `fable-team:` prefix. If absent, reinstall the plugin and start a new session.
- Unexpected model: check `/tasks` for a model override on the call.
- A project that also has `.claude/agents/builder.md` etc. gets both sets; delete the project copies once the plugin is installed.
