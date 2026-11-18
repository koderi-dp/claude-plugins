---
name: pipeline-discuss
description: Use on /pipeline discuss <text or id>, or when the user asks to talk an item through before it is built ("let's discuss", "ask me about it", "help me spec this"). Asks the user a few questions one at a time, proposes the spec, and saves it through the mcp__pipeline__pipeline tool once the user agrees. Never starts the build.
---

# pipeline-discuss

The slow intake: the user is here and wants the spec right before anything is built. `pipeline-intake` is the quick one (no questions); this one asks. The result is the same: an item with a spec of five headings (`templates/spec.md` in this plugin: What, Why, Acceptance, Out of scope, Open).

## Steps

1. **Find the item.** `{ "action": "get", "titles": true }`. An id (`p12`, `12`), or a request that is already in the backlog, means you are improving that item: read it with `{ "action": "get", "id": "<id>" }` and its spec (the file at its `spec` path, or under `"queue": "github"` the spec in that answer). Anything else is a new request; do not add it yet.
2. **Read before you ask.** Look at the code and the project's docs the request touches. Never ask the user what the repository can answer.
3. **Ask, one question per turn.** Only what changes what gets built: who it is for, what done looks like, the limits, what is left out, a choice between behaviours. Offer two to four answers to pick from, your recommended one first, through AskUserQuestion when you have it and as a short lettered list when you do not. Small items need one or two questions, large ones rarely more than five. Stop asking when the answers stop changing the spec, or when the user says "enough" or "you decide".
4. **Offer approaches only when there is a real choice.** Two or three ways to do it, one line each with its cost, your recommendation first. Skip this when one way is plainly right.
5. **Show the spec and wait.** The five headings, short: Acceptance as lines that can be checked against the merged code, Out of scope naming what the user might expect and will not get, Open empty. The user approves it or corrects it; apply corrections and show only what changed.
6. **Save after the yes.**
   - New item: `{ "action": "add", "item": { "title", "size", "needs", "source", "note" }, "text": "<the spec>" }`. `source` quotes the user with the date.
   - Existing item under `"queue": "github"`: `{ "action": "spec", "id": "<id>", "text": "<the spec>" }`, and `update` with `set: { "title" }` when the title changed.
   - Existing item with a file backlog: Write the spec to its `spec` path (`docs/pipeline/specs/<id>.md` when it has none, then `{ "action": "update", "id": "<id>", "set": { "spec": "docs/pipeline/specs/<id>.md" } }`).
7. **Answer in one line:** `p12 added · M · needs none · open: none`, or `p12 spec updated · open: none`.

## Rules

- A request that turns out to be several independent things becomes several items, each with its own spec; say so before saving and link them with `needs`.
- Leave out what the user did not ask for. A nice-to-have you thought of goes under Out of scope, not into Acceptance.
- The user leaving mid-way: save what is agreed, put the unanswered question under Open (under `"queue": "github"` ask it with `{ "action": "question", "id", "text" }`), and say the item waits on it.
- Only the tool writes `backlog.json`, `BACKLOG.md` and issues; never `gh` and never Edit on those files.
- Never start the build: no plan, no worktree, no `begin`. The user runs `/pipeline next`.
