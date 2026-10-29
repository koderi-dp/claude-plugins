# claude-plugins

Claude Code plugins for faster, quieter sessions. This repository is a plugin marketplace named `code101-plugins`.

| Plugin | What it does | Runs on |
| --- | --- | --- |
| [everything-find](plugins/everything-find) | Instant file and folder lookup through the voidtools Everything index, as a `find` tool | Windows, with [Everything](https://www.voidtools.com/) running |
| [output-trim](plugins/output-trim) | Trims noisy build, test and log output to errors, failures and summaries | Windows |
| [code-outline](plugins/code-outline) | Symbol outlines and single-symbol reads via tree-sitter for Rust, TypeScript, JavaScript, Python and C# | Windows |
| [ssh-remote](plugins/ssh-remote) | Runs commands and downloads files over SSH, with credentials read from files Claude never sees | Windows |
| [superpowers-flow](plugins/superpowers-flow) | Speed profiles (thorough, balanced, fast) and models per role for [superpowers](https://github.com/obra/superpowers) plan runs, chosen at the plan's handoff; parallel slices in git worktrees or their own headless sessions; a live progress bar and agents panel; and a handoff that builds an approved [EGM](https://github.com/google/elephant-goldfish-model) design | Any |

## Install

At the prompt of a terminal session, one plugin at a time:

```
/plugin install superpowers-flow --marketplace koderi-dp/claude-plugins
```

From a shell:

```bash
claude plugin install superpowers-flow --marketplace koderi-dp/claude-plugins
```

Replace `superpowers-flow` with any plugin name from the table. The first install asks to add the marketplace; answer `y`.

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `koderi-dp/claude-plugins`, then Add plugin.

To pick up new releases later:

```bash
claude plugin marketplace update code101-plugins
```

## Layout

| Path | Holds |
| --- | --- |
| `.claude-plugin/marketplace.json` | The marketplace listing |
| `plugins/<name>/` | Each plugin as Claude Code installs it. The Rust plugins ship a release exe in `bin/` |
| `crates/<name>/` | Rust source for the plugins with an exe, one crate per plugin of the same name |
| `Cargo.toml`, `Cargo.lock` | The Rust workspace |
| `justfile` | Build, test, release and publish recipes |

## Develop

Needs Rust, [just](https://github.com/casey/just) and PowerShell 7. The live ssh-remote tests also need Docker.

```bash
just build                      # debug-build the workspace
just test                       # unit and protocol tests
just test-live                  # tests against the ssh-remote test server and a running Everything
just release output-trim        # release-build one plugin into plugins/<name>/bin
just publish output-trim 0.1.1  # bump, test, release, commit, tag, push, update the local install
```

superpowers-flow has no build step. Its tests run with `claude plugin test plugins/superpowers-flow`.

## License

See [LICENSE](LICENSE).
