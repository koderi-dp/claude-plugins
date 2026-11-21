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
4. **Questions.** After reading the code and the project's docs, count the points where writing the Acceptance list would have you choose what the user gets: which features or cases are in, how one of them behaves, a limit, who it is for. How it is built (a file, a name, the test style) is yours to decide and never a point, and neither is what the repository answers. An Acceptance line you would have to mark "assumed" is a point: the request did not say it.
   - **None:** no question.
   - **One:** ask it. It goes under Open and after `open:` in the answer. The user answers in a later turn, or not; when they do, put the answer into the spec, empty Open, and answer `p12 · open: none`. A `/pipeline next` on an item with an open question stops with that question.
   - **Two or more** is a thin request, and `config.intake` in the `get` answer decides. `quick`: ask the one that changes the most, as above, and settle the others yourself, each as a line in the spec that says what you assumed. `auto` (the default, also when `get` names no `intake`): the section "A thin request" below.
5. **Answer in one line**, exactly this shape: `p12 added · M · needs p9 · open: none` (`needs none` when the item depends on nothing; the question after `open:` when there is one). For a size `L` item you asked nothing about, add ` · large: /pipeline discuss <id> talks it through first`. Nothing else: no summary of the spec, no offer to start.
6. **Ready is not yours to set.** An item with an empty Open goes to `ready` when every id in `needs` is `merged`; the tool does that.
7. **Only the tool writes `backlog.json`**: never Edit or Write it, and never `BACKLOG.md`. The spec file is the one file you write by hand.
8. **Never start the build.** No plan, no worktree, no dispatch, whatever the request sounds like; the user runs `/pipeline next`.

## A thin request

Under `intake: auto`, a request that leaves two or more points open is talked through, not guessed. It is recorded first, so it is not lost when the user leaves, and it waits on its question, so nobody builds it on a guess.

1. **Record it.** Add the item as in rules 2 and 3, with the spec written as far as the request and the code carry it and every open point as a question under Open, the one that changes the most first.
2. **Ask the first question in the same turn.** The one-line answer with that question after `open:`, then two to four answers to pick from on the lines below it, your recommended one first (through AskUserQuestion when you have it).
3. **Go on when the user replies.** Follow the `pipeline-discuss` skill for that item from its step 3: one question per turn, the spec shown, saved after the yes with Open empty. "Enough" or "you decide" ends the questions: settle the rest yourself and say in the spec what you assumed.

These steps are the discussion. Invoke no brainstorming or planning skill of another plugin for an intake.

## With queue: github

When `get` answers `"queue": "github"`, the open issues carrying the queue label are the backlog and an issue number is the id. The rules above hold, except these.

- Rules 2 and 3 are one call: `{ "action": "add", "item": { "title", "size", "needs", "source", "note" }, "text": "<the spec>" }`. Write the spec's text first, with the five headings of `templates/spec.md` (from `## What` on; the title line is the issue's title), and pass it as `text`. The tool creates a labelled issue with the title, and the note and the source (as a `Source:` line) as its body, posts the spec on it as the spec comment and answers the number: `added 12 · ready · spec posted`. Make no `spec` call after it. `needs` holds issue numbers (`"needs": ["12"]`): the tool writes them as a `Needs: #12` line in the issue's body, and the issue waits while one it names is open in the queue.
- The spec is not a file: do not Write a spec file and do not `update` a `spec` path. `{ "action": "spec", "id": "12", "text": "<the spec>" }` is only for an item that already exists: it replaces the spec comment there.
- A question is not an Open section: ask it with `{ "action": "question", "id": "12", "text": "<the question>" }`, after the `add`. The tool posts it on the issue, where the author is notified, and holds the item until it is answered. An answer the user gives in the session goes on the issue through `{ "action": "answer", "id": "12", "text": "<what the user said>" }`, which ends the hold; post the spec again with `spec` when the answer changes it.
- A thin request: the `add` carries the spec as far as it is known, then one `question` whose text is the first open point, with the other open points listed under it, so the issue records them all; in the session you ask them one per turn. After the user's yes, `spec` with the agreed text, then one `answer` with what the user decided, in a sentence or two. Not before: the item stays held while you are still asking.
- The one-line answer is `12 added · M · open: none`, with the question after `open:` when you asked one.
- Never edit an issue, a label or a comment with `gh` yourself: the tool's actions do every change, so its cache and the issue stay in step.
