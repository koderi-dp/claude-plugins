---
type: regex
target: { source: file, path: ".shipright/plans/2026-01-01-done-command.md" }
pattern: '^Gate:\s*`(npm test|npm run test|npm run check:release|node --test)`\s*$'
flags: m
match: contains
---
The gate is the repo's own test command, not an invented one.
