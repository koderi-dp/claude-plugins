---
type: regex
target: { source: file, path: ".shipright/plans/2026-01-01-word-counter.md" }
pattern: '^Done:\s*`[^`]+`'
flags: m
match: "count:2"
---
Every task (at least two) ends with a Done line naming its narrow check command.
