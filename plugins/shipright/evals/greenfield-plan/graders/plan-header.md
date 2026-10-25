---
type: regex
target: { source: file, path: ".shipright/plans/2026-01-01-word-counter.md" }
pattern: '^Gate:\s*`[^`]+`\s*$[\s\S]*^Branch:[\s\S]*^## Code map[\s\S]*^## Constraints[\s\S]*^## Review focus[\s\S]*^## Task 1:'
flags: m
match: contains
---
The plan carries its header lines (Gate, Branch), a Code map, Constraints, a Review focus and at least one task, in that order.
