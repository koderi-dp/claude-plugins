# Larder work queue

Invented text for the migration tests, in the shape of a docs/backlog.md with one row per item: the open decisions, thirteen queue rows across the six states and four done rows. Larder is a made-up recipe and menu planner.

One row per item, in priority order: Item · Size · State · Scope · Links. Sizes `tiny`,
`small`, `medium` and `large` set how much process an item gets. States: `Queued`,
`Running`, `Review` (PR open), `Done`, `Later`, `Blocked` (with the blocker). The summary of
the spec is the [roadmap](roadmap.md); history is in the [archive][archive].

## Open decisions

- 2026-11-03 · user · The type foundry's written permission to embed `Marlow-Text.otf` (or a font swap) before any public repository or a build shared outside the company.
- 2026-11-03 · user · Buy a print proofing tool, or take the print shop's check of the first production file as the acceptance check; ask the shop for its required colour profile.
- 2026-11-03 · user · Confirm the font and icon licence obligations in [licensing](licensing.md) before any public deployment.

## Queue

Running and Review rows first, then Queued, then Later. Folded follow-up rows list their items in [the fold list][fold].

<!-- prettier-ignore -->
| Item | Size | State | Scope | Links |
| --- | --- | --- | --- | --- |
| menu-cover-image — Menu cover image | medium | Running | A card setting beside the background colour: a photo from the photo library, fill the card or fit inside, optional opacity, always behind every dish and covering the bleed; templates carry it. User request, 2026-11-09. | Renderer change |
| sidebar-widths — Adjustable editor side panels | small | Review | Drag handles between the editor's left panel and the canvas, and between the canvas and the right panel, so each panel can be widened or narrowed within sensible limits; widths remembered per browser. User request, 2026-11-09. | |
| colour-themes — Colour themes per user | small | Blocked | Waits for the user's choice of the theme set (for example Paper, Slate, Harbour, Olive). Themes change the app's look only (colour tokens in `apps/web/src/styles.css`). User request, 2026-11-09. | |
| course-column-sizes — Course row and column sizes | medium | Queued | A grid row or column with a fixed size in mm (a thin heading row) while the others share the rest: card layout (v2 compatible), renderer, editor geometry, Card tab and "with heading" presets. Prints of cards without fixed sizes stay identical. User request, 2026-11-05. | Renderer change |
| supplier-logos — Supplier logos | medium | Queued | Suppliers as records with a logo image, shown on ingredient rows; `supplier` is plain text today. The Hearth sheets show a supplier logo per row. | |
| two-sided-cards — Two-sided cards | large | Queued | View both sides together in the editor and print them as one sheet; the Hearth menu is laid out and delivered two-sided. Single sides print correctly without it. | |
| course-delete-dishes — Delete a course with its dishes | small | Queued | The Delete course dialog offers Keep dishes (default) or Delete course and N dishes: warn about dishes edited after the fill, refuse while another user holds a lock, one transaction. User request, 2026-11-05. | |
| multi-card-delete-clear — Multi-card delete and clear | small | Queued | Select cards in the strip (Shift, Ctrl/Cmd-click) to Delete cards (count confirmed, never the last, refused while locked) or Clear card (layout kept, dishes emptied). User request, 2026-11-05. | Pairs with course-delete-dishes |
| templates-screen — Templates screen | tiny | Queued | A Templates screen in the app navigation: thumbnails, names, default courses and usage; New template opens `/templates/$id`; duplicate, rename, delete. User request, 2026-11-05. | |
| editor-hardening — Editor hardening | small | Queued | Controls look live while a lock is being taken and drop their edits; limited or refused edits give no hint; hidden dishes show editable geometry; save and lock edges of slice 2; Phase A leftovers. | [items][fold] |
| dish-style-across-menus — Dish style across menus | medium | Later | Apply a dish's style to every dish with the same style in its course or menu, so a design change reaches cards built from a template. Revisit if one design must be shared by many templates. | |
| worker-slice — Worker slice | large | Later | Background jobs: the storage sweep (orphans, unused photos, held versions), smaller photo copies made ahead of time, an index of where a photo is used. Delivery phase 2. | [items][fold] |
| integrations — Stock sync, till connectors, forecasts | large | Later | Delivery phases 2–4 of the product spec ([roadmap](roadmap.md#delivery-phases-24)). | |

## Done

Newest first. Deployed is the first date on the review machine; "—" means before there was one.
Finished ledgers, designs and plans are deleted at Done; read one with
`git show <commit>:.superpowers/sdd/<folder>/progress.md`.

<!-- prettier-ignore -->
| Item | Merged | Deployed | Ledger |
| --- | --- | --- | --- |
| edit-inside-groups — Edit inside groups | `6d1e2f3` (#35) | 2026-11-06 | `2026-11-06-edit-inside-groups` at `7a8b9c0` |
| print-delivery — Print delivery, slices 1–3 | `1f2e3d4` (#18, #21, #23) | 2026-11-04 | `2026-11-03-print-delivery-slice-1`, `-2`, `-3` |
| recipe-list-fixes — Recipe list fixes (Hearth review) | `0c9d8e7` (#9), `5b6a7c8` (#10) | 2026-11-02 | [archive][a-fix] |
| menu-builder-core — Menu builder core (slice 1) | `9e8d7c6` | — | [archive][a-core] |

[archive]: ../.superpowers/sdd/progress-archive.md
[fold]: ../.superpowers/sdd/followups.md#folded-follow-ups
[a-fix]: ../.superpowers/sdd/progress-archive.md#recipe-list-fixes
[a-core]: ../.superpowers/sdd/progress-archive.md#menu-builder-core
