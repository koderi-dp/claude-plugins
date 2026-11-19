# claude-plugins

Claude Code plugins. This repository is a plugin marketplace named `code101-plugins`.

| Plugin | What it does | Runs on |
| --- | --- | --- |
| [ssh-remote](plugins/ssh-remote) | Runs commands and downloads files over SSH, with credentials read from files Claude never sees | Windows |
| [superpowers-flow](plugins/superpowers-flow) | Speed profiles (thorough, balanced, fast) and models per role for [superpowers](https://github.com/obra/superpowers) plan runs, chosen at the plan's handoff; parallel slices in git worktrees or their own headless sessions; a live progress bar and agents panel; and a handoff that builds an approved [EGM](https://github.com/google/elephant-goldfish-model) design | Any |
| [pipeline](plugins/pipeline) | Owns a project's workflow: a backlog in `docs/pipeline` or in GitHub issues, skills that take a request to a merged PR, a watchdog over subagents, and a status block as text and as a panel | Any |

## Install

From a shell, add the marketplace once, then install one plugin at a time:

```powershell
claude plugin marketplace add koderi-dp/claude-plugins
```

```powershell
claude plugin install superpowers-flow@code101-plugins
```

Replace `superpowers-flow` with any plugin name from the table. The same two steps work at the prompt of a terminal session as `/plugin marketplace add koderi-dp/claude-plugins` and `/plugin install superpowers-flow@code101-plugins`.

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `koderi-dp/claude-plugins`, then Add plugin.

To pick up new releases later:

```powershell
claude plugin marketplace update code101-plugins
```

```powershell
claude plugin update superpowers-flow@code101-plugins
```

## Layout

| Path | Holds |
| --- | --- |
| `.claude-plugin/marketplace.json` | The marketplace listing |
| `plugins/<name>/` | Each plugin as Claude Code installs it. ssh-remote ships a release exe in `bin/` |
| `crates/<name>/` | Rust source for a plugin with an exe, in a crate of the same name; today only ssh-remote |
| `Cargo.toml`, `Cargo.lock` | The Rust workspace |
| `justfile` | Build, test, release and publish recipes |

## Develop

Needs Rust, [just](https://github.com/casey/just) and PowerShell 7. The live ssh-remote tests also need Docker.

```bash
just build                      # debug-build the workspace
just test                       # unit and protocol tests
just test-live                  # tests against the ssh-remote test server (just ssh-test-server)
just release ssh-remote         # release-build the plugin into plugins/<name>/bin
just publish ssh-remote 0.1.1   # bump, test, release, commit, tag, push, update the local install
```

superpowers-flow and pipeline have no build step. Their tests run with `claude plugin test plugins/<name>`.

## License

See [LICENSE](LICENSE).
