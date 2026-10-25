---
type: regex
target: { source: file, path: ".shipright/plans/2026-01-01-word-counter.md" }
pattern: '(?:^Done:[ \t]*`[^`]+`[^\n]*$[\s\S]*?){2}'
flags: m
match: contains
---
At least two tasks end with a Done line naming a narrow check command.
