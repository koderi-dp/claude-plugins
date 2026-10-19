# output-trim

Trims noisy build, test and log output to errors, failures and summaries, so Claude
reads a few lines instead of thousands.

Claude runs `dotnet test 2>&1 | output-trim` instead of `dotnet test | tail -20`.
`output-trim` reads all of the output and prints a verdict, the details that explain
failures and warnings, and a footer with the path of the saved full log:

```
[output-trim] dotnet test: FAILED — 1 failed, 411 passed, 2 skipped
Failed Studio.Api.Tests.AuthTests.Login_Expired
  Expected 401 but was 200
  at AuthTests.cs:line 42
[output-trim] kept 0.3k of 50k chars · full: C:\Users\…\Temp\output-trim\20261020-153212-ab12.log
```

The full path of the untrimmed log is always in the footer, so nothing is lost.

A session-start note tells Claude the tool exists. A post hook shrinks large
successful output from known noisy commands (dotnet, cargo, npm, docker logs and
similar) that Claude did not pipe.

## Setup: allow rule

Add this rule once so Claude is not prompted on every call:

```
Bash(output-trim *)
```

Use `/permissions` and add it under Allow, or put it in `permissions.allow` in
`~/.claude/settings.json`.

This is safe: `output-trim` only reads stdin and prints text. It never executes
anything.

## Limitation

Failing commands that Claude did not pipe through `output-trim` are not trimmed.
Claude Code does not allow a hook to rewrite the output of a failed command, so the
post hook only handles successful output.
