import { expect, test } from 'claude-code/testing'

import { CATALO_BACKLOG as CATALO, OPENHUDDLE_CLAUDE as OH_CLAUDE, OPENHUDDLE_WORKFLOW as OH_WORKFLOW } from './fixtures'
import { activeFromBranches, bulkToRemove, findSources, historicalLine, incrementsOf, itemsFromBacklogMd, itemsFromMvpQueue, renderRulesMd, rulesFromProse } from './migrate'

// Review Focus 5: the catalo backlog

test('catalo: every unchecked top-level item is inbox with the file in its note, and nothing is invented', () => {
  const items = itemsFromBacklogMd(CATALO, 'docs/backlog.md')
  // By hand from the fixture: 11 checkbox items under "Remaining delivery phase 1" and 5 follow-up rows.
  expect(items).toHaveLength(16)
  const inbox = items.filter(i => i.status === 'inbox')
  expect(inbox.map(i => i.title)).toEqual([
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
  expect(merged).toHaveLength(6)
  const withPr = merged.filter(i => i.pr)
  expect(withPr.map(i => [i.title, i.pr])).toEqual([
    ['Article families from code rules and manual grouping; family boxes, variant', 'https://github.com/koderi-dp/catalo/pull/22'],
    ['Catalog approval and immutable field/price snapshots, including family variants', 'https://github.com/koderi-dp/catalo/pull/23'],
  ])
  const withoutPr = merged.filter(i => !i.pr)
  expect(withoutPr.map(i => i.title)).toEqual([
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
    expect(r.line.length).toBeLessThan(160)
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

