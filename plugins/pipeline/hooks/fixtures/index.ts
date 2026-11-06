// Generated from the Markdown fixtures in this folder, which are trimmed copies of two real projects.
// Tests can only import TypeScript, so the texts live here too; regenerate after editing a .md file:
//   cd plugins/pipeline/hooks/fixtures && node generate.cjs

/** catalo-backlog.md */
export const CATALO_BACKLOG = `# Catalo work queue

Trimmed copy of catalo's docs/backlog.md (2026-11-05) for the migration tests: the Statuses line, nine rows of the current position table, three rows of plan 1b's proposed work table, one named follow-ups section and the remaining delivery phase 1 section.

Statuses: **Queued** → **Brainstorming** → **Planning** → **Ready** → **Implementing** →
**Review** → **Done**. Ready means the design/plan gates are satisfied; Done means the
required verification/reviews and recorded integration are complete. Record **Blocked**
with the cause and next action when needed. A proposal listed here remains unapproved.

## Current position

AstroVista theme preset (\`735cec7\`) and verification speedups (\`7acb7f2\`) are merged to
\`main\` and pushed. Next queue item: catalog builder and PDF delivery (delivery phase 1).

| Work | Status | Evidence / next action |
| --- | --- | --- |
| Foundation implementation plan, Tasks 1–9 | Done | Reviewed, merged, and pushed; foundation plus deletion guard at \`5ff7fd0\`. |
| Plan 1b: tenant isolation | Done | Tasks 1–4 and final review complete; merged locally to main (\`36da4b2\`); no push. |
| Catalog UI fixes (Keraterm review) | Done | From the user's review of the Keraterm data on 2026-11-02; merged as \`9564f3e\` ([PR #9](https://github.com/koderi-dp/catalo/pull/9)). [Design note](superpowers/specs/2026-11-02-category-picker-and-article-page-design.md). Category counts include subcategories and a category filter covers its subtree. |
| Hybrid editor, Phase B: document v2 | Done | From the parent session's brief (2026-11-04), branch \`claude/editor-phase-b-559ab4\`, [PR #24](https://github.com/koderi-dp/catalo/pull/24). [Design](superpowers/specs/2026-11-04-hybrid-editor-document-v2-design.md), [plan](superpowers/plans/2026-11-04-hybrid-editor-document-v2.md), [ledger](../.superpowers/sdd/2026-11-04-hybrid-editor-document-v2/progress.md). Page document v2: four margins, slot styles, padding, image fit (contain/cover), card box, visible fields and a code (\`sku\`) field. |
| Empty grid areas refilled (bug) | Queued | Cells emptied with Remove card are refilled with new empty cards by the next card resize, column/row change in the Page tab, or Add a row: \`resizeSlot\` (\`apps/web/src/catalog/slot-resize-model.ts\`) and \`setGridTracks\` (\`apps/web/src/catalog/page-geometry-model.ts\`) both call \`fillUncoveredCells\`, which fills every uncovered cell on the page. This breaks Phase C's rule that removed cards leave empty areas. |
| Brand logos | Queued | Brands as records with a logo image, shown on product cards; \`brand\` is plain text today. The Keraterm pages show a manufacturer logo per card. |
| Table element | Queued | A free-layer table for specification and price tables (thermostats, radiators). A text box stands in until then. |
| Card style across pages | Later | Apply a card's style to every card that uses the same style in its section or the whole catalog, so a design change (for example the price colour on the tile card) reaches pages already built from a template. Revisit if one design has to be shared by many templates. |
| Integrations, ERP connectors, AI | Later | Delivery phases 2–4 of the platform spec. |

The completed **foundation plan** is only part of the spec's broader **delivery phase 1**.

## Plan 1b — tenant isolation (complete, merged)

Deferred findings from the final review, kept here as proposed work:

| Reference in final review | Proposed work |
| --- | --- |
| Minor 5; Task 5 bootstrap retry | Repair a missing default price list after a bootstrap failure. |
| Task 4 membership-query cost | Revisit repeated organization/membership queries during \`context.db\` integration. |
| Task 4 organization plugin endpoints | Review the boundary between cross-organization auth tables and tenant data; keep deletion disabled. |

Migration decision: there are no existing deployments. If the composite-FK migration finds
invalid links, stop with clear diagnostics and leave data unchanged.

### Named follow-ups after the Keraterm review

From the user's article list and article page mocks (2026-11-02); each needs data or a
feature that does not exist yet, so none was built in the catalog UI fixes.

| Follow-up | Deferred work and reason |
| --- | --- |
| Brand and price-list filters | The list mock filters by brand and by price list. Brands are plain text on articles; a brand filter needs a distinct-brand query and a list parameter, and a price-list filter changes which price the list shows. |
| Article editing and status | The page mock has an Edit button and an "Active" status. There is no article edit form and no status column; both need a design (which fields are editable after an import, what inactive means for catalogs). |
| Attributes, Catalogs and History tabs | The page mock's Key information card and the Attributes, Catalogs and History tabs need article attributes (done as "Article spec fields": the page has a Specifications card, not yet a tab), a reverse index of catalog... |
| New article | The mocks' "New article" button needs a create form; articles come from import today. |
| Categories dialog parent picker | The categories page's parent field still uses the flat path \`Select\`; swap it for \`CategoryPicker\` when that dialog is next touched. |


## Remaining delivery phase 1 — catalog builder and print

These are spec requirements awaiting detailed plans. Their grouping and order below are a
proposed sequence after 1b and plan 2, not approved implementation plans.

- [ ] Versioned page document schema, migrations, shared renderer, and renderer fixtures.
      Implementation in progress: [design](superpowers/specs/2026-10-31-page-document-renderer-design.md)
      and [four-task plan](superpowers/plans/2026-10-31-page-document-renderer.md).
      Migrations here are JSON schema migrations, not new database tables. Includes actual
      strict PNG fixture comparisons; editor, persistence and PDF delivery remain later.
- [x] Reusable page templates, category defaults, and per-page template selection. Phase C
      ([design](superpowers/specs/2026-11-04-hybrid-editor-templates-design.md)); template version
      history is a [follow-up](#named-follow-ups-after-phase-c).
- [x] Catalog sections, deterministic auto-fill, template switching, and unplaced-article
      counts/warnings with undo support. Phase C; server-side re-fill of existing pages and moving
      pages between sections are [follow-ups](#named-follow-ups-after-phase-c).
- [ ] Hybrid editor: Phase A delivered the canvas, free layer, thumbnails, properties/layers
      panels and category filter. Phase B (page document v2: page size and orientation, margins,
      grid, per-card styling, slot resize, new row, lock/hide/group, trimmed preview) merged in
      [PR #24](https://github.com/koderi-dp/catalo/pull/24). Phase C (template mode, the Layouts and
      Templates tools, sections, cards in empty areas) merged in [PR #26](https://github.com/koderi-dp/catalo/pull/26);
      the Images tool (image library, free-layer images, per-card image choice) is in review in
      [PR #25](https://github.com/koderi-dp/catalo/pull/25); picker virtualization and designed page import remain.
- [x] Draft autosave, undo/redo, and single-editor page locks/heartbeats (slice 2, merged).
- [ ] Draft version history: stored versions and restore; undo is per editing visit today.
- [x] Article families from code rules and manual grouping; family boxes, variant selection,
      placement choice/preferences, and family price display. Merged in
      [PR #22](https://github.com/koderi-dp/catalo/pull/22) (see the queue row).
- [x] Catalog approval and immutable field/price snapshots, including family variants.
      PDF delivery slice 3, [PR #23](https://github.com/koderi-dp/catalo/pull/23): the snapshot
      captures the placed articles and families, and drift compares family members too.
- [x] Export jobs, object storage/downloads, and dashboard catalogs/recent exports.
      Local storage default is RustFS (decision 2026-10-31), behind a provider-neutral
      S3-compatible interface; the pinned store, image gallery and retention rules landed in
      slice 3 ([operations](storage.md)). Export jobs, stored export objects, downloads and
      Recent exports landed with PDF delivery slice 1 ([operations](pdf-delivery.md)). Legal holds
      on approved assets and snapshot PDFs and the approval snapshot lifetime landed with PDF
      delivery slice 3 ([operations](pdf-delivery.md#approval-and-publish)); the organization
      purge of held versions is a [follow-up](#named-follow-ups-after-pdf-delivery-slice-3).
- [ ] PDF renderer service with Chromium screen output and Chromium/Ghostscript print
      output; embedded fonts, bleed/crop marks, ICC conversion, and PDF/X-4 validation.
      **Slice 1 done** (screen output, 2026-11-03): the \`pdf-renderer\` container (Chromium
      only), TrimBox and BleedBox, embedded subset fonts, the export runner and Export UI;
      [design](superpowers/specs/2026-11-03-pdf-delivery-design.md),
      [plan](superpowers/plans/2026-11-03-pdf-delivery-slice-1.md),
      [ledger](../.superpowers/sdd/2026-11-03-pdf-delivery-slice-1/progress.md),
      [operations](pdf-delivery.md). **Slice 2 done** (print profile, 2026-11-03): neutral-to-gray pass with K text
      overprint, Ghostscript 10.05.1 PDF/X-4 with the ECI PSO Coated v3 output intent, DCT
      image re-encoding without downsampling, the print preflight rules and structural PDF/X
      checks, Ghostscript and the vendored profile in the renderer image;
      [design](superpowers/specs/2026-11-03-pdf-delivery-design.md),
      [plan](superpowers/plans/2026-11-03-pdf-delivery-slice-2.md),
      [ledger](../.superpowers/sdd/2026-11-03-pdf-delivery-slice-2/progress.md),
      [operations](pdf-delivery.md#print-profile). veraPDF is not used (it validates PDF/A and
      PDF/UA only).
      **Slice 3 done** (approval and publish, 2026-11-04): \`catalog_snapshot\`, statuses
      \`draft → approved → exported\`, exports bound to a snapshot, price-drift warning,
      "Published" in the UI, legal holds and retention
      ([PR #23](https://github.com/koderi-dp/catalo/pull/23)). PDF/X-4 validity is checked
      structurally only, so this item stays open until a print shop accepts a real export.
      Background: the
      [print test](../.superpowers/sdd/2026-11-03-print-test/report.md) proved the Chromium half.
- [ ] Preflight for resolution, safe areas, embedded fonts, and PDF/X validity; renderer
      snapshot/PDF tests and end-to-end catalog-to-print verification. **Slice 1 done:** the
      screen rules (\`box_mismatch\`, font, text and image codes, \`element_in_bleed\`,
      \`text_overflow\`) run on every export from \`inspect-pdf.ts\` and show in the Export dialog
      ([codes](pdf-delivery.md#preflight)). **Slice 2 done:** the print rules
      (\`colour_space\` as an allow-list, \`output_intent_missing\`, \`pdfx_structure\`,
      \`rich_neutral\`, \`overprint_missing\`, \`overprint_light_text\` and the 300 dpi error) run
      on print exports. PDF/X validity is checked
      structurally only; true conformance needs the print shop's preflight or a commercial tool
      (see the decisions below).

`

/** openhuddle-claude.md */
export const OPENHUDDLE_CLAUDE = `# openhuddle CLAUDE.md (trimmed)

Trimmed copy of openhuddle's CLAUDE.md (2026-11-05) for the migration tests: ten rows of the MVP status table and the whole MVP queue section.

## MVP status

The rows tagged MVP in SPEC Part 3 (37 at the audit, 36 since LDAP moved to V1), checked against \`main\` (audit \`docs/superpowers/plans/2026-10-28-mvp-queue.md\`, 2026-10-28). **A row is done only when every MVP user story and acceptance criterion of it is met on \`main\`, or the user moved the rest out of the MVP with a SPEC §6.5 entry.** A lead never marks an MVP part "V1" or "later" without that entry; until the user decides, the item reads "decision pending". This table, not the history in "Next slices", is where leftovers live: a slice's docs step updates its rows here (WORKFLOW §1 step 7). Status: D done, P partly done, IP in progress, N not started; the last column is the queued slice that closes the rest.

| # | Row (SPEC) | St. | Missing on \`main\` | Slice |
|---|---|---|---|---|
| 1 | Channels, join/leave, topic, description (§3.1) | P | archived toggle in the switcher (AC-1.7); move between teams (US-1.7) | Q29, Q18 |
| 2 | 1:1 and group DMs (§3.1) | D | (convert to private channel, AC-1.8: V1, M6) | — |
| 3 | Threads with live summary line (§3.1) | D | — | — |
| 4 | Sidebar sections, stars, mute (§3.1) | P | sections, stars, mute, order and collapse on the synced document (US-1.6, AC-1.6; the document and its 2 s sync are on \`main\`, measured at 310 ms) | Q11 |
| 5 | Teams with default channels (§3.1) | N | teams, team admin, default channels (US-1.2, AC-1.2 first half) | Q18 |
| 6 | Markdown, code blocks with highlighting, copy, collapse (§3.2) | D | — | — |
| 7 | Mentions, reactions, custom emoji (§3.2) | P | custom emoji; "invite to channel" for a non-member mention (AC-2.5); a Slack \`:shortcode:\` in webhook text shows as text (Q4 G1) | Q14 |
| 8 | Edit (with history), delete, pin, quote (§3.2) | P | edit window and tombstone policy settings (US-2.5, AC-2.8); edit history retention per policy (AC-2.8), which also purges revisions an older instance left during a rolling upgrade (Q3 ruling R10) | Q17 |
| 9 | Link previews, integration unfurls (§3.2) | D | — | — |

## MVP queue (Phase 1, in dependency order)

Nothing is in flight: bots part 1 (PR #41), the desktop app (PR #40, release follow-up PR #42), edit history (Q3, PR #44), the jobs runner (Q1, PR #46), bots part 2 (Q10, PR #48), syntax highlighting (Q2), the audit log (Q6) and profile and preferences (Q7) are merged, so every remaining wave 1 and wave 2 slice, Q11, Q12, Q15 bots part 3, Q16, Q19 and Q31 are ready. Take the first slice whose "needs" are merged; slices in one wave may run in parallel sessions (WORKFLOW §1) unless the audit's section 3 lists them as sharing files. The audit \`docs/superpowers/plans/2026-10-28-mvp-queue.md\` has each slice's full scope, files and the dependency graph. Sizes: S about one task, M two or three, L four or more.

- Wave 3: **Q11** sidebar sections, stars, mute (row 4; needs Q7; M). **Q12** admin users and roles: deactivation, channel-admin moderation, \`oh admin user\` (rows 26, 27; needs Q6; M). **Q13** thumbnails, EXIF stripping, poster frames, and the text preview on a text file's card (US-6.1) (row 15; needs Q1; L). **Q14** custom emoji, the invite offer and Slack shortcodes in webhook text shown as emoji (row 7; M). **Q15** bots part 3: card actions, \`/ado\`, \`/alerts\`, Azure DevOps buttons, Ack and Silence (rows 22, 23, 24; needs Q10; L). **Q16** TOTP, recovery codes, sessions page, breach list (row 29; needs Q6; M).
- Wave 4: **Q17** admin workspace, channels, integrations overview, message settings (edit window, tombstone policy, edit history retention), audit log retention settings (AC-9.5, §5.5; replaces the guard's constants through a migration), health page, reindex job, allowed upload types (US-6.6, row 15) (rows 27, 8, 10, 28, 37, 15; needs Q12, Q1; L). **Q18** teams with default channels and team admin (rows 5, 26, 1; needs Q12; L). **Q19** presence and manual status, and a \`user.updated\` event, so another device (the user's own \`me\` included) and other people see a changed display name, zone or hours before their next bootstrap (Q7 ruling R6; in no MVP criterion, so it does not hold row 14 open) (row 13; needs Q7; L). **Q20** S3 store, \`oh storage migrate\`, \`oh backup --to s3://\` (rows 17, 36; M). **Q21** resumable uploads and dedup (row 17; needs Q1, Q20; M). **Q22** huddles part 1: LiveKit, signaling, audio, degraded state (row 12; L).
- Wave 5: **Q23** huddles part 2: video, screen share, \`media.udp\` (row 12; needs Q22; M). **Q25** OIDC presets, refresh, back-channel logout (row 30; needs Q17; M). **Q26** TypeScript SDK, \`oh\` API CLI, personal tokens (row 25; needs bots part 1, Q10; L); \`tokenForbiddenRoute\` refuses every token on non-GET \`/me\` and on \`/me/preferences\`, so this slice decides whether a personal token may reach them. **Q27** Azure DevOps completion: self-test, more unfurls and events, work item from message (row 22; needs Q15; M). **Q28** Grafana panel images (row 23; S). **Q29** one timed install on a public host against Let's Encrypt (row 35, US-12.1; needs a DNS name and open ports from the user), dropping the old session cookie name from \`SessionCookieNames\` in the release after Q5 (ruling R11 of the ACME slice; in no criterion), PWA, axe-core in CI (which must decide \`scrollable-region-focusable\` on an overflowing code block in an inactive row: the roving tab stop of \`row-nav.ts\`, on \`main\` before Q2 and ruled out of Q2 by R16), unread marker after reconnect, archived toggle, \`oh migrate --dry-run\`, \`/readyz\` storage, the 10 M search benchmark, and the parked prunes as later job kinds of \`cmd/oh/jobs.go\` (resolved \`alerts\` rows, \`integration_objects\`, \`webhook_deliveries\` idempotency rows, \`auth_limits\` rows and expired \`sessions\`; in no MVP row or criterion, so they do not hold the row open) (rows 1, 10, 32, 35, 36, 37; its web half has no dependency; M). **Q30** a pop-up withdrawn or not shown when read on another device (row 19; needs Q19 and the desktop app; S). **Q31** desktop completion: AC-11.3 memory measured on real hardware with a GPU, Windows and macOS end-to-end smoke tests (hosted runners or a machine the user provides), a notification click opening its channel (row 33; needs the desktop app; S to M). \`openhuddle://\` admits channel paths only, so a snippet permalink \`/s/<id>\` is not a deep link: not an MVP requirement, decide it here.

The user picks among slices that are ready; a slice that finishes a row partly adds its leftovers here before it merges.
`

/** openhuddle-workflow.md */
export const OPENHUDDLE_WORKFLOW = `# openhuddle WORKFLOW.md (trimmed)

Trimmed copy of openhuddle's docs/WORKFLOW.md (2026-11-05) for the migration tests: the auto-merge section and the environment section.

## 5. Auto-merge mode

Auto-merge is on (the user approved it at the start, paused it on 2026-10-22 for PR #10, which
they then asked the lead to merge, and turned it back on on 2026-10-23 with "if it's validated,
auto merge from now"). The lead merges a slice's or a fix's PR itself when **all** of these hold:

- CI is green on the head commit and the PR is mergeable. A PR that changes only \`docs/**\`,
  \`README.md\`, \`CLAUDE.md\` or \`LICENSE\` runs no CI (the workflow's \`paths-ignore\`, 2026-10-26); it
  merges once the lead has checked it is mergeable and nothing outside those paths changed.
  Any other PR runs the \`Changed areas\` job first (\`.github/scripts/changed-areas.sh\`): the Go,
  web, Docker and cluster jobs whose paths the PR leaves untouched show as skipped, and a skipped
  job counts as green. A push to \`main\` runs every job.
- The final review has no open Critical or Important finding.
- Every parked item has a ruling in the ledger.
- The lead ran \`make check\` and \`make gen-check\` on the head itself.

Merge with a merge commit. After each merge, post a short summary: what shipped, the
rulings made, what is parked, and the slice's subagent token usage. Then start the next
slice without waiting.

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
  export \`OH_TEST_DATABASE_URL='postgres://user:pass@localhost:5432/openhuddle?sslmode=disable'\`.
  Tests skip silently when it is unset, which makes a red test look green; the lead checks
  that the integration tests ran.
- \`make tools\` installs the pinned sqlc; \`make gen\` regenerates everything; commit the
  output.
- Container restarts kill background agents silently and the task clock keeps running.
  Implementers commit as soon as tests pass, not at the end; the lead re-dispatches from
  the surviving working tree. Give every long command a timeout.
- Worktrees live in Claude Code's default place, \`.claude/worktrees/\` inside the clone (the user's
  layout since 2026-10-29; \`.gitignore\` and \`.dockerignore\` exclude it, and Go's tools skip dot
  directories). A lead session creates its slice worktree with the \`EnterWorktree\` tool and a \`name\`
  (\`.claude/worktrees/<slice>\`), renames the generated branch to \`feat/<slice>\` (\`git branch -m\`), and
  removes it with \`ExitWorktree\` (\`remove\`) after the merge, or answers the prompt at session exit. A
  sibling lead session is started from the clone and does the same with its own name.
- Parallel tasks each get their own git worktree of the one clone, under
  \`.claude/worktrees/<slice>-t<N>\` on a local branch \`feat/<slice>-t<N>\` made from the slice head
  (\`git worktree add .claude/worktrees/<slice>-t<N> -b feat/<slice>-t<N> <sha>\`, then \`npm ci\` in its
  \`web/\`); the lead merges the task commit into the slice branch after review, then removes the worktree
  and deletes the local branch. Reviewers' scratch checkouts go under the session's temporary directory
  and are removed by the reviewer.
- The slice worktree is shared with the running implementer. The lead commits its own
  docs changes there with explicit paths (\`git add <file>\` then \`git commit\`, never \`-a\`),
  or waits for the hand-back: a \`commit -a\` once swept an implementer's half-done edits
  into a WORKFLOW commit and the history had to be rebuilt before the review.
- Token usage: the session cannot see the plan's usage; it reports the tokens its
  subagents consumed per task and per slice, which is what the ledger records.

`
