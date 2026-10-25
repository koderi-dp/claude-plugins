---
description: A new project, no repo. Shipright must produce a spec and a lean plan with every structural element, prove the gate, and stop before Phase 1b.
tags: [plan, greenfield]
runs: 1
max_turns: 60
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, AskUserQuestion, TodoWrite]
---

Use the shipright skill to build this, in the current folder, which is empty and is the project root.

Feature: a command-line word counter in plain Node.js ES modules, no npm dependencies, tested with `node --test`. `node src/cli.mjs <file>` prints `<words> words, <lines> lines` for a UTF-8 text file; a missing file prints `File not found: <path>` to stderr and exits 2; an empty file prints `0 words, 0 lines`. Words are runs of non-whitespace.

The design is agreed as written above; there are no open questions, so do not ask any. Use `2026-01-01` as today's date and `word-counter` as the feature slug in artifact file names, so the plan is `.shipright/plans/2026-01-01-word-counter.md`. Go through Phase 0 (the spec) and Phase 1 (the plan, with every pre-plan check; if you have no shell tool, skip the gate dry run and say so under Constraints), then stop: do not ask the Phase 1b question, do not create a branch, do not write any application code. End with one line naming the plan path.
