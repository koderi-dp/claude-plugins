# Catalo work queue

Trimmed copy of catalo's docs/backlog.md (2026-11-05) for the migration tests: the Statuses line, nine rows of the current position table, three rows of plan 1b's proposed work table, one named follow-ups section and the remaining delivery phase 1 section.

Statuses: **Queued** → **Brainstorming** → **Planning** → **Ready** → **Implementing** →
**Review** → **Done**. Ready means the design/plan gates are satisfied; Done means the
required verification/reviews and recorded integration are complete. Record **Blocked**
with the cause and next action when needed. A proposal listed here remains unapproved.

## Current position

AstroVista theme preset (`735cec7`) and verification speedups (`7acb7f2`) are merged to
`main` and pushed. Next queue item: catalog builder and PDF delivery (delivery phase 1).

| Work | Status | Evidence / next action |
| --- | --- | --- |
| Foundation implementation plan, Tasks 1–9 | Done | Reviewed, merged, and pushed; foundation plus deletion guard at `5ff7fd0`. |
| Plan 1b: tenant isolation | Done | Tasks 1–4 and final review complete; merged locally to main (`36da4b2`); no push. |
| Catalog UI fixes (Keraterm review) | Done | From the user's review of the Keraterm data on 2026-11-02; merged as `9564f3e` ([PR #9](https://github.com/koderi-dp/catalo/pull/9)). [Design note](superpowers/specs/2026-11-02-category-picker-and-article-page-design.md). Category counts include subcategories and a category filter covers its subtree. |
| Hybrid editor, Phase B: document v2 | Done | From the parent session's brief (2026-11-04), branch `claude/editor-phase-b-559ab4`, [PR #24](https://github.com/koderi-dp/catalo/pull/24). [Design](superpowers/specs/2026-11-04-hybrid-editor-document-v2-design.md), [plan](superpowers/plans/2026-11-04-hybrid-editor-document-v2.md), [ledger](../.superpowers/sdd/2026-11-04-hybrid-editor-document-v2/progress.md). Page document v2: four margins, slot styles, padding, image fit (contain/cover), card box, visible fields and a code (`sku`) field. |
| Empty grid areas refilled (bug) | Queued | Cells emptied with Remove card are refilled with new empty cards by the next card resize, column/row change in the Page tab, or Add a row: `resizeSlot` (`apps/web/src/catalog/slot-resize-model.ts`) and `setGridTracks` (`apps/web/src/catalog/page-geometry-model.ts`) both call `fillUncoveredCells`, which fills every uncovered cell on the page. This breaks Phase C's rule that removed cards leave empty areas. |
| Brand logos | Queued | Brands as records with a logo image, shown on product cards; `brand` is plain text today. The Keraterm pages show a manufacturer logo per card. |
| Table element | Queued | A free-layer table for specification and price tables (thermostats, radiators). A text box stands in until then. |
| Card style across pages | Later | Apply a card's style to every card that uses the same style in its section or the whole catalog, so a design change (for example the price colour on the tile card) reaches pages already built from a template. Revisit if one design has to be shared by many templates. |
| Integrations, ERP connectors, AI | Later | Delivery phases 2–4 of the platform spec. |

The completed **foundation plan** is only part of the spec's broader **delivery phase 1**.

## Plan 1b — tenant isolation (complete, merged)

Deferred findings from the final review, kept here as proposed work:

| Reference in final review | Proposed work |
| --- | --- |
| Minor 5; Task 5 bootstrap retry | Repair a missing default price list after a bootstrap failure. |
| Task 4 membership-query cost | Revisit repeated organization/membership queries during `context.db` integration. |
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
| Categories dialog parent picker | The categories page's parent field still uses the flat path `Select`; swap it for `CategoryPicker` when that dialog is next touched. |


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
      **Slice 1 done** (screen output, 2026-11-03): the `pdf-renderer` container (Chromium
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
      **Slice 3 done** (approval and publish, 2026-11-04): `catalog_snapshot`, statuses
      `draft → approved → exported`, exports bound to a snapshot, price-drift warning,
      "Published" in the UI, legal holds and retention
      ([PR #23](https://github.com/koderi-dp/catalo/pull/23)). PDF/X-4 validity is checked
      structurally only, so this item stays open until a print shop accepts a real export.
      Background: the
      [print test](../.superpowers/sdd/2026-11-03-print-test/report.md) proved the Chromium half.
- [ ] Preflight for resolution, safe areas, embedded fonts, and PDF/X validity; renderer
      snapshot/PDF tests and end-to-end catalog-to-print verification. **Slice 1 done:** the
      screen rules (`box_mismatch`, font, text and image codes, `element_in_bleed`,
      `text_overflow`) run on every export from `inspect-pdf.ts` and show in the Export dialog
      ([codes](pdf-delivery.md#preflight)). **Slice 2 done:** the print rules
      (`colour_space` as an allow-list, `output_intent_missing`, `pdfx_structure`,
      `rich_neutral`, `overprint_missing`, `overprint_light_text` and the 300 dpi error) run
      on print exports. PDF/X validity is checked
      structurally only; true conformance needs the print shop's preflight or a commercial tool
      (see the decisions below).

