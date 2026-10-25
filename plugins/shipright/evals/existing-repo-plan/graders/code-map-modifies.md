---
type: regex
target: { source: file, path: ".shipright/plans/2026-01-01-done-command.md" }
pattern: '^- modify src/notes\.mjs[\s\S]*?^- modify src/(cli|messages)\.mjs|^- modify src/(cli|messages)\.mjs[\s\S]*?^- modify src/notes\.mjs'
flags: m
match: contains
---
The Code map names existing files to modify: notes.mjs (the done state) and at least one of cli.mjs (the command) or messages.mjs (the new message, per CLAUDE.md).
