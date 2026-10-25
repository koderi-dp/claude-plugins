---
type: regex
target: { source: file, path: ".shipright/plans/2026-01-01-done-command.md" }
pattern: '^- .+ -> Task \d+, `[^`]+`\s*$'
flags: m
match: "count:3"
---
At least three Review focus lines name the task and the test that proves them.
