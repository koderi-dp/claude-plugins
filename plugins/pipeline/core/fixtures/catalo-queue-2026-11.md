# Catalo work queue

Trimmed copy of catalo's docs/backlog.md after its 2026-11-05 rewrite, for the migration tests: the open decisions, thirteen queue rows across the six states (two of them changed from Queued to Running, Review and Blocked for the test) and four done rows.

One row per item, in priority order: Item · Size · State · Scope · Links. Sizes `tiny`,
`small`, `medium` and `large` set the workflow (`backlog-orchestrator` skill). States: `Queued`,
`Running`, `Review` (PR open), `Done`, `Later`, `Blocked` (with the blocker). Edit this file as
the `backlog-maintenance` skill says. The spec digest is the [roadmap](roadmap.md); history is in
the [archive][archive].

## Open decisions

- 2026-11-03 · user · ECI's written permission to redistribute `PSOcoated_v3.icc` (or a profile swap) before any public repository or an image distributed outside the organisation.
- 2026-11-03 · user · Buy a PDF/X validator (callas pdfToolbox, Acrobat Preflight), or take the print shop's preflight of the first production file as the conformance check; ask the shop for its required output profile.
- 2026-11-03 · user · Confirm the AGPL, GPL and ECI obligations in [licensing](licensing.md) before any public deployment.

## Queue

Running and Review rows first, then Queued, then Later. Folded follow-up rows list their items in [the fold list][fold].

<!-- prettier-ignore -->
| Item | Size | State | Scope | Links |
| --- | --- | --- | --- | --- |
| page-background-image — Page background image | medium | Running | A page setting beside the background colour: an image from the image library, fill page or fit inside, optional opacity, always behind every element and covering the bleed; templates carry it. User request, 2026-11-09. | Renderer change |
| panel-splitters — Resizable editor side panels | small | Review | Drag handles between the editor's left panel and the canvas, and between the canvas and the right inspector, so each panel can be widened or narrowed within sensible limits; widths remembered per browser. User request, 2026-11-09. | |
| app-themes — App themes per user | small | Blocked | Waits for the user's choice of the curated theme set from tweakcn (for example Claude, Clean Slate, Ocean Breeze, Sage Green). Themes change the app's look only (colour tokens in `apps/web/src/styles.css`). User request, 2026-11-09. | |
| grid-track-sizes — Grid row and column sizes | medium | Queued | A grid row or column with a fixed size in mm (a thin header row) while the others share the rest: page document (v2 compatible), renderer, editor geometry, Page tab and "with header" presets. Exports of documents without track sizes stay identical. User request, 2026-11-05. | Renderer change |
| brand-logos — Brand logos | medium | Queued | Brands as records with a logo image, shown on product cards; `brand` is plain text today. The Keraterm pages show a manufacturer logo per card. | |
| two-page-spreads — Two-page spreads | large | Queued | View facing pages together in the editor and export spreads; the Keraterm catalog is laid out and delivered as spreads. Single pages print correctly without it. | |
| section-delete-pages — Delete a section with its pages | small | Queued | The Delete section dialog offers Keep pages (default) or Delete section and N pages: warn about pages edited after the fill, refuse while another user holds a lock, one transaction. User request, 2026-11-05. | |
| multi-page-delete-clear — Multi-page delete and clear | small | Queued | Select pages in the strip (Shift, Ctrl/Cmd-click) to Delete pages (count confirmed, never the last, refused while locked) or Clear page (layout kept, cards emptied). User request, 2026-11-05. | Pairs with section-delete-pages |
| templates-screen — Templates screen | tiny | Queued | A Templates screen in the app navigation: thumbnails, names, default categories and usage; New template opens `/templates/$id`; duplicate, rename, delete. User request, 2026-11-05. | |
| editor-hardening — Editor hardening | small | Queued | Controls look live while a lock is acquiring and drop their edits; clamped or refused edits give no hint; hidden elements show editable geometry; slice 2 save and lock edges; Phase A deferrals. | [items][fold] |
| card-style-across-pages — Card style across pages | medium | Later | Apply a card's style to every card with the same style in its section or catalog, so a design change reaches pages built from a template. Revisit if one design must be shared by many templates. | |
| worker-slice — Worker slice | large | Later | pg-boss jobs: the storage sweep (orphans, unreferenced assets, held versions), derivative pre-generation and hardening, an image reference index. Delivery phase 2. | [items][fold] |
| integrations — Integrations, ERP connectors, AI | large | Later | Delivery phases 2–4 of the platform spec ([roadmap](roadmap.md#delivery-phases-24)). | |

## Done

Newest first. Deployed is the first review-stack date on record; "—" means before the LAN review stack.
Finished ledgers, designs and plans are deleted at Done; read one with
`git show <commit>:.superpowers/sdd/<folder>/progress.md`.

<!-- prettier-ignore -->
| Item | Merged | Deployed | Ledger |
| --- | --- | --- | --- |
| edit-inside-groups — Edit inside groups | `94f2ec6` (#35) | 2026-11-06 | `2026-11-06-edit-inside-groups` at `fbb70ac` |
| pdf-delivery — PDF delivery, slices 1–3 | `50c2e46` (#18, #21, #23) | 2026-11-04 | `2026-11-03-pdf-delivery-slice-1`, `-2`, `-3` |
| catalog-ui-fixes — Catalog UI fixes (Keraterm review) | `9564f3e` (#9), `779fdee` (#10) | 2026-11-02 | [archive][a-uifix] |
| catalog-builder-core — Catalog builder core (slice 1) | `0776421` | — | [archive][a-core] |

[archive]: ../.superpowers/sdd/progress-archive.md
[fold]: ../.superpowers/sdd/followups.md#folded-follow-ups
[a-uifix]: ../.superpowers/sdd/progress-archive.md#historical--catalog-ui-fixes-from-the-keraterm-review--2026-11-02
[a-core]: ../.superpowers/sdd/progress-archive.md#current-status--catalog-builder-core-merged--2026-11-01
