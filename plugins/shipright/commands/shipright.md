---
description: Build a feature natively, task by task, on a new branch, reviewed before the pull request
argument-hint: <feature description, or path to an existing plan>
---

Use the `shipright` skill from this plugin for: $ARGUMENTS

Follow its phases in order and do not hand implementation to subagents. The only subagents are the read-only reviewers, `shipright:task-reviewer` and `shipright:final-reviewer`, on the models the user picks in Phase 1b.
