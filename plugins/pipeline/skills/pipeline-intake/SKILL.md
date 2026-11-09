---
name: pipeline-intake
description: Use when the user asks for something to be built, fixed, added or changed in a project that has docs/pipeline/config.json, in any wording ("we need", "can you add", "fix the", "it should"), and on /pipeline add <text>. Records the request as a backlog item with a spec through the mcp__pipeline__pipeline tool and answers in one line. Never starts the build.
---

# pipeline-intake

A request becomes an item in `docs/pipeline/backlog.json` and a spec in `docs/pipeline/specs/<id>.md`. Intake runs in any session, including a phone session over Remote Control, and never starts the build: that is `/pipeline next` or `/pipeline run <id>`.

## Rules

1. **Duplicate check.** `{ "action": "get", "titles": true }` first: its `titles` lists every item as id, status and title. The same request already in the backlog is a note on that item, not a new one: `{ "action": "update", "id": "<id>", "set": { "note": "<what the user added, dated>" } }`, and answer `p9 noted · <the note>`.
2. **Add the item.** `{ "action": "add", "item": { "title", "size", "needs", "source", "note" } }`: a title under ten words; `size` as `S`, `M` or `L`; `needs` holding the ids of the items this one depends on (empty when none); `source` quoting the user with the date, as `user, 2026-11-05: "we need csv export of catalogs"`. The tool answers the status text and the new id. The item starts as `inbox`; never set a status yourself.
3. **Write the spec** at `docs/pipeline/specs/<id>.md` with Write, from `templates/spec.md` in this plugin, five headings: What (two to five sentences), Why (one), Acceptance (a checklist the final review ticks), Out of scope (what a reader might expect and will not get), Open (a question only the user can answer, or nothing). Facts you can establish from the code and the project's own docs go in; read them before asking. Then `{ "action": "update", "id": "<id>", "set": { "spec": "docs/pipeline/specs/<id>.md" } }`.
4. **At most one question**, and only when the spec cannot be written without it. It goes under Open and after `open:` in the answer. The user answers in a later turn, or not; when they do, put the answer into the spec, empty Open, and answer `p12 · open: none`. A `/pipeline next` on an item with an open question stops with that question.
5. **Answer in one line**, exactly this shape: `p12 added · M · needs p9 · open: none` (`needs none` when the item depends on nothing; the question after `open:` when there is one). Nothing else: no summary of the spec, no offer to start.
6. **Ready is not yours to set.** An item with an empty Open goes to `ready` when every id in `needs` is `merged`; the tool does that.
7. **Only the tool writes `backlog.json`**: never Edit or Write it, and never `BACKLOG.md`. The spec file is the one file you write by hand.
8. **Never start the build.** No plan, no worktree, no dispatch, whatever the request sounds like; the user runs `/pipeline next`.
