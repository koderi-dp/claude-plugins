// The heading lines of catalo's docs/superpowers/plans/2026-10-29-phase1-foundation.md,
// with Windows line endings as the file has them on that machine.
const TITLES = [
  'Monorepo with the starter copied in',
  'Domain package: search keys, prices and barcodes',
  'Croatian and English UI with Paraglide',
  'Organizations',
  'Catalog schema, Croatian collation and price lists',
  'Categories',
  'Articles and prices',
  'CSV and Excel import',
  'Docker image and final verification',
]

export const CATALO_PLAN = [
  '# Phase 1, Plan 1: Foundation Implementation Plan',
  '',
  ...TITLES.flatMap((t, i) => [
    `### Task ${i + 1}: ${t}`,
    '',
    '- [ ] **Step 1: Write the failing test**',
    '- [ ] **Step 2: Run it**',
    '',
    '```sh',
    '# a comment line inside a code block',
    '```',
    '',
  ]),
].join('\r\n')
