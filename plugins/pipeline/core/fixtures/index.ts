// Generated from the Markdown fixtures in this folder: invented texts in the shapes a project keeps its queue and its process in.
// Tests can only import TypeScript, so the texts live here too; regenerate after editing a .md file:
//   cd plugins/pipeline/core/fixtures && node generate.cjs

/** status-table-backlog.md */
export const STATUS_TABLE_BACKLOG = `# Larder work queue

Invented text for the migration tests, in the shape of a docs/backlog.md that grew by hand: a Statuses line, nine rows of a current position table, three rows of a proposed work table, one named follow-ups section and a remaining delivery phase section. Larder is a made-up recipe and menu planner.

Statuses: **Queued** → **Brainstorming** → **Planning** → **Ready** → **Implementing** →
**Review** → **Done**. Ready means the design and plan are agreed; Done means the checks,
the reviews and the merge are on record. Write **Blocked** with the cause and the next
step when it applies. A proposal listed here is not approved yet.

## Current position

Seasonal colour preset (\`1a2b3c4\`) and faster checks (\`5d6e7f8\`) are merged to \`main\` and
pushed. Next queue item: menu builder and print delivery (delivery phase 1).

| Work | Status | Evidence / next action |
| --- | --- | --- |
| Core data model plan, Tasks 1–7 | Done | Reviewed, merged, and pushed; the model plus the delete guard at \`a1b2c3d\`. |
| Plan 1b: kitchen separation | Done | Tasks 1–4 and final review complete; merged locally to main (\`4e5f6a7\`); no push. |
| Recipe list fixes (Hearth review) | Done | From the user's review of the Hearth data on 2026-11-02; merged as \`0c9d8e7\` ([PR #9](https://github.com/example-org/larder/pull/9)). [Design note](superpowers/specs/2026-11-02-ingredient-picker-and-recipe-page-design.md). Ingredient counts include sub-groups and a group filter covers everything under it. |
| Menu editor, Phase B: card layout v2 | Done | From the parent session's brief (2026-11-04), branch \`claude/menu-phase-b-12ab34\`, [PR #24](https://github.com/example-org/larder/pull/24). [Design](superpowers/specs/2026-11-04-menu-editor-card-layout-v2-design.md), [plan](superpowers/plans/2026-11-04-menu-editor-card-layout-v2.md), [ledger](../.superpowers/sdd/2026-11-04-menu-editor-card-layout-v2/progress.md). Card layout v2: four margins, dish styles, spacing, photo fit (whole or cropped), a frame, shown fields and a short code field. |
| Empty menu slots refilled (bug) | Queued | Slots emptied with Remove dish are filled with new empty dishes by the next resize, by a column or row change in the Card tab, or by Add a row: \`resizeSlot\` (\`apps/web/src/menu/slot-resize.ts\`) and \`setTracks\` (\`apps/web/src/menu/card-geometry.ts\`) both call \`fillOpenSlots\`, which fills every open slot on the card. This breaks Phase C's rule that removed dishes leave empty slots. |
| Supplier logos | Queued | Suppliers as records with a logo image, shown on ingredient rows; \`supplier\` is plain text today. The Hearth sheets show a supplier logo per row. |
| Allergen table | Queued | A free table for allergens and portion prices (starters, desserts). A text box stands in until then. |
| Dish style across menus | Later | Apply a dish's style to every dish that uses the same style in its course or the whole menu, so a design change (for example the price colour on the tile) reaches cards already built from a template. Revisit if one design has to be shared by many templates. |
| Stock sync, till connectors, forecasts | Later | Delivery phases 2–4 of the product spec. |

The completed **core data model plan** is only part of the spec's broader **delivery phase 1**.

## Plan 1b — kitchen separation (complete, merged)

Deferred findings from the final review, kept here as proposed work:

| Reference in final review | Proposed work |
| --- | --- |
| Minor 5; Task 5 seed retry | Repair a missing default unit list after a seed failure. |
| Task 4 staff-query cost | Revisit repeated kitchen and staff queries when the request context is wired in. |
| Task 4 kitchen plugin endpoints | Review the line between sign-in tables shared by all kitchens and one kitchen's data; keep deletion off. |

Migration decision: nothing is deployed yet. If the new foreign key finds broken links,
stop with a clear message and leave the data as it is.

### Named follow-ups after the Hearth review

From the user's recipe list and recipe page sketches (2026-11-02); each needs data or a
feature that does not exist yet, so none was built in the recipe list fixes.

| Follow-up | Deferred work and reason |
| --- | --- |
| Supplier and season filters | The list sketch filters by supplier and by season. Suppliers are plain text on ingredients; a supplier filter needs a query for the distinct names and a list parameter, and a season filter changes which price the list shows. |
| Recipe editing and status | The page sketch has an Edit button and an "Active" status. There is no recipe edit form and no status column; both need a design (which fields can change after an import, what inactive means for menus). |
| Nutrition, Menus and History tabs | The page sketch's Key facts card and the Nutrition, Menus and History tabs need nutrition values (done as "Recipe fact fields": the page has a Facts card, not yet a tab), a reverse index of menus... |
| New recipe | The sketches' "New recipe" button needs a create form; recipes come from import today. |
| Units dialog parent picker | The units page's parent field still uses the flat \`Select\`; swap it for \`GroupPicker\` when that dialog is next touched. |


## Remaining delivery phase 1 — menu builder and print

These are spec requirements waiting for detailed plans. Their grouping and order below are a
proposed sequence after 1b and plan 2, not approved plans.

- [ ] Versioned menu card schema, migrations, shared renderer, and renderer samples.
      Work in progress: [design](superpowers/specs/2026-10-31-menu-card-renderer-design.md)
      and [four-task plan](superpowers/plans/2026-10-31-menu-card-renderer.md).
      Migrations here change the stored JSON, not the database tables. Includes strict
      image comparisons of the samples; editor, saving and print delivery come later.
- [x] Reusable menu templates, course defaults, and per-menu template selection. Phase C
      ([design](superpowers/specs/2026-11-04-menu-editor-templates-design.md)); template version
      history is a [follow-up](#named-follow-ups-after-phase-c).
- [x] Menu courses, automatic dish order, template switching, and unplaced-dish
      counts with undo support. Phase C; refilling existing cards on the server and moving
      cards between courses are [follow-ups](#named-follow-ups-after-phase-c).
- [ ] Menu editor: Phase A delivered the canvas, free layer, thumbnails, the properties
      panel and the course filter. Phase B (card layout v2: size and orientation, margins,
      grid, per-dish styling, slot resize, new row, lock and hide) merged in
      [PR #24](https://github.com/example-org/larder/pull/24). Phase C (template mode, the Layouts and
      Templates tools, courses, dishes in empty slots) merged in [PR #26](https://github.com/example-org/larder/pull/26);
      the Photos tool (photo library, free photos, a photo per dish) is in review in
      [PR #25](https://github.com/example-org/larder/pull/25); a faster picker and card import remain.
- [x] Draft autosave, undo/redo, and single-editor card locks (slice 2, merged).
- [ ] Draft version history: stored versions and restore; undo is per editing visit today.
- [x] Dish variants from portion rules and manual grouping; variant boxes, portion choice,
      placement preferences, and variant price display. Merged in
      [PR #22](https://github.com/example-org/larder/pull/22) (see the queue row).
- [x] Menu approval and fixed price snapshots, including dish variants.
      Print delivery slice 3, [PR #23](https://github.com/example-org/larder/pull/23): the snapshot
      keeps the placed dishes and variants, and the price check compares variants too.
- [x] Print jobs, file storage/downloads, and dashboard menus/recent prints.
      The local store is behind a neutral interface (decision 2026-10-31); the photo
      gallery and the retention rules landed in slice 3 ([operations](storage.md)). Print
      jobs, stored files, downloads and Recent prints landed with print delivery
      slice 1 ([operations](print-delivery.md)); removing held versions of a whole kitchen
      is a [follow-up](#named-follow-ups-after-print-delivery-slice-3).
- [ ] Print renderer service with screen output and press output; embedded fonts,
      bleed and crop marks, and a colour profile check.
      **Slice 1 done** (screen output, 2026-11-03): the \`print-renderer\` container, the
      page boxes, embedded fonts, the job runner and the Print dialog;
      [design](superpowers/specs/2026-11-03-print-delivery-design.md),
      [plan](superpowers/plans/2026-11-03-print-delivery-slice-1.md),
      [ledger](../.superpowers/sdd/2026-11-03-print-delivery-slice-1/progress.md),
      [operations](print-delivery.md). **Slice 2 done** (press profile, 2026-11-03): grey
      text printed in black only, the press colour profile, photos kept at full size and
      the press checks; [plan](superpowers/plans/2026-11-03-print-delivery-slice-2.md),
      [ledger](../.superpowers/sdd/2026-11-03-print-delivery-slice-2/progress.md).
      **Slice 3 done** (approval and publish, 2026-11-04): statuses
      \`draft → approved → printed\`, prints bound to a snapshot, a price-change warning and
      "Published" in the UI ([PR #23](https://github.com/example-org/larder/pull/23)).
      This item stays open until a print shop accepts a real file.
- [ ] Print checks for resolution, safe areas, embedded fonts, and press validity; renderer
      image tests and an end-to-end menu-to-print check. **Slice 1 done:** the
      screen rules (\`box_mismatch\`, font, text and photo codes, \`text_overflow\`) run on
      every print and show in the Print dialog ([codes](print-delivery.md#checks)).
      **Slice 2 done:** the press rules (\`colour_space\`, \`profile_missing\`,
      \`rich_grey\` and the 300 dpi error) run on press prints. Press validity is checked
      by structure only; a full check needs the print shop's own tool
      (see the decisions below).

`

/** state-table-queue.md */
export const STATE_TABLE_QUEUE = `# Larder work queue

Invented text for the migration tests, in the shape of a docs/backlog.md with one row per item: the open decisions, thirteen queue rows across the six states and four done rows. Larder is a made-up recipe and menu planner.

One row per item, in priority order: Item · Size · State · Scope · Links. Sizes \`tiny\`,
\`small\`, \`medium\` and \`large\` set how much process an item gets. States: \`Queued\`,
\`Running\`, \`Review\` (PR open), \`Done\`, \`Later\`, \`Blocked\` (with the blocker). The summary of
the spec is the [roadmap](roadmap.md); history is in the [archive][archive].

## Open decisions

- 2026-11-03 · user · The type foundry's written permission to embed \`Marlow-Text.otf\` (or a font swap) before any public repository or a build shared outside the company.
- 2026-11-03 · user · Buy a print proofing tool, or take the print shop's check of the first production file as the acceptance check; ask the shop for its required colour profile.
- 2026-11-03 · user · Confirm the font and icon licence obligations in [licensing](licensing.md) before any public deployment.

## Queue

Running and Review rows first, then Queued, then Later. Folded follow-up rows list their items in [the fold list][fold].

<!-- prettier-ignore -->
| Item | Size | State | Scope | Links |
| --- | --- | --- | --- | --- |
| menu-cover-image — Menu cover image | medium | Running | A card setting beside the background colour: a photo from the photo library, fill the card or fit inside, optional opacity, always behind every dish and covering the bleed; templates carry it. User request, 2026-11-09. | Renderer change |
| sidebar-widths — Adjustable editor side panels | small | Review | Drag handles between the editor's left panel and the canvas, and between the canvas and the right panel, so each panel can be widened or narrowed within sensible limits; widths remembered per browser. User request, 2026-11-09. | |
| colour-themes — Colour themes per user | small | Blocked | Waits for the user's choice of the theme set (for example Paper, Slate, Harbour, Olive). Themes change the app's look only (colour tokens in \`apps/web/src/styles.css\`). User request, 2026-11-09. | |
| course-column-sizes — Course row and column sizes | medium | Queued | A grid row or column with a fixed size in mm (a thin heading row) while the others share the rest: card layout (v2 compatible), renderer, editor geometry, Card tab and "with heading" presets. Prints of cards without fixed sizes stay identical. User request, 2026-11-05. | Renderer change |
| supplier-logos — Supplier logos | medium | Queued | Suppliers as records with a logo image, shown on ingredient rows; \`supplier\` is plain text today. The Hearth sheets show a supplier logo per row. | |
| two-sided-cards — Two-sided cards | large | Queued | View both sides together in the editor and print them as one sheet; the Hearth menu is laid out and delivered two-sided. Single sides print correctly without it. | |
| course-delete-dishes — Delete a course with its dishes | small | Queued | The Delete course dialog offers Keep dishes (default) or Delete course and N dishes: warn about dishes edited after the fill, refuse while another user holds a lock, one transaction. User request, 2026-11-05. | |
| multi-card-delete-clear — Multi-card delete and clear | small | Queued | Select cards in the strip (Shift, Ctrl/Cmd-click) to Delete cards (count confirmed, never the last, refused while locked) or Clear card (layout kept, dishes emptied). User request, 2026-11-05. | Pairs with course-delete-dishes |
| templates-screen — Templates screen | tiny | Queued | A Templates screen in the app navigation: thumbnails, names, default courses and usage; New template opens \`/templates/$id\`; duplicate, rename, delete. User request, 2026-11-05. | |
| editor-hardening — Editor hardening | small | Queued | Controls look live while a lock is being taken and drop their edits; limited or refused edits give no hint; hidden dishes show editable geometry; save and lock edges of slice 2; Phase A leftovers. | [items][fold] |
| dish-style-across-menus — Dish style across menus | medium | Later | Apply a dish's style to every dish with the same style in its course or menu, so a design change reaches cards built from a template. Revisit if one design must be shared by many templates. | |
| worker-slice — Worker slice | large | Later | Background jobs: the storage sweep (orphans, unused photos, held versions), smaller photo copies made ahead of time, an index of where a photo is used. Delivery phase 2. | [items][fold] |
| integrations — Stock sync, till connectors, forecasts | large | Later | Delivery phases 2–4 of the product spec ([roadmap](roadmap.md#delivery-phases-24)). | |

## Done

Newest first. Deployed is the first date on the review machine; "—" means before there was one.
Finished ledgers, designs and plans are deleted at Done; read one with
\`git show <commit>:.superpowers/sdd/<folder>/progress.md\`.

<!-- prettier-ignore -->
| Item | Merged | Deployed | Ledger |
| --- | --- | --- | --- |
| edit-inside-groups — Edit inside groups | \`6d1e2f3\` (#35) | 2026-11-06 | \`2026-11-06-edit-inside-groups\` at \`7a8b9c0\` |
| print-delivery — Print delivery, slices 1–3 | \`1f2e3d4\` (#18, #21, #23) | 2026-11-04 | \`2026-11-03-print-delivery-slice-1\`, \`-2\`, \`-3\` |
| recipe-list-fixes — Recipe list fixes (Hearth review) | \`0c9d8e7\` (#9), \`5b6a7c8\` (#10) | 2026-11-02 | [archive][a-fix] |
| menu-builder-core — Menu builder core (slice 1) | \`9e8d7c6\` | — | [archive][a-core] |

[archive]: ../.superpowers/sdd/progress-archive.md
[fold]: ../.superpowers/sdd/followups.md#folded-follow-ups
[a-fix]: ../.superpowers/sdd/progress-archive.md#recipe-list-fixes
[a-core]: ../.superpowers/sdd/progress-archive.md#menu-builder-core
`

/** wave-queue-claude.md */
export const WAVE_QUEUE_CLAUDE = `# Trellis CLAUDE.md (invented)

Invented text for the migration tests, in the shape of a CLAUDE.md that keeps its queue in prose: nine rows of an MVP status table and an MVP queue section in waves. Trellis is a made-up booking service for clinics.

## MVP status

The rows tagged MVP in SPEC Part 3 (37 at the audit, 36 since fax moved to V1), checked against \`main\` (audit \`docs/superpowers/plans/2026-10-28-mvp-queue.md\`, 2026-10-28). **A row is done only when every MVP user story and acceptance criterion of it is met on \`main\`, or the user moved the rest out of the MVP with a SPEC §6.5 entry.** A lead never marks an MVP part "V1" or "later" without that entry; until the user decides, the item reads "decision pending". This table is where leftovers live: the docs step of a slice updates its rows here. Status: D done, P partly done, IP in progress, N not started; the last column is the queued slice that closes the rest.

| # | Row (SPEC) | St. | Missing on \`main\` | Slice |
|---|---|---|---|---|
| 1 | Services, opening hours, description (§3.1) | P | the closed-days switch in the picker (AC-1.7); move between locations (US-1.7) | Q29, Q18 |
| 2 | Single and group appointments (§3.1) | D | (turn one into a course, AC-1.8: V1, M6) | — |
| 3 | Visit notes with a summary line (§3.1) | D | — | — |
| 4 | Calendar sections, favourites, mute (§3.1) | P | sections, favourites, mute, order and collapse on the synced settings (US-1.6, AC-1.6; the settings and their 2 s sync are on \`main\`, measured at 310 ms) | Q11 |
| 5 | Locations with default services (§3.1) | N | locations, location admin, default services (US-1.2, AC-1.2 first half) | Q18 |
| 6 | Rich text in notes, with copy and collapse (§3.2) | D | — | — |
| 7 | Reminders, replies, custom texts (§3.2) | P | custom reminder texts; "invite to book" for a person without an account (AC-2.5); a \`:code:\` in SMS text shows as text (Q4 G1) | Q14 |
| 8 | Change (with history), cancel, pin, quote (§3.2) | P | change window and cancellation policy settings (US-2.5, AC-2.8); change history retention per policy (AC-2.8) | Q17 |
| 9 | Link previews in notes (§3.2) | D | — | — |

## MVP queue (Phase 1, in dependency order)

Nothing is in flight: reminders part 1 (PR #41), the phone app (PR #40, release follow-up PR #42), change history (Q3, PR #44), the jobs runner (Q1, PR #46), reminders part 2 (Q10, PR #48), rich text (Q2), the audit log (Q6) and profile and preferences (Q7) are merged, so every remaining wave 1 and wave 2 slice, Q11, Q12, Q15 reminders part 3, Q16, Q19 and Q31 are ready. Take the first slice whose "needs" are merged; slices in one wave may run in parallel sessions unless the audit's section 3 lists them as sharing files. The audit \`docs/superpowers/plans/2026-10-28-mvp-queue.md\` has each slice's full scope, files and the dependency graph. Sizes: S about one task, M two or three, L four or more.

- Wave 3: **Q11** calendar sections, favourites, mute (row 4; needs Q7; M). **Q12** admin staff and roles: deactivation, location-admin moderation, \`tl admin staff\` (rows 26, 27; needs Q6; M). **Q13** photo thumbnails, metadata stripping, cover frames, and the text preview on a note file's card (US-6.1) (row 15; needs Q1; L). **Q14** custom reminder texts, the invite offer and short codes in SMS text shown as links (row 7; M). **Q15** reminders part 3: reply actions, \`/move\`, \`/cancel\`, calendar buttons, Confirm and Snooze (rows 22, 23, 24; needs Q10; L). **Q16** two-step sign-in, recovery codes, sessions page, leaked-password list (row 29; needs Q6; M).
- Wave 4: **Q17** admin workspace, locations, connections overview, booking settings (change window, cancellation policy, change history retention), audit log retention settings (AC-9.5, §5.5; replaces the guard's constants through a migration), health page, reindex job, allowed attachment types (US-6.6, row 15) (rows 27, 8, 10, 28, 37, 15; needs Q12, Q1; L). **Q18** locations with default services and location admin (rows 5, 26, 1; needs Q12; L). **Q19** availability and manual status, and a \`staff.updated\` event, so another device and other people see a changed name, zone or hours before their next reload (Q7 ruling R6; in no MVP criterion, so it does not hold row 14 open) (row 13; needs Q7; L). **Q20** S3 store, \`tl storage migrate\`, \`tl backup --to s3://\` (rows 17, 36; M). **Q21** resumable uploads and dedup (row 17; needs Q1, Q20; M). **Q22** video visits part 1: the media server, signalling, audio, degraded state (row 12; L).
- Wave 5: **Q23** video visits part 2: camera, screen share, the media port (row 12; needs Q22; M). **Q25** single sign-on presets, refresh, sign-out from the provider (row 30; needs Q17; M). **Q26** TypeScript SDK, \`tl\` API CLI, personal tokens (row 25; needs reminders part 1, Q10; L); \`tokenForbiddenRoute\` refuses every token on non-GET \`/me\` and on \`/me/preferences\`, so this slice decides whether a personal token may reach them. **Q27** calendar sync completion: self-test, more event kinds, a booking made from a message (row 22; needs Q15; M). **Q28** chart images in reports (row 23; S). **Q29** one timed install on a public host with a real certificate (row 35, US-12.1; needs a DNS name and open ports from the user), dropping the old cookie name in the release after Q5 (in no criterion), the installable web app, accessibility checks in CI, the unread marker after a reconnect, the closed-days switch, \`tl migrate --dry-run\`, storage in \`/readyz\`, the large search benchmark, and the parked clean-ups as later job kinds (old reminder rows, delivery records and expired \`sessions\`; in no MVP row or criterion, so they do not hold the row open) (rows 1, 10, 32, 35, 36, 37; its web half has no dependency; M). **Q30** a reminder withdrawn or not shown when read on another device (row 19; needs Q19 and the phone app; S). **Q31** phone app completion: memory measured on a real device, end-to-end smoke tests on both phone systems (hosted runners or a device the user provides), a reminder tap opening its appointment (row 33; needs the phone app; S to M). \`trellis://\` admits appointment paths only, so a note link \`/n/<id>\` is not a deep link: not an MVP requirement, decide it here.

The user picks among slices that are ready; a slice that finishes a row partly adds its leftovers here before it merges.
`

/** workflow-prose.md */
export const WORKFLOW_PROSE = `# Trellis WORKFLOW.md (invented)

Invented text for the migration tests, in the shape of a docs/WORKFLOW.md that states its process in prose: an auto-merge section and an environment section. Trellis is a made-up booking service for clinics.

## 5. Auto-merge mode

Auto-merge is on (the user approved it at the start, paused it on 2026-10-22 for PR #10, which
they then asked the lead to merge, and turned it back on the next day with "if it passes,
merge it from now on"). The lead merges a slice's or a fix's PR itself when **all** of these hold:

- CI is green on the head commit and the PR is mergeable. A PR that changes only \`docs/**\`,
  \`README.md\`, \`CLAUDE.md\` or \`LICENSE\` runs no CI (the workflow's \`paths-ignore\`, 2026-10-26); it
  merges once the lead has checked it is mergeable and nothing outside those paths changed.
  Any other PR runs the \`Changed areas\` job first (\`.github/scripts/changed-areas.sh\`): the server,
  web and container jobs whose paths the PR leaves untouched show as skipped, and a skipped
  job counts as green. A push to \`main\` runs every job.
- The final review has no open Critical or Important finding.
- Every parked item has a ruling in the ledger.
- The lead ran \`make check\` and \`make gen-check\` on the head itself.

Merge with a merge commit. After each merge, post a short summary: what shipped, the
rulings made, what is parked, and how many tokens the slice's subagents used. Then start
the next slice without waiting.

Plans are still written to \`docs/superpowers/plans/\` but the lead does not pause for
review of them.

**Stop and ask the user only for:** product decisions the spec leaves open; security
trade-offs; CI that cannot be made green; anything touching credentials, external
services, or cost outside the session (new hosted dependencies, paid APIs). If GitHub
refuses a merge, say so and fall back to a normal PR for the user to merge.

**Pause** when the user asks (usually for a usage limit): finish the current task, leave
the branch pushed and the ledger current, cancel any scheduled check-ins, unsubscribe from
PR events, and say what the next command is.

## 7. Environment

- Database tests: start Postgres in the container with \`service postgresql start\`, then
  export \`TL_TEST_DATABASE_URL='postgres://user:pass@localhost:5432/trellis?sslmode=disable'\`.
  Tests skip silently when it is unset, which makes a red test look green; the lead checks
  that the database tests ran.
- \`make tools\` installs the pinned code generator; \`make gen\` regenerates everything; commit the
  output.
- A container restart ends background agents without a word and the task clock keeps running.
  Implementers commit as soon as tests pass, not at the end; the lead dispatches again from
  the working tree that is left. Give every long command a timeout.
- Worktrees live in Claude Code's default place, \`.claude/worktrees/\` inside the clone (the user's
  layout since 2026-10-29; \`.gitignore\` and \`.dockerignore\` exclude it). A lead session creates
  its slice worktree with the \`EnterWorktree\` tool and a \`name\` (\`.claude/worktrees/<slice>\`),
  renames the generated branch to \`feat/<slice>\` (\`git branch -m\`), and removes it with
  \`ExitWorktree\` (\`remove\`) after the merge. A second lead session is started from the clone
  and does the same with its own name.
- Parallel tasks each get their own git worktree of the one clone, under
  \`.claude/worktrees/<slice>-t<N>\` on a local branch \`feat/<slice>-t<N>\` made from the slice head
  (\`git worktree add .claude/worktrees/<slice>-t<N> -b feat/<slice>-t<N> <sha>\`, then \`npm ci\` in its
  \`web/\`); the lead merges the task commit into the slice branch after review, then removes the worktree
  and deletes the local branch. A reviewer's own checkout goes under the session's temporary directory
  and the reviewer removes it.
- The slice worktree is shared with the running implementer. The lead commits its own
  docs changes there with explicit paths (\`git add <file>\` then \`git commit\`, never \`-a\`),
  or waits for the hand-back: a \`commit -a\` once took an implementer's unfinished edits
  into a docs commit and the history had to be rebuilt before the review.
- Token usage: the session cannot see the plan's usage; it reports the tokens its
  subagents used per task and per slice, which is what the ledger records.

`
