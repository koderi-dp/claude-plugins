# Larder work queue

Invented text for the migration tests, in the shape of a docs/backlog.md that grew by hand: a Statuses line, nine rows of a current position table, three rows of a proposed work table, one named follow-ups section and a remaining delivery phase section. Larder is a made-up recipe and menu planner.

Statuses: **Queued** → **Brainstorming** → **Planning** → **Ready** → **Implementing** →
**Review** → **Done**. Ready means the design and plan are agreed; Done means the checks,
the reviews and the merge are on record. Write **Blocked** with the cause and the next
step when it applies. A proposal listed here is not approved yet.

## Current position

Seasonal colour preset (`1a2b3c4`) and faster checks (`5d6e7f8`) are merged to `main` and
pushed. Next queue item: menu builder and print delivery (delivery phase 1).

| Work | Status | Evidence / next action |
| --- | --- | --- |
| Core data model plan, Tasks 1–7 | Done | Reviewed, merged, and pushed; the model plus the delete guard at `a1b2c3d`. |
| Plan 1b: kitchen separation | Done | Tasks 1–4 and final review complete; merged locally to main (`4e5f6a7`); no push. |
| Recipe list fixes (Hearth review) | Done | From the user's review of the Hearth data on 2026-11-02; merged as `0c9d8e7` ([PR #9](https://github.com/example-org/larder/pull/9)). [Design note](superpowers/specs/2026-11-02-ingredient-picker-and-recipe-page-design.md). Ingredient counts include sub-groups and a group filter covers everything under it. |
| Menu editor, Phase B: card layout v2 | Done | From the parent session's brief (2026-11-04), branch `claude/menu-phase-b-12ab34`, [PR #24](https://github.com/example-org/larder/pull/24). [Design](superpowers/specs/2026-11-04-menu-editor-card-layout-v2-design.md), [plan](superpowers/plans/2026-11-04-menu-editor-card-layout-v2.md), [ledger](../.superpowers/sdd/2026-11-04-menu-editor-card-layout-v2/progress.md). Card layout v2: four margins, dish styles, spacing, photo fit (whole or cropped), a frame, shown fields and a short code field. |
| Empty menu slots refilled (bug) | Queued | Slots emptied with Remove dish are filled with new empty dishes by the next resize, by a column or row change in the Card tab, or by Add a row: `resizeSlot` (`apps/web/src/menu/slot-resize.ts`) and `setTracks` (`apps/web/src/menu/card-geometry.ts`) both call `fillOpenSlots`, which fills every open slot on the card. This breaks Phase C's rule that removed dishes leave empty slots. |
| Supplier logos | Queued | Suppliers as records with a logo image, shown on ingredient rows; `supplier` is plain text today. The Hearth sheets show a supplier logo per row. |
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
| Units dialog parent picker | The units page's parent field still uses the flat `Select`; swap it for `GroupPicker` when that dialog is next touched. |


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
      **Slice 1 done** (screen output, 2026-11-03): the `print-renderer` container, the
      page boxes, embedded fonts, the job runner and the Print dialog;
      [design](superpowers/specs/2026-11-03-print-delivery-design.md),
      [plan](superpowers/plans/2026-11-03-print-delivery-slice-1.md),
      [ledger](../.superpowers/sdd/2026-11-03-print-delivery-slice-1/progress.md),
      [operations](print-delivery.md). **Slice 2 done** (press profile, 2026-11-03): grey
      text printed in black only, the press colour profile, photos kept at full size and
      the press checks; [plan](superpowers/plans/2026-11-03-print-delivery-slice-2.md),
      [ledger](../.superpowers/sdd/2026-11-03-print-delivery-slice-2/progress.md).
      **Slice 3 done** (approval and publish, 2026-11-04): statuses
      `draft → approved → printed`, prints bound to a snapshot, a price-change warning and
      "Published" in the UI ([PR #23](https://github.com/example-org/larder/pull/23)).
      This item stays open until a print shop accepts a real file.
- [ ] Print checks for resolution, safe areas, embedded fonts, and press validity; renderer
      image tests and an end-to-end menu-to-print check. **Slice 1 done:** the
      screen rules (`box_mismatch`, font, text and photo codes, `text_overflow`) run on
      every print and show in the Print dialog ([codes](print-delivery.md#checks)).
      **Slice 2 done:** the press rules (`colour_space`, `profile_missing`,
      `rich_grey` and the 300 dpi error) run on press prints. Press validity is checked
      by structure only; a full check needs the print shop's own tool
      (see the decisions below).

