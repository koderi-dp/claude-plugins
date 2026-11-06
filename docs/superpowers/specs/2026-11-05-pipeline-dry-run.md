# pipeline: dry run of the migration parsers on catalo

Date: 2026-11-06. Read-only: nothing in the catalo clone was modified, and no session was opened there.

## What was run

The pure modules `migrate.ts` and `config.ts` (plus `backlog.ts` and `types/`) were copied into a stub mod in the scratchpad with a generated `inputs.ts` holding catalo's `docs/backlog.md` (629 lines, 218 KB), `CLAUDE.md`, `apps/web/CLAUDE.md`, `package.json`, `.github/workflows/ci.yml`, the two project skills and the headers of 21 `.superpowers/sdd/*/progress.md` ledgers. A test ran `itemsFromBacklogMd`, `draftConfig` and `rulesFromProse` on them under `claude plugin test` (3 pass), and a node script printed the results for the comparison below. The real `migrate` action also feeds every spec and plan into the prose; that was not reproduced (1.8 MB of text), see follow-up 3.

## Items: 134 drafted (30 merged, 104 inbox, 0 parked)

Matched: all 35 checkbox bullets (`Implemented foundation`, `Plan 1b`, `plan 2`, `Remaining delivery phase 1`) with the right checked/unchecked status; the two PR links on checked bullets (#22, #23); the spec and plan links of the page-document and PDF-delivery bullets; the 95 rows of the twelve "Named follow-ups" tables, each with its deferral text in the note; titles cut at a word boundary read well.

Mismatches:

1. **The real queue is missed.** Catalo's current queue is the "Current position" table (lines 57 to 103): 27 Done rows, 18 Queued rows ("Empty grid areas refilled (bug)", "Brand logos", "Table element", "Templates screen", ...) and 2 Later rows. The parser reads only checkbox bullets and "Named follow-ups" tables, so none of the 20 open rows and none of the 27 done rows with their PR links (#6 to #26) become items. Fix: parse any table whose header row has a `Status` column; `Done` with a PR link in the row becomes `merged` with that `pr`, `Queued` becomes `inbox`, `Later` becomes `parked`; the row's first cell is the title and its third cell the note.
2. **Follow-up rows that are done come in as inbox.** "Article list thumbnail column" ("Done in the catalog UI fixes"), "Images tool" ("Done in the Images tool increment"), "Editor-added text colour" ("Done in Phase B") and "Image derivatives" ("Delivered on branch") are `inbox, unverified`. Fix: a follow-up row whose detail starts with `Done` or `Delivered` becomes `merged` with `note: "imported from docs/backlog.md; no PR link"`, or is skipped.
3. **Decision bullets become items.** Four bullets under "Decisions taken in slice 3 that differ from the design text" (a paragraph under the "Named follow-ups after PDF delivery slice 3" heading) become inbox items 82 to 85. Fix: under a follow-ups heading take only table rows and checkbox bullets, not plain bullets, once the section has a table.
4. **Tables under other headings are skipped.** Plan 1b's "Proposed work" table (4 open rows) and plan 2's deferred-findings table (18 rows, most "Implemented in Task 4", two "Deferred to ...") give nothing. The 1b rows are real work. Fix: also accept a table whose second column header contains `work` under any heading, with rows whose detail starts with `Implemented` dropped.
5. **"Delivery phases 2–4"** (3 rows) should be `parked`; same fix as 1 with the heading's "later" wording, or the table rule of 4.
6. The unchecked bullet "Hybrid editor: Phase A delivered the canvas, free layer, thumbnails" is open only for "picker virtualization and designed page import"; the title says the opposite. No parser fix: the lead rewrites such titles in the migrate skill's step 2, and the note carries the bullet.

## Config

Matched after two one-line fixes made in this task (`config.ts`): `checks.fast` = `npm run check:fast`, `checks.task` = `npm run test`, `checks.gate` = build, typecheck, test, lint and `format:check`, which is CLAUDE.md's five-check gate and what `ci.yml` runs (`format:check` was added to the combo list); `stop` = the five conditions of the standing instruction "Ask only when blocked by missing information, conflicting requirements, destructive data changes, new costs, or external actions requiring authorization" (sentences are now unwrapped across hard-wrapped lines first; before the fix only the first two came through). `merge` stays `pr` (no auto-merge sentence) and `models` the defaults, which match the `agent-dispatch` skill's tiers in spirit.

Mismatches:

7. **`riskyPaths` is noise**: 54 entries such as `undo/redo/**`, `A3/A4/A5/custom/**`, `€/m²/**`, `claude/sale-pricing-415cba/**`, because `dirsIn` takes any token with a slash in a sentence that names auth, sessions, migrations, tokens or pricing. Nothing in it is a directory. Fix: pass the project's top-level directory names in `Found` and keep only tokens whose first segment is one of them; apps/web's CLAUDE.md would then give `apps/web/migrations/**` and `apps/web/src/server/**`.
8. `limits.fixRounds` stays 3; the `agent-dispatch` skill says "after two failed reviews or a blocked task, switch coder models". Fix: match `(\w+) failed reviews` too.
9. `checks.task` runs every workspace's tests; CLAUDE.md asks for the affected workspace. No parser fix: a `-w` choice is per task and belongs in the plan (open question 2 of the spec).

## Rules: 22 candidates against CLAUDE.md's "Execution and verification"

Matched: only one agent uses a browser; sign up once and reuse `qa@catalo.test`; fix rounds browser-test only what changed; the after-merge review stack (twice, from CLAUDE.md and the skill); preserve volumes and never reseed destructively; the `MIGRATION_DATABASE_URL` skip rule for reviewer and PR; `src/ui` never imports `*.server.ts`; the visual check per touched page.

Mismatches:

10. Missed from that section: "Independent parallel tasks use separate git worktrees"; "Before dispatch, check plan instructions against the spec, existing behavior, and data preservation"; "Label reviews on an earlier base as provisional"; "For data writes, verify client/server/database boundaries" (a reviewer rule); "Search existing helpers, components, and translation keys before adding equivalents" (an implementer rule); "Independent review is required for logic, schema, security, and behaviour changes"; "`npm run test:renderer-images` when the renderer changed and `test:storage-integration` when storage changes" (a before-the-PR rule); "Do not deploy or send messages without asking" (a stop condition). Fix: extend the patterns with `before dispatch`, `independent review`, `worktree`, `search existing`, `verify ...`, `when the ... changed`, and treat `do not ... without asking` as a stop entry.
11. Noise: "Never share `node_modules` between operating systems", "Take the organization only from server-side authentication" (a code rule), "Install its browser ... fresh machine", `npm run db:migrate` (command docs), and two fragments, "Standing user instruction (2026-10-31)." and "If only one suitable model is available, use a fresh reviewer context." Fix: drop a sentence under 30 characters or that is only a label and a date, and skip sentences whose paragraph is a command list (starts with a backtick). The lead's step 2 of the migrate skill is where the rest is pruned; the note should say that the candidates are many.
12. The after-merge rule is cut at 160 characters mid-sentence ("... on this machine" is the end). Fix: `LINE_MAX` 200, or keep the first sentence whole when it is under 240.

## Follow-ups

Items 1 to 5, 7, 8, 10 to 12 are parser changes over ten lines each; they go into this repository's own backlog once `/pipeline init` has run here (plan Task 10, dogfooding). Item 1 is the one that blocks a real catalo migration: without the Status-column table the migrated backlog would show no open queue. Items 6 and 9 need no code.

## After the fix round

Date: 2026-11-06. Items 1 to 5, 7, 8, 10 to 12 are implemented in `migrate.ts` and `config.ts` (a test per item in `migrate.test.ts` and `config.test.ts`, the catalo fixture extended with nine current-position rows and three plan 1b rows); the stub mod was re-run on the same catalo files, still read-only.

Items: 192 drafted (61 merged, 126 inbox, 5 parked). The "Current position" table gives all 45 rows: 27 Done merged (18 with a PR link, 22 with a spec and 20 with a plan link for `incrementsOf`), 16 Queued inbox (the first note said 18; the table has 16), 2 Later parked. The four Done or Delivered follow-up rows are merged; the four decision bullets of slice 3 are gone; plan 1b's four "Proposed work" rows are inbox; the three "Delivery phases 2–4" rows are parked.

Config: `riskyPaths` is `apps/web/migrations/**` and `packages/domain/src/family/**` (`apps/web/src/server/**` is not named by any sentence that also names risky code, so it does not appear); `limits.fixRounds` is 2 from "two failed reviews" (the earlier "each fix round" no longer wins); `stop` gains "deploy or send messages".

Rules: 28 candidates. The eight missed rules are present in their groups (worktrees, before dispatch and independent review before dispatch; the two `verify` rules in the reviewer brief; search existing in the implementer brief; the full gate with `test:renderer-images` before the PR, whole); the label with a date, the `npm run db:migrate` documentation and the skill front matter are gone; no line is cut under 240 characters.

Still open: plan 2's deferred-findings table yields 12 inbox rows, ten of them done ("Task 3 implemented ...", "Tasks 1/4 consolidated ...") because only a detail starting with `Implemented` is dropped; "Never share `node_modules`", the server-side-authentication code rule, the fresh-machine browser install and "If only one suitable model is available" remain candidates (the migrate skill's step 2 prunes them); one apps/web rule over 240 characters (the visual check list) is cut at a word boundary; `checks.task` and the "Hybrid editor" title stay as items 6 and 9 say.
