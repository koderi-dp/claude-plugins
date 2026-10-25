---
type: regex
target: { source: file, path: ".shipright/plans/2026-01-01-done-command.md" }
pattern: '^- modify src/(notes|cli|messages)\.mjs'
flags: m
match: "count:3"
---
The Code map names the existing files the feature changes: notes.mjs (the done state), cli.mjs (the command) and messages.mjs (the new message, per CLAUDE.md).
