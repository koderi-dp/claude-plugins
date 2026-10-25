---
type: regex
target: { source: file, path: ".shipright/plans/2026-01-01-word-counter.md" }
pattern: '(?:^- .+ -> Task \d+, `[^`]+`[ \t]*$[\s\S]*?){3}'
flags: m
match: contains
---
At least three Review focus lines name the task and the test that proves them. (`count:N` would mean exactly N; the skill asks for five lines.)
