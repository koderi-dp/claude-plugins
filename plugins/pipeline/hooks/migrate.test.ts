import { expect, test } from 'claude-code/testing'

import { CATALO_BACKLOG as CATALO, CATALO_QUEUE_2026_11 as QUEUE, OPENHUDDLE_CLAUDE as OH_CLAUDE, OPENHUDDLE_WORKFLOW as OH_WORKFLOW } from './fixtures'
import { activeFromBranches, bulkToRemove, decisionsFromBacklogMd, findSources, historicalLine, incrementsOf, itemsFromBacklogMd, itemsFromMvpQueue, renderRulesMd, repoWebUrl, rulesFromProse, specStub } from './migrate'

// Review Focus 5: the catalo backlog

test('catalo: every unchecked top-level item is inbox with the file in its note, and nothing is invented', () => {
  const items = itemsFromBacklogMd(CATALO, 'docs/backlog.md')
  // By hand from the fixture: 9 current-position rows, 3 proposed-work rows, 5 follow-up rows and 11 checkbox items under "Remaining delivery phase 1".
  expect(items).toHaveLength(28)
  const inbox = items.filter(i => i.status === 'inbox')
  expect(inbox.map(i => i.title)).toEqual([
    'Empty grid areas refilled (bug)',
    'Brand logos',
    'Table element',
    'Minor 5; Task 5 bootstrap retry',
    'Task 4 membership-query cost',
    'Task 4 organization plugin endpoints',
    'Brand and price-list filters',
    'Article editing and status',
    'Attributes, Catalogs and History tabs',
    'New article',
    'Categories dialog parent picker',
    // Titles are the first sentence cut to 80 characters at a word boundary.
    'Versioned page document schema, migrations, shared renderer, and renderer',
    'Hybrid editor: Phase A delivered the canvas, free layer, thumbnails',
    'Draft version history: stored versions and restore; undo is per editing visit',
    'PDF renderer service with Chromium screen output and Chromium/Ghostscript print',
    'Preflight for resolution, safe areas, embedded fonts, and PDF/X validity',
  ])
  for (const i of inbox) {
    expect(i.note).toContain('imported from docs/backlog.md, unverified')
    expect(i.source?.startsWith('docs/backlog.md: ')).toBe(true)
    expect(i.pr).toBeUndefined()
  }
  // No bullet, no item: the prose paragraphs and the Statuses line produce nothing.
  expect(items.some(i => /^Statuses|^These are|^From the user/.test(i.title ?? ''))).toBe(false)
})

test('catalo: a checked item with a PR link is merged with the PR, without one it is merged with a note', () => {
  const items = itemsFromBacklogMd(CATALO, 'docs/backlog.md')
  const merged = items.filter(i => i.status === 'merged')
  expect(merged).toHaveLength(10)
  const withPr = merged.filter(i => i.pr)
  expect(withPr.map(i => [i.title, i.pr])).toEqual([
    ['Catalog UI fixes (Keraterm review)', 'https://github.com/koderi-dp/catalo/pull/9'],
    ['Hybrid editor, Phase B: document v2', 'https://github.com/koderi-dp/catalo/pull/24'],
    ['Article families from code rules and manual grouping; family boxes, variant', 'https://github.com/koderi-dp/catalo/pull/22'],
    ['Catalog approval and immutable field/price snapshots, including family variants', 'https://github.com/koderi-dp/catalo/pull/23'],
  ])
  const withoutPr = merged.filter(i => !i.pr)
  expect(withoutPr.map(i => i.title)).toEqual([
    'Foundation implementation plan, Tasks 1–9',
    'Plan 1b: tenant isolation',
    'Reusable page templates, category defaults, and per-page template selection',
    'Catalog sections, deterministic auto-fill, template switching, and',
    'Draft autosave, undo/redo, and single-editor page locks/heartbeats',
    'Export jobs, object storage/downloads, and dashboard catalogs/recent exports',
  ])
  for (const i of withoutPr) expect(i.note).toBe('imported from docs/backlog.md; no PR link')
})

test('catalo: a named follow-up becomes its own inbox item whose source names the heading', () => {
  const items = itemsFromBacklogMd(CATALO, 'docs/backlog.md')
  const row = items.find(i => i.title === 'New article')
  expect(row).toMatchObject({ status: 'inbox', source: 'docs/backlog.md: Named follow-ups after the Keraterm review' })
  expect(row?.note).toBe("imported from docs/backlog.md, unverified. The mocks' \"New article\" button needs a create form; articles come from import today")
  const phase = items.find(i => i.title?.startsWith('Draft version history'))
  expect(phase?.source).toBe('docs/backlog.md: Remaining delivery phase 1 — catalog builder and print')
})

// The catalo dry run (docs/superpowers/specs/2026-11-05-pipeline-dry-run.md): one test per mismatch.

test('mismatch 1: a table with a Status column: Done with a PR link is merged, Queued is inbox, Later is parked, the third cell is the note', () => {
  const items = itemsFromBacklogMd(CATALO, 'docs/backlog.md')
  const rows = items.filter(i => i.source === 'docs/backlog.md: Current position')
  expect(rows.map(i => [i.title, i.status])).toEqual([
    ['Foundation implementation plan, Tasks 1–9', 'merged'],
    ['Plan 1b: tenant isolation', 'merged'],
    ['Catalog UI fixes (Keraterm review)', 'merged'],
    ['Hybrid editor, Phase B: document v2', 'merged'],
    ['Empty grid areas refilled (bug)', 'inbox'],
    ['Brand logos', 'inbox'],
    ['Table element', 'inbox'],
    ['Card style across pages', 'parked'],
    ['Integrations, ERP connectors, AI', 'parked'],
  ])
  expect(rows[0]?.pr).toBeUndefined()
  expect(rows[0]?.note).toBe('imported from docs/backlog.md; no PR link')
  expect(rows[2]).toMatchObject({ pr: 'https://github.com/koderi-dp/catalo/pull/9', spec: 'docs/superpowers/specs/2026-11-02-category-picker-and-article-page-design.md', note: 'imported from docs/backlog.md' })
  expect(rows[3]).toMatchObject({ pr: 'https://github.com/koderi-dp/catalo/pull/24', spec: 'docs/superpowers/specs/2026-11-04-hybrid-editor-document-v2-design.md', plan: 'docs/superpowers/plans/2026-11-04-hybrid-editor-document-v2.md' })
  expect(rows[5]?.note).toBe('imported from docs/backlog.md, unverified. Brands as records with a logo image, shown on product cards; `brand` is plain text today')
  expect(rows[8]?.note).toBe('imported from docs/backlog.md, unverified. Delivery phases 2–4 of the platform spec')
  // The "Work" header row and the rule row are not items.
  expect(items.some(i => /^Work$|^---/.test(i.title ?? ''))).toBe(false)
})

test('mismatch 2: a follow-up row whose detail starts with Done or Delivered is merged, with the PR when the row links one', () => {
  const text = [
    '### Named follow-ups after the storage slice',
    '',
    '| Follow-up | Deferred work and reason |',
    '| --- | --- |',
    '| Image derivatives | Delivered on branch `claude/lucid-maxwell-80926c` (see the queue row). |',
    '| Article list thumbnail column | Done in the catalog UI fixes (2026-11-02): the list shows thumbnails. |',
    '| Images tool | Done in the Images tool increment ([PR #25](https://github.com/koderi-dp/catalo/pull/25)). |',
    '| Purge of held versions | Not done: needs a retention design. |',
  ].join('\n')
  const items = itemsFromBacklogMd(text, 'docs/backlog.md')
  expect(items.map(i => [i.title, i.status, i.pr, i.note])).toEqual([
    ['Image derivatives', 'merged', undefined, 'imported from docs/backlog.md; no PR link'],
    ['Article list thumbnail column', 'merged', undefined, 'imported from docs/backlog.md; no PR link'],
    ['Images tool', 'merged', 'https://github.com/koderi-dp/catalo/pull/25', 'imported from docs/backlog.md'],
    ['Purge of held versions', 'inbox', undefined, 'imported from docs/backlog.md, unverified. Not done: needs a retention design'],
  ])
})

test('mismatch 3: plain bullets under a follow-ups heading are not items once the section has a table', () => {
  const text = [
    '### Named follow-ups after PDF delivery slice 3',
    '',
    '| Follow-up | Deferred work and reason |',
    '| --- | --- |',
    '| Published chip date | Final review M5: the chip shows the approval date. |',
    '',
    'Decisions taken in slice 3 that differ from the design text:',
    '',
    '- Re-approve is offered for any approved or published catalog, not only when drift exists.',
    '- A catalog flips to Published only when the finished export belongs to its current approval.',
    '- [ ] A checkbox bullet is still an item.',
    '',
    '### Named follow-ups after Phase C',
    '',
    '- Template version history: stored versions and restore.',
  ].join('\n')
  expect(itemsFromBacklogMd(text, 'docs/backlog.md').map(i => i.title)).toEqual([
    'Published chip date',
    'A checkbox bullet is still an item',
    'Template version history: stored versions and restore',
  ])
})

test('mismatch 4: a table whose second column header names work is read under any heading, and rows already implemented are dropped', () => {
  const items = itemsFromBacklogMd(CATALO, 'docs/backlog.md')
  const oneB = items.filter(i => i.source === 'docs/backlog.md: Plan 1b — tenant isolation (complete, merged)')
  expect(oneB.map(i => [i.title, i.status])).toEqual([
    ['Minor 5; Task 5 bootstrap retry', 'inbox'],
    ['Task 4 membership-query cost', 'inbox'],
    ['Task 4 organization plugin endpoints', 'inbox'],
  ])
  expect(oneB[0]?.note).toBe('imported from docs/backlog.md, unverified. Repair a missing default price list after a bootstrap failure')
  const text = [
    '## After 1b: plan 2 - UI system and deferred cleanup',
    '',
    '| References in final review | Work to plan or explicitly defer again |',
    '| --- | --- |',
    '| Minor 6 | Implemented in Task 4: reject every backslash in sign-in destinations. |',
    '| Minor 14 | Deferred to Auth dependency maintenance: Better Auth 1.7. |',
    '',
    '## Reference catalogs',
    '',
    '| Catalog | Pages |',
    '| --- | --- |',
    '| Keraterm autumn | 48 |',
  ].join('\n')
  expect(itemsFromBacklogMd(text, 'docs/backlog.md').map(i => [i.title, i.status, i.source])).toEqual([
    ['Minor 14', 'inbox', 'docs/backlog.md: After 1b: plan 2 - UI system and deferred cleanup'],
  ])
})

test('mismatch 5: a scope table under a later-phases heading is parked', () => {
  const text = [
    '## Delivery phases 2–4',
    '',
    '| Delivery phase | Queued scope |',
    '| --- | --- |',
    '| 2: integration and mapping | Connector framework/contracts; file feeds (CSV/Excel/XML), REST. |',
    '| 3: ERP connectors | Add adapters one ERP at a time once the actual systems and priority are known. |',
    '| 4: AI and sales | Sales import; deterministic article scoring. |',
  ].join('\n')
  const items = itemsFromBacklogMd(text, 'docs/backlog.md')
  expect(items.map(i => [i.title, i.status])).toEqual([
    ['2: integration and mapping', 'parked'],
    ['3: ERP connectors', 'parked'],
    ['4: AI and sales', 'parked'],
  ])
  expect(items[1]?.note).toBe('imported from docs/backlog.md, unverified. Add adapters one ERP at a time once the actual systems and priority are known')
  // The fixture's "Later" rows of the status table are parked too.
  expect(itemsFromBacklogMd(CATALO, 'docs/backlog.md').filter(i => i.status === 'parked').map(i => i.title)).toEqual(['Card style across pages', 'Integrations, ERP connectors, AI'])
})

const CATALO_EXECUTION = [
  '## Execution and verification',
  '',
  '- Standing user instruction (2026-10-30): work through the backlog in order. Ask only when blocked by missing information,',
  '  destructive data changes, new costs, or external actions requiring authorization.',
  '  Do not deploy or send messages without asking. This overrides approval pauses below.',
  '- Independent parallel tasks use separate git worktrees. Only one agent uses a browser',
  '  at a time, through `playwright-cli`.',
  '- Before dispatch, check plan instructions against the spec, existing behavior, and data',
  '  preservation. Record and resolve conflicts through the applicable Superpowers workflow.',
  '- Record dependency commits for each task. Label reviews on an earlier base as provisional;',
  '  verify the integrated result before declaring the dependent task complete.',
  '- For data writes, verify relevant client/server/database boundaries: validation limits,',
  '  omitted versus blank fields, preservation of existing values, rollback behavior, and',
  '  partial completion. Use tests for the risks the change introduces or touches.',
  '- Search existing helpers, components, and translation keys before adding equivalents.',
  '  Reconcile shared-file changes during integration, including message wording and reuse.',
  '- Verify in tiers, not with a full gate after every edit:',
  '  - **Per edit/fix:** focused tests for the touched files, plus ESLint and Prettier on',
  '    changed files (`npm run check:fast`).',
  '  - **Per task:** typecheck the affected workspaces and run the affected package tests.',
  '  - **Per increment / before push:** the full gate: build, typecheck, test, lint,',
  '    format:check, plus `npm run test:renderer-images` when the renderer changed and',
  '    `npm run test:storage-integration -w @catalo/web` when storage changes.',
  '  Full builds are only needed when routes, messages, or bundling change (Paraglide',
  '  regeneration); CSS/class-only edits do not require one.',
  '- Independent review is required for logic, schema, security, and behaviour changes. For',
  '  token/class-only visual changes, one review per increment is enough.',
].join('\n')

test('mismatch 10: the eight rules missed from the execution section land in their groups', () => {
  const rules = rulesFromProse([{ file: 'CLAUDE.md', text: CATALO_EXECUTION }])
  const of = (start: string) => rules.find(r => r.line.startsWith(start))
  expect(of('Independent parallel tasks use separate git worktrees.')?.group).toBe('before dispatch')
  expect(of('Before dispatch, check plan instructions against the spec, existing behavior, and data preservation.')?.group).toBe('before dispatch')
  expect(of('Independent review is required for logic, schema, security, and behaviour changes.')?.group).toBe('before dispatch')
  expect(of('Label reviews on an earlier base as provisional; verify the integrated result')?.group).toBe('in every reviewer brief')
  expect(of('For data writes, verify relevant client/server/database boundaries:')?.group).toBe('in every reviewer brief')
  expect(of('Search existing helpers, components, and translation keys before adding equivalents.')?.group).toBe('in every implementer brief')
  const gate = of('Per increment / before push:')
  expect(gate?.group).toBe('before the PR')
  expect(gate?.line).toBe('Per increment / before push: the full gate: build, typecheck, test, lint, format:check, plus `npm run test:renderer-images` when the renderer changed and `npm run test:storage-integration -w @catalo/web` when storage changes.')
  // "Do not ... without asking" is a stop entry of the config, not a rule; the list label is not a rule either.
  expect(rules.some(r => /without asking/.test(r.line))).toBe(false)
  expect(rules.some(r => /^Verify in tiers/.test(r.line))).toBe(false)
  expect(rules.some(r => /^Ask only when/.test(r.line))).toBe(false)
})

test('mismatch 11: short sentences, a label with a date and command documentation are not rules', () => {
  const text = [
    'Standing user instruction (2026-10-31). After each completed backlog increment, rebuild and bring up all implemented services.',
    '',
    'Never share `node_modules`.',
    '',
    '- `npm run db:migrate` — apply `migrations/*.sql` using only `MIGRATION_DATABASE_URL`',
    '  (`catalo_owner`); it never falls back to `DATABASE_URL`. Skips only when neither URL is set.',
    '- `src/ui` never imports `*.server.ts`, so Vite never ships server modules to the browser.',
  ].join('\n')
  const lines = rulesFromProse([{ file: 'apps/web/CLAUDE.md', text }]).map(r => r.line)
  expect(lines).not.toContain('Standing user instruction (2026-10-31).')
  expect(lines).not.toContain('Never share `node_modules`.')
  expect(lines.some(l => l.startsWith('`npm run db:migrate`'))).toBe(false)
  expect(lines).toContain('After each completed backlog increment, rebuild and bring up all implemented services.')
  expect(lines).toContain('Skips only when neither URL is set (MIGRATION_DATABASE_URL).')
  expect(lines).toContain('`src/ui` never imports `*.server.ts`, so Vite never ships server modules to the browser.')
})

test('mismatch 10: a skill front matter is not a rule even when it says verify', () => {
  const text = [
    '---',
    'name: increment-review-stack',
    'description: Procedure for bringing up the local Docker Compose stack after a completed backlog increment, including what to verify and record.',
    '---',
    '',
    '# Increment review stack',
    '',
    '- Verify migrations complete, long-running services are ready, and the web app loads; smoke-test the delivered behavior.',
  ].join('\n')
  const rules = rulesFromProse([{ file: '.claude/skills/increment-review-stack/SKILL.md', text }])
  expect(rules.map(r => [r.group, r.line])).toEqual([
    ['in every reviewer brief', 'Verify migrations complete, long-running services are ready, and the web app loads; smoke-test the delivered behavior.'],
  ])
})

test('mismatch 12: a rule keeps its first sentence whole under 240 characters and is cut at 200 otherwise', () => {
  const whole = 'Standing user instruction (2026-10-31): after each completed backlog increment/phase (not every internal task), bring up the local Docker Compose stack for user review by following the `increment-review-stack` skill.'
  expect(whole.length).toBeGreaterThan(160)
  const long = 'Never ' + 'repeat this many times '.repeat(12).trim() + ' because the sentence runs past two hundred and forty characters, which is the point where a line is cut at a word boundary instead.'
  expect(long.length).toBeGreaterThan(240)
  const rules = rulesFromProse([{ file: 'CLAUDE.md', text: `- ${whole}\n- ${long}` }])
  expect(rules.map(r => r.line)).toContain(whole)
  const cut = rules.find(r => r.line.startsWith('Never repeat'))
  expect(cut?.line.length).toBeLessThan(200)
  expect(cut?.line.endsWith(' ')).toBe(false)
})

test('catalo: items keep the document order', () => {
  const titles = itemsFromBacklogMd(CATALO, 'docs/backlog.md').map(i => i.title ?? '')
  expect(titles.indexOf('New article')).toBeLessThan(titles.findIndex(t => t.startsWith('Versioned page')))
  expect(titles.findIndex(t => t.startsWith('Versioned page'))).toBeLessThan(titles.findIndex(t => t.startsWith('Preflight')))
})

test('backlog md: later, V1 and phase 2 park an unchecked item; a bullet follow-up list works too', () => {
  const text = [
    '## Queue',
    '',
    '- [ ] Export to CSV (later).',
    '- [ ] LDAP sign-in: moved to V1.',
    '- [ ] Worker slice for phase 2 jobs.',
    '- [ ] Keep this one. It mentions a later version only in the second sentence, which is not a deferral.',
    '- [x] Done without a link',
    '',
    '### Named follow-ups after the worker slice',
    '',
    '- Storage sweep: orphans after 30 days.',
    '- Retry budget for purges',
    '',
    '## Decisions',
    '',
    'Not a bullet, not an item.',
    '- Also not an item: no checkbox and not under a follow-ups heading.',
  ].join('\n')
  const items = itemsFromBacklogMd(text, 'docs/queue.md')
  expect(items.map(i => [i.title, i.status])).toEqual([
    ['Export to CSV (later)', 'parked'],
    ['LDAP sign-in: moved to V1', 'parked'],
    ['Worker slice for phase 2 jobs', 'parked'],
    ['Keep this one', 'inbox'],
    ['Done without a link', 'merged'],
    ['Storage sweep: orphans after 30 days', 'inbox'],
    ['Retry budget for purges', 'inbox'],
  ])
  expect(items[5]?.source).toBe('docs/queue.md: Named follow-ups after the worker slice')
  expect(items[0]?.note).toBe('imported from docs/queue.md, unverified')
})

// The openhuddle queue

test('openhuddle: one inbox item per queue entry, in order, with the rows and needs', () => {
  const items = itemsFromMvpQueue(OH_CLAUDE, 'CLAUDE.md')
  expect(items.map(i => i.id)).toEqual([
    'Q11', 'Q12', 'Q13', 'Q14', 'Q15', 'Q16',
    'Q17', 'Q18', 'Q19', 'Q20', 'Q21', 'Q22',
    'Q23', 'Q25', 'Q26', 'Q27', 'Q28', 'Q29', 'Q30', 'Q31',
  ])
  for (const i of items) {
    expect(i.status).toBe('inbox')
    expect(i.note).toContain('imported from CLAUDE.md, unverified')
  }
  expect(items[0]).toMatchObject({ id: 'Q11', title: 'sidebar sections, stars, mute', needs: ['Q7'], size: 'M', note: 'closes row 4; imported from CLAUDE.md, unverified', source: 'CLAUDE.md: MVP queue (Phase 1, in dependency order), Wave 3' })
  expect(items[1]).toMatchObject({ id: 'Q12', needs: ['Q6'], note: 'closes rows 26, 27; imported from CLAUDE.md, unverified' })
  expect(items[2]).toMatchObject({ id: 'Q13', title: 'thumbnails, EXIF stripping, poster frames, and the text preview on a text file\'s', size: 'L' })
  expect(items[6]).toMatchObject({ id: 'Q17', needs: ['Q12', 'Q1'], note: 'closes rows 27, 8, 10, 28, 37, 15; imported from CLAUDE.md, unverified' })
  expect(items[10]).toMatchObject({ id: 'Q21', needs: ['Q1', 'Q20'] })
  expect(items[14]).toMatchObject({ id: 'Q26', needs: ['Q10'] })
  expect(items[17]).toMatchObject({ id: 'Q29', note: 'closes rows 1, 10, 32, 35, 36, 37; imported from CLAUDE.md, unverified', source: 'CLAUDE.md: MVP queue (Phase 1, in dependency order), Wave 5' })
  expect(items[17]?.needs).toBeUndefined()
  expect(items[18]).toMatchObject({ id: 'Q30', needs: ['Q19'], size: 'S' })
  expect(items[19]?.title?.length ?? 81).toBeLessThanOrEqual(80)
})

test('openhuddle: the MVP status table and the prose produce no items', () => {
  const text = OH_CLAUDE.split('## MVP queue')[0] ?? ''
  expect(itemsFromMvpQueue(text, 'CLAUDE.md')).toEqual([])
})

// Rules from prose

test('rules land in the right group with their source', () => {
  const claude = [
    '- Independent parallel tasks use separate git worktrees. Only one agent uses a browser',
    '  at a time, through `playwright-cli`.',
    '- Sign up only once per fresh dev server: only the first account gets the organization.',
    '  Reuse `qa@catalo.test` / `the QA password` (name `QA`) for browser checks.',
    '- Standing user instruction (2026-10-31): after each completed backlog increment/phase',
    '  (not every internal task), bring up the local Docker Compose stack for user review by',
    '  following the `increment-review-stack` skill.',
    '- Standing user instruction (2026-10-30): work through the backlog in order.',
    '- Never use volume deletion to make startup pass.',
    '- Always run the full gate before opening the pull request.',
    '- The web app lives under apps/web.',
  ].join('\n')
  const rules = rulesFromProse([{ file: 'CLAUDE.md', text: claude }, { file: 'docs/WORKFLOW.md', text: OH_WORKFLOW }])
  const by = (group: string) => rules.filter(r => r.group === group)
  for (const r of rules) {
    expect(r.line.length).toBeLessThan(240)
    expect(r.line).not.toMatch(/\n/)
    expect(['CLAUDE.md', 'docs/WORKFLOW.md']).toContain(r.source)
  }
  expect(by('in every implementer brief').map(r => r.line)).toEqual([
    'Only one agent uses a browser at a time, through `playwright-cli`.',
    'Sign up only once per fresh dev server: only the first account gets the organization.',
    'Reuse `qa@catalo.test` / `the QA password` (name `QA`) for browser checks.',
  ])
  expect(by('after merge').map(r => [r.line.slice(0, 40), r.source])).toEqual([
    ['Standing user instruction (2026-10-31): ', 'CLAUDE.md'],
    ['After each merge, post a short summary: ', 'docs/WORKFLOW.md'],
  ])
  expect(by('before dispatch').map(r => r.line)).toContain('Standing user instruction (2026-10-30): work through the backlog in order.')
  expect(by('before dispatch').map(r => r.line)).toContain('Never use volume deletion to make startup pass.')
  expect(by('before the PR').map(r => r.line)).toContain('Always run the full gate before opening the pull request.')
  // The env var that makes tests skip: reviewer brief and before the PR, from the workflow file.
  const skip = rules.filter(r => /skip silently/.test(r.line))
  expect(skip.map(r => r.group).sort()).toEqual(['before the PR', 'in every reviewer brief'])
  for (const r of skip) {
    expect(r.line).toContain('OH_TEST_DATABASE_URL')
    expect(r.source).toBe('docs/WORKFLOW.md')
  }
  // The auto-merge statement and the stop list are config, not rules; plain prose is not a rule.
  expect(rules.some(r => /lives under apps\/web/.test(r.line))).toBe(false)
  expect(rules.some(r => /^Auto-merge is on/.test(r.line))).toBe(false)
  expect(rules.some(r => /^Stop and ask the user/.test(r.line))).toBe(false)
  // From the workflow's environment section: the commit rule names a commit, so it is before the PR.
  expect(by('before the PR').some(r => /never `-a`/.test(r.line))).toBe(true)
})

test('renderRulesMd numbers the lines under one heading per group, each ending with its source', () => {
  const md = renderRulesMd([
    { group: 'in every implementer brief', line: 'Only one agent uses a browser at a time.', source: 'CLAUDE.md' },
    { group: 'before dispatch', line: 'Work through the backlog in order.', source: 'CLAUDE.md' },
    { group: 'in every implementer brief', line: 'Reuse qa@catalo.test for browser checks.', source: 'CLAUDE.md' },
  ])
  expect(md).toBe([
    '# Rules',
    '',
    'Process rules the config cannot express, by when they apply. The run skill pastes each group into the brief or step it names.',
    '',
    '## Before dispatch',
    '',
    '1. Work through the backlog in order. (CLAUDE.md)',
    '',
    '## In every implementer brief',
    '',
    '2. Only one agent uses a browser at a time. (CLAUDE.md)',
    '3. Reuse qa@catalo.test for browser checks. (CLAUDE.md)',
    '',
    '## In every reviewer brief',
    '',
    '## Before the PR',
    '',
    '## After merge',
    '',
  ].join('\n'))
})

// Sources

test('findSources picks only present files, in the order of the spec', () => {
  const listing = [
    './CLAUDE.md', 'apps/web/CLAUDE.md', 'docs/backlog.md', 'docs/superpowers/specs/a.md', 'docs/superpowers/plans/b.md',
    '.superpowers/sdd/progress.md', '.superpowers/sdd/2026-11-03-slice/progress.md', '.superpowers/sdd/final-review.md',
    '.claude/skills/agent-dispatch/SKILL.md', '.claude/skills/x/notes.md', 'package.json', '.github/workflows/ci.yml',
    'docs/storage.md', 'src/index.ts', 'README.md',
  ]
  const claudeMd = [
    '- [Work queue and backlog](docs/backlog.md): current implementation status, next work.',
    '- [Phase 1 final review and deferred findings](.superpowers/sdd/final-review.md)',
    '- [Progress ledger](.superpowers/sdd/progress.md): read before continuing work.',
    '- [Storage](docs/storage.md): how objects are stored.',
    '- [Missing](docs/missing-queue.md): the queue that is not in the listing.',
  ].join('\n')
  expect(findSources(listing, claudeMd)).toEqual([
    'CLAUDE.md', 'apps/web/CLAUDE.md', 'docs/backlog.md', '.superpowers/sdd/progress.md',
    'docs/superpowers/specs/a.md', 'docs/superpowers/plans/b.md',
    '.superpowers/sdd/2026-11-03-slice/progress.md',
    '.claude/skills/agent-dispatch/SKILL.md', 'package.json', '.github/workflows/ci.yml',
  ])
  expect(findSources([], '')).toEqual([])
})

// Active items

test('activeFromBranches reconstructs a building item from an open feat branch with a ledger', () => {
  const ledger = [
    '# SDD ledger — plan: docs/superpowers/plans/2026-11-03-pdf-delivery-slice-2.md',
    '',
    '## Current status — 2026-11-03',
    '',
    '- Branch `feat/pdf-delivery-slice-2` (worktree), stacked on `main`.',
    '- Verified state (Task 6, 2026-11-03): all six tasks complete and reviewed. Stack and gate',
    '  tested at commit `7163cec` (code on top of `644ec61`).',
    '- Next action: final review of the slice, then the pull request.',
    '',
    '## Execution log',
    '',
    '- Task 1: implementer, commit `184c145`.',
  ].join('\n')
  const active = activeFromBranches(['main', 'feat/pdf-delivery-slice-2', 'feat/no-ledger', 'chore/x'], [{ file: '.superpowers/sdd/2026-11-03-pdf-delivery-slice-2/progress.md', text: ledger }])
  expect(active).toEqual([{
    title: 'pdf delivery slice 2',
    status: 'building',
    branch: 'feat/pdf-delivery-slice-2',
    plan: 'docs/superpowers/plans/2026-11-03-pdf-delivery-slice-2.md',
    ledger: '.superpowers/sdd/2026-11-03-pdf-delivery-slice-2/progress.md',
    resume: { task: 6, state: 'Branch `feat/pdf-delivery-slice-2` (worktree), stacked on `main`', lastVerified: '7163cec' },
  }])
  const withId = activeFromBranches(['feat/p12'], [{ file: 'docs/pipeline/ledgers/p12.md', text: '# p12\n\n## Current status\n\nTask 3 running; implementer dispatched.\n' }])
  expect(withId).toEqual([{ id: 'p12', title: 'p12', status: 'building', branch: 'feat/p12', ledger: 'docs/pipeline/ledgers/p12.md', resume: { task: 3, state: 'Task 3 running; implementer dispatched' } }])
  expect(activeFromBranches(['feat/x'], [{ file: 'l.md', text: '# no status block\n' }])).toEqual([])
})

test('historicalLine', () => {
  expect(historicalLine('2026-11-05')).toBe('Historical. The queue is docs/pipeline/backlog.json since 2026-11-05.')
})

test('catalo: a checked item links the spec and the plan its bullet names, resolved against docs/', () => {
  const items = itemsFromBacklogMd(CATALO, 'docs/backlog.md')
  const versioned = items.find(i => i.title?.startsWith('Versioned page'))
  expect(versioned).toMatchObject({ spec: 'docs/superpowers/specs/2026-10-31-page-document-renderer-design.md', plan: 'docs/superpowers/plans/2026-10-31-page-document-renderer.md' })
  const templates = items.find(i => i.title?.startsWith('Reusable page templates'))
  expect(templates?.spec).toBe('docs/superpowers/specs/2026-11-04-hybrid-editor-templates-design.md')
  expect(templates?.plan).toBeUndefined()
})

test('incrementsOf: an exact plan match is merged, a folder named like a merged title is unsure, the rest is left alone', () => {
  const items = [
    { title: 'Search over articles', status: 'merged' as const, plan: 'docs/superpowers/plans/2026-11-01-search.md' },
    { title: 'Export jobs and downloads', status: 'merged' as const },
    { title: 'Brand filters', status: 'inbox' as const, plan: 'docs/superpowers/plans/2026-11-04-brand-filters.md' },
  ]
  const { merged, unsure } = incrementsOf([
    { dir: '2026-11-01-search', pointer: '# SDD ledger — plan: docs/superpowers/plans/2026-11-01-search.md' },
    { dir: '2026-11-02-export-jobs', pointer: '' },
    { dir: '2026-11-04-brand-filters', pointer: 'docs/superpowers/plans/2026-11-04-brand-filters.md' },
    { dir: '2026-11-05-other', pointer: '' },
  ], items)
  expect(merged).toEqual(['2026-11-01-search'])
  expect(unsure).toEqual(['2026-11-02-export-jobs'])
})

test('bulkToRemove lists the files of merged increments except progress.md and the final review', () => {
  const listing = [
    '.superpowers/sdd/',
    '.superpowers/sdd/2026-11-01-search/',
    '.superpowers/sdd/2026-11-01-search/progress.md',
    '.superpowers/sdd/2026-11-01-search/final-review.md',
    '.superpowers/sdd/2026-11-01-search/final-review-2.md',
    '.superpowers/sdd/2026-11-01-search/task-1-brief.md',
    '.superpowers/sdd/2026-11-01-search/logs/',
    '.superpowers/sdd/2026-11-01-search/logs/task-1.log',
    '.superpowers/sdd/2026-11-01-search/screens/home.png',
    '.superpowers/sdd/2026-11-03-export/progress.md',
    '.superpowers/sdd/2026-11-03-export/task-1-brief.md',
    'docs/backlog.md',
  ]
  expect(bulkToRemove(listing, ['2026-11-01-search'])).toEqual({
    files: ['.superpowers/sdd/2026-11-01-search/task-1-brief.md', '.superpowers/sdd/2026-11-01-search/logs/task-1.log', '.superpowers/sdd/2026-11-01-search/screens/home.png'],
    count: 3,
  })
  expect(bulkToRemove(listing, ['2026-11-01-search/', '2026-11-03-export']).count).toBe(4)
  expect(bulkToRemove(listing, [])).toEqual({ files: [], count: 0 })
})


// The catalo queue after its 2026-11-05 rewrite: Item · Size · State · Scope · Links, a Done table and open decisions.

const REPO = 'https://github.com/koderi-dp/catalo'

test('catalo queue: thirteen queue rows and four done rows become items by State, with the size, the scope as note and no decision among them', () => {
  const items = itemsFromBacklogMd(QUEUE, 'docs/backlog.md', REPO)
  // By hand from the fixture: 13 queue rows (1 Running, 1 Review, 1 Blocked, 7 Queued, 3 Later) and 4 done rows; the 3 open decisions are not items.
  expect(items).toHaveLength(17)
  expect(items.map(i => [i.title, i.status, i.size])).toEqual([
    ['page-background-image — Page background image', 'building', 'M'],
    ['panel-splitters — Resizable editor side panels', 'building', 'S'],
    ['app-themes — App themes per user', 'blocked', 'S'],
    ['grid-track-sizes — Grid row and column sizes', 'inbox', 'M'],
    ['brand-logos — Brand logos', 'inbox', 'M'],
    ['two-page-spreads — Two-page spreads', 'inbox', 'L'],
    ['section-delete-pages — Delete a section with its pages', 'inbox', 'S'],
    ['multi-page-delete-clear — Multi-page delete and clear', 'inbox', 'S'],
    ['templates-screen — Templates screen', 'inbox', 'S'],
    ['editor-hardening — Editor hardening', 'inbox', 'S'],
    ['card-style-across-pages — Card style across pages', 'parked', 'M'],
    ['worker-slice — Worker slice', 'parked', 'L'],
    ['integrations — Integrations, ERP connectors, AI', 'parked', 'L'],
    ['edit-inside-groups — Edit inside groups', 'merged', undefined],
    ['pdf-delivery — PDF delivery, slices 1–3', 'merged', undefined],
    ['catalog-ui-fixes — Catalog UI fixes (Keraterm review)', 'merged', undefined],
    ['catalog-builder-core — Catalog builder core (slice 1)', 'merged', undefined],
  ])
  expect(items.filter(i => i.status === 'inbox')).toHaveLength(7)
  expect(items.filter(i => i.status === 'building')).toHaveLength(2)
  expect(items.filter(i => i.status === 'parked')).toHaveLength(3)
  expect(items.filter(i => i.status === 'merged')).toHaveLength(4)
  for (const i of items.slice(0, 13)) expect(i.source).toBe('docs/backlog.md: Queue')
  for (const i of items.slice(13)) expect(i.source).toBe('docs/backlog.md: Done')
  expect(items.some(i => /ECI|PDF\/X validator|AGPL/.test(i.title ?? ''))).toBe(false)
})

test('catalo queue: the scope is the whole note, the Links cell is appended, a Running or Review row notes its state and a Blocked row keeps the scope', () => {
  const items = itemsFromBacklogMd(QUEUE, 'docs/backlog.md', REPO)
  const by = (slug: string) => items.find(i => i.title?.startsWith(`${slug} —`))
  expect(by('brand-logos')?.note).toBe('imported from docs/backlog.md, unverified. Brands as records with a logo image, shown on product cards; `brand` is plain text today. The Keraterm pages show a manufacturer logo per card.')
  expect(by('grid-track-sizes')?.note).toBe(
    'imported from docs/backlog.md, unverified. A grid row or column with a fixed size in mm (a thin header row) while the others share the rest: page document (v2 compatible), renderer, editor geometry, Page tab and "with header" presets. Exports of documents without track sizes stay identical. User request, 2026-11-05. Links: Renderer change',
  )
  expect(by('editor-hardening')?.note?.endsWith(' Links: [items][fold]')).toBe(true)
  expect(by('multi-page-delete-clear')?.note?.endsWith(' Links: Pairs with section-delete-pages')).toBe(true)
  expect(by('page-background-image')?.note?.startsWith('imported from docs/backlog.md; row Running. A page setting beside the background colour')).toBe(true)
  expect(by('page-background-image')?.note?.endsWith(' Links: Renderer change')).toBe(true)
  expect(by('panel-splitters')?.note?.startsWith('imported from docs/backlog.md; row Review. Drag handles')).toBe(true)
  expect(by('app-themes')?.note).toBe(
    "imported from docs/backlog.md; row Blocked. Waits for the user's choice of the curated theme set from tweakcn (for example Claude, Clean Slate, Ocean Breeze, Sage Green). Themes change the app's look only (colour tokens in `apps/web/src/styles.css`). User request, 2026-11-09.",
  )
  // A markdown link in the scope becomes its text.
  expect(by('integrations')?.note).toBe('imported from docs/backlog.md, unverified. Delivery phases 2–4 of the platform spec (roadmap).')
  for (const i of items) expect(i.pr === undefined || i.status === 'merged').toBe(true)
})

test('catalo queue: a Done row is merged with the PR as a full URL when the repo is known, else #NN, with the sha in the note', () => {
  const items = itemsFromBacklogMd(QUEUE, 'docs/backlog.md', REPO)
  const done = items.filter(i => i.status === 'merged')
  expect(done.map(i => [i.pr, i.note])).toEqual([
    [`${REPO}/pull/35`, 'imported from docs/backlog.md; merged at 94f2ec6'],
    [`${REPO}/pull/18`, 'imported from docs/backlog.md; merged at 50c2e46; PRs #18, #21, #23'],
    [`${REPO}/pull/9`, 'imported from docs/backlog.md; merged at 9564f3e, 779fdee; PRs #9, #10'],
    [undefined, 'imported from docs/backlog.md; merged at 0776421; no PR link'],
  ])
  const bare = itemsFromBacklogMd(QUEUE, 'docs/backlog.md').filter(i => i.status === 'merged')
  expect(bare.map(i => i.pr)).toEqual(['#35', '#18', '#9', undefined])
  expect(bare[0]?.note).toBe('imported from docs/backlog.md; merged at 94f2ec6')
})

test('repoWebUrl: an ssh or https origin becomes the web URL of the repository, anything else nothing', () => {
  expect(repoWebUrl('git@github.com:koderi-dp/catalo.git')).toBe('https://github.com/koderi-dp/catalo')
  expect(repoWebUrl('https://github.com/koderi-dp/catalo.git')).toBe('https://github.com/koderi-dp/catalo')
  expect(repoWebUrl('https://github.com/koderi-dp/catalo')).toBe('https://github.com/koderi-dp/catalo')
  expect(repoWebUrl('ssh://git@gitlab.example.com/group/app.git')).toBe('https://gitlab.example.com/group/app')
  expect(repoWebUrl(null)).toBeUndefined()
  expect(repoWebUrl('/srv/git/app.git')).toBeUndefined()
})

test('a State column counts as the Status column of the older table shapes too', () => {
  const text = ['## Queue', '', '| Work | State | Evidence |', '| --- | --- | --- |', '| Brand logos | Queued | Logos on cards. |', '| Plan 1b | Done | Merged (`36da4b2`). |', '| Worker | Later | Phase 2. |', '| Themes | Blocked | Waits for the palette. |'].join('\n')
  const items = itemsFromBacklogMd(text, 'docs/backlog.md')
  expect(items.map(i => [i.title, i.status, i.note])).toEqual([
    ['Brand logos', 'inbox', 'imported from docs/backlog.md, unverified. Logos on cards'],
    ['Plan 1b', 'merged', 'imported from docs/backlog.md; no PR link'],
    ['Worker', 'parked', 'imported from docs/backlog.md, unverified. Phase 2'],
    ['Themes', 'blocked', 'imported from docs/backlog.md; row Blocked. Waits for the palette'],
  ])
})

test('decisionsFromBacklogMd: each open decision is a before-dispatch stop rule with its date, and the queue makes no item of it', () => {
  const rules = decisionsFromBacklogMd(QUEUE, 'docs/backlog.md')
  expect(rules).toEqual([
    { group: 'before dispatch', line: "Stop before ECI's written permission to redistribute `PSOcoated_v3.icc` (or a profile swap) before any public repository or an image distributed outside the organisation: open user decision since 2026-11-03.", source: 'docs/backlog.md: Open decisions' },
    { group: 'before dispatch', line: "Stop before Buy a PDF/X validator (callas pdfToolbox, Acrobat Preflight), or take the print shop's preflight of the first production file as the conformance check; ask the shop for its required output profile: open user decision since 2026-11-03.", source: 'docs/backlog.md: Open decisions' },
    { group: 'before dispatch', line: 'Stop before Confirm the AGPL, GPL and ECI obligations in licensing before any public deployment: open user decision since 2026-11-03.', source: 'docs/backlog.md: Open decisions' },
  ])
  const text = ['## Decisions pending', '', '- [ ] Pick the S3 region.', '- Rename the org table (asked 2026-11-01).', '', '## Queue', '', '- [ ] Export jobs.'].join('\n')
  expect(decisionsFromBacklogMd(text, 'docs/queue.md').map(r => r.line)).toEqual([
    'Stop before Pick the S3 region: open user decision.',
    'Stop before Rename the org table (asked 2026-11-01): open user decision since 2026-11-01.',
  ])
  expect(itemsFromBacklogMd(text, 'docs/queue.md').map(i => i.title)).toEqual(['Export jobs'])
  expect(decisionsFromBacklogMd(CATALO, 'docs/backlog.md')).toEqual([])
})

test('specStub: the five headings, What from the note or the title, Why from the source, Open empty', () => {
  const stub = specStub('p7', 'Brand logos', 'imported from docs/backlog.md, unverified. Brands as records with a logo image.', 'docs/backlog.md: Queue')
  expect(stub.split('\n').filter(l => l.startsWith('## '))).toEqual(['## What', '## Why', '## Acceptance', '## Out of scope', '## Open'])
  expect(stub.startsWith('# p7: Brand logos\n\n## What\n\nimported from docs/backlog.md, unverified. Brands as records with a logo image.\n\n## Why\n\nImported from docs/backlog.md: Queue.\n')).toBe(true)
  expect(stub).toContain('\n## Acceptance\n\n- [ ] As described in What.\n')
  expect(stub.endsWith('\n## Out of scope\n\n## Open\n')).toBe(true)
  expect(specStub('p8', 'Table element', '', undefined)).toContain('## What\n\nTable element\n\n## Why\n\nImported by the migration.\n')
})
