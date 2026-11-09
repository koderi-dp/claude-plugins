import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__pipeline__pipeline'
const MAIN = '/p/main'
const DIR = `${MAIN}/docs/pipeline`
const NOW = Date.parse('2026-11-05T10:00:00Z')

type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }

/** A main checkout at /p/main, files in memory; `fs.list` and `fs.exists` answer from the file map's paths. */
function world(on: On, seed: Record<string, string> = {}) {
  mock.clock(on, { now: NOW })
  const files = new Map<string, string>(Object.entries(seed))
  const writes: string[] = []
  const key = (p: string) => p.split(String.fromCharCode(92)).join('/')
  const under = (dir: string) => [...files.keys()].filter(k => k.startsWith(`${dir}/`)).map(k => k.slice(dir.length + 1))
  on('fs.exists', (_$, e) => {
    const p = key(e.path)
    return { value: files.has(p) || under(p).length > 0 }
  })
  on('fs.read', (_$, e) => {
    const t = files.get(key(e.path))
    return t === undefined ? { deny: `ENOENT: ${e.path}` } : { value: t }
  })
  on('fs.write', (_$, e) => {
    files.set(key(e.path), e.text)
    writes.push(key(e.path))
    return { value: undefined }
  })
  on('fs.list', (_$, e) => {
    const names = new Map<string, Entry>()
    for (const rest of under(key(e.path))) {
      const [name = '', ...more] = rest.split('/')
      if (!names.has(name)) names.set(name, { name, kind: more.length ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false })
    }
    return { value: [...names.values()] } as never
  })
  on('session.repo', () => ({ value: { root: MAIN, remote: null, internal: false, name: null } }) as never)
  on('session.root', () => ({ value: MAIN }))
  on('session.cwd', () => ({ value: MAIN }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  return { files, writes }
}

const text = (r: unknown) => String((r as { result: unknown }).result)
const call = ($: { tool: { call: (e: never) => Promise<unknown> } }, input: Record<string, unknown>) => $.tool.call({ tool: TOOL, ...input } as never)

type Draft = {
  sources: string[]
  config: Record<string, unknown> & { checks: Record<string, string> }
  sourcesOfConfig: Record<string, string>
  items: Record<string, unknown>[]
  rules: { group: string; line: string; source: string }[]
  active: Record<string, unknown>[]
  bulk: { files: string[]; count: number }
  unsure: string[]
  report: string
}

const CLAUDE_MD = [
  '# catalo-like',
  '',
  'The work queue is [docs/backlog.md](docs/backlog.md); the dispatch rules follow.',
  '',
  '## How work is run',
  '',
  'Never push to main directly; every slice merges through a pull request.',
  'Use the Playwright browser for every UI check, with the seeded test account.',
  'Ask the user only for product decisions, security trade-offs, and new cost.',
  'Reviews allow three fix rounds before the slice is blocked.',
].join('\n')

const BACKLOG_MD = [
  '# Queue',
  '',
  '## Remaining',
  '',
  '- [ ] Export jobs and downloads.',
  '- [ ] Brand filters (later).',
  '- [x] Search over articles. Merged in [PR #12](https://github.com/acme/app/pull/12), [plan](superpowers/plans/2026-11-01-search.md).',
  '',
  '## Open decisions',
  '',
  '- 2026-11-04 · user · Rename the organizations table.',
].join('\n')

const SEARCH_LEDGER = [
  '# SDD ledger — plan: docs/superpowers/plans/2026-11-01-search.md',
  '',
  '## Current status — 2026-11-02',
  '',
  '- Merged in PR #12.',
].join('\n')

const EXPORT_LEDGER = [
  '# SDD ledger — plan: docs/superpowers/plans/2026-11-03-export.md',
  '',
  '## Current status — 2026-11-04',
  '',
  '- Branch `feat/export` (worktree), stacked on `main`.',
  '- Verified state (Task 2, 2026-11-04): tasks 1 and 2 reviewed, tested at commit `abc1234`.',
  '',
  '## Execution log',
  '',
  '- Task 1: implementer, commit `111aaaa`.',
].join('\n')

const SDD = `${MAIN}/.superpowers/sdd`

/** The catalo-like tree: CLAUDE.md links the queue, package.json has scripts, one merged and one open increment, two branches. */
const TREE: Record<string, string> = {
  [`${MAIN}/CLAUDE.md`]: CLAUDE_MD,
  [`${MAIN}/package.json`]: JSON.stringify({ name: 'app', scripts: { 'check:fast': 'tsc', test: 'vitest run', check: 'npm run lint && npm run test' } }, null, 2),
  [`${MAIN}/docs/backlog.md`]: BACKLOG_MD,
  [`${MAIN}/docs/superpowers/plans/2026-11-01-search.md`]: '# Search plan\n',
  [`${MAIN}/docs/superpowers/plans/2026-11-03-export.md`]: '# Export plan\n',
  [`${SDD}/2026-11-01-search/progress.md`]: SEARCH_LEDGER,
  [`${SDD}/2026-11-01-search/task-1-brief.md`]: 'brief\n',
  [`${SDD}/2026-11-01-search/logs/task-1.log`]: 'log\n',
  [`${SDD}/2026-11-01-search/final-review.md`]: 'final\n',
  [`${SDD}/2026-11-03-export/progress.md`]: EXPORT_LEDGER,
  [`${SDD}/2026-11-03-export/logs/task-1.log`]: 'log\n',
  [`${MAIN}/.git/refs/heads/main`]: 'aaa\n',
  [`${MAIN}/.git/refs/heads/feat/export`]: 'bbb\n',
  [`${MAIN}/.git/packed-refs`]: '# pack-refs with: peeled fully-peeled sorted\n0123456789012345678901234567890123456789 refs/heads/chore/old\n',
}

test('migrate drafts the config with sources, the items, the rules, the active item and the bulk, and writes nothing', async ($, on) => {
  const { writes } = world(on, TREE)
  const r = text(await call($, { action: 'migrate' }))
  expect(r.startsWith('{')).toBe(true)
  const d = JSON.parse(r) as Draft
  expect(writes).toEqual([])

  expect(d.sources).toEqual([
    'CLAUDE.md',
    'docs/backlog.md',
    'docs/superpowers/plans/2026-11-01-search.md',
    'docs/superpowers/plans/2026-11-03-export.md',
    '.superpowers/sdd/2026-11-01-search/progress.md',
    '.superpowers/sdd/2026-11-03-export/progress.md',
    'package.json',
  ])

  expect(d.config.checks).toEqual({ fast: 'npm run check:fast', task: 'npm run test', gate: 'npm run check' })
  expect(d.sourcesOfConfig['checks.fast']).toBe('package script check:fast')
  expect(d.sourcesOfConfig['checks.gate']).toBe('package script check')
  expect(d.config['limits']).toMatchObject({ fixRounds: 3 })
  expect(d.sourcesOfConfig['limits.fixRounds']).toBe('prose: "three fix rounds"')
  expect(d.config['stop']).toEqual(['product decisions', 'security trade-offs', 'new cost'])

  expect(d.items.map(i => [i.title, i.status])).toEqual([
    ['Export jobs and downloads', 'inbox'],
    ['Brand filters (later)', 'parked'],
    ['Search over articles', 'merged'],
  ])
  expect(d.items[0]).toMatchObject({ note: 'imported from docs/backlog.md, unverified', source: 'docs/backlog.md: Remaining' })
  expect(d.items[2]).toMatchObject({ pr: 'https://github.com/acme/app/pull/12', plan: 'docs/superpowers/plans/2026-11-01-search.md' })

  expect(d.rules.some(x => x.source === 'CLAUDE.md' && x.group === 'before the PR' && x.line.startsWith('Never push to main'))).toBe(true)
  expect(d.rules.some(x => x.source === 'CLAUDE.md' && x.group === 'in every implementer brief' && /Playwright/.test(x.line))).toBe(true)
  // The open decision of the queue is a stop rule, not an item.
  expect(d.rules.filter(x => x.source === 'docs/backlog.md: Open decisions')).toEqual([
    { group: 'before dispatch', line: 'Stop before Rename the organizations table: open user decision since 2026-11-04.', source: 'docs/backlog.md: Open decisions' },
  ])
  expect(d.report).toContain('docs/backlog.md: 3 items (1 merged, 1 parked), 1 open decision')

  expect(d.active).toEqual([{
    title: 'export',
    status: 'building',
    branch: 'feat/export',
    plan: 'docs/superpowers/plans/2026-11-03-export.md',
    ledger: '.superpowers/sdd/2026-11-03-export/progress.md',
    resume: { task: 2, state: 'Branch `feat/export` (worktree), stacked on `main`', lastVerified: 'abc1234' },
  }])

  // The merged increment's bulk: the brief and the log, never progress.md or the final review; the open increment is left alone.
  expect(d.bulk).toEqual({ files: ['.superpowers/sdd/2026-11-01-search/task-1-brief.md', '.superpowers/sdd/2026-11-01-search/logs/task-1.log'], count: 2 })
  expect(d.unsure).toEqual([])

  expect(d.report).toContain('package.json: 3 scripts')
  expect(d.report).toContain('docs/backlog.md: 3 items (1 merged, 1 parked)')
  expect(d.report).toContain('.superpowers/sdd/2026-11-03-export/progress.md: ledger of feat/export, resume at task 2')
  expect(d.report).toContain('merged increments: 2026-11-01-search (2 files to remove)')
  expect(d.report).toContain('branches: main, feat/export, chore/old')
})

test('migrate is refused when the config exists, unless refresh', async ($, on) => {
  const { writes } = world(on, { ...TREE, [`${DIR}/config.json`]: '{ "version": 1 }\n' })
  expect(text(await call($, { action: 'migrate' }))).toBe('refused: docs/pipeline/config.json exists; pass refresh: true to draft again')
  const r = text(await call($, { action: 'migrate', refresh: true }))
  expect(r.startsWith('{')).toBe(true)
  expect(writes).toEqual([])
})

test('a project without a queue drafts an empty backlog and names the sources it found', async ($, on) => {
  world(on, { [`${MAIN}/Makefile`]: 'check:\n\tgo vet\ntest:\n\tgo test ./...\n', [`${MAIN}/README.md`]: '# x\n' })
  const d = JSON.parse(text(await call($, { action: 'migrate' }))) as Draft
  expect(d.sources).toEqual(['Makefile'])
  expect(d.items).toEqual([])
  expect(d.active).toEqual([])
  expect(d.config.checks).toEqual({ task: 'make test', gate: 'make check' })
  expect(d.report).toContain('Makefile: 2 targets')
  expect(d.report).toContain('branches: none found')
})

test('migrate-apply writes the four files, the ledger of the building item, maps the needs and prepends the historical line once', async ($, on) => {
  const { files, writes } = world(on, TREE)
  const d = JSON.parse(text(await call($, { action: 'migrate' }))) as Draft
  const items = [
    ...d.items,
    ...d.active,
    { id: 'Q1', title: 'First queue entry', status: 'inbox', note: 'imported from CLAUDE.md, unverified' },
    { id: 'Q2', title: 'Second queue entry', status: 'inbox', needs: ['Q1', 'Q9'], note: 'imported from CLAUDE.md, unverified' },
  ]
  const r = text(await call($, { action: 'migrate-apply', config: d.config, items, rules: d.rules }))
  expect(r.startsWith('pipeline: 6 items')).toBe(true)
  expect(r).toContain('\nhistorical line added to 4 files\n')
  expect(r).toContain('bulk: 2 files of merged increments to remove')
  expect(r.endsWith('\n.superpowers/sdd/2026-11-01-search/task-1-brief.md\n.superpowers/sdd/2026-11-01-search/logs/task-1.log')).toBe(true)

  expect(writes.slice(0, 2)).toEqual([`${DIR}/config.json`, `${DIR}/rules.md`])
  expect(writes).toContain(`${DIR}/backlog.json`)
  expect(writes).toContain(`${DIR}/BACKLOG.md`)
  expect(JSON.parse(files.get(`${DIR}/config.json`)!)).toMatchObject({ version: 1, checks: { fast: 'npm run check:fast' }, limits: { fixRounds: 3 } })
  expect(files.get(`${DIR}/rules.md`)).toContain('## Before the PR')
  expect(files.get(`${DIR}/rules.md`)).toContain('Never push to main directly; every slice merges through a pull request. (CLAUDE.md)')
  expect(files.get(`${DIR}/rules.md`)).toContain('Stop before Rename the organizations table: open user decision since 2026-11-04. (docs/backlog.md: Open decisions)')

  const backlog = JSON.parse(files.get(`${DIR}/backlog.json`)!) as { items: Record<string, unknown>[] }
  expect(backlog.items.map(i => [i.id, i.title, i.status])).toEqual([
    ['p1', 'Export jobs and downloads', 'inbox'],
    ['p2', 'Brand filters (later)', 'parked'],
    ['p3', 'Search over articles', 'merged'],
    ['p4', 'export', 'building'],
    ['p5', 'First queue entry', 'inbox'],
    ['p6', 'Second queue entry', 'inbox'],
  ])
  // Queue labels become the ids they got; an unknown label goes into the note.
  expect(backlog.items[5]).toMatchObject({ needs: ['p5'], note: 'imported from CLAUDE.md, unverified; needs Q9, not in the import' })
  expect(backlog.items[5]!['resume']).toBeUndefined()
  // The building item has a ledger with the resume stamped.
  expect(backlog.items[3]).toMatchObject({ ledger: 'docs/pipeline/ledgers/p4.json', branch: 'feat/export', plan: 'docs/superpowers/plans/2026-11-03-export.md' })
  expect(JSON.parse(files.get(`${DIR}/ledgers/p4.json`)!)).toMatchObject({
    item: 'p4',
    branch: 'feat/export',
    importedFrom: '.superpowers/sdd/2026-11-03-export/progress.md',
    resume: { task: 2, lastVerified: 'abc1234', at: '2026-11-05T10:00:00.000Z' },
  })
  expect(files.get(`${DIR}/BACKLOG.md`)).toContain('| p3 | Search over articles |')

  // The historical line on the old queue, each progress.md and the final review, once; the plan and the logs are untouched.
  const line = 'Historical. The queue is docs/pipeline/backlog.json since 2026-11-05.'
  expect(files.get(`${MAIN}/docs/backlog.md`)).toBe(`${line}\n\n${BACKLOG_MD}`)
  expect(files.get(`${SDD}/2026-11-01-search/final-review.md`)).toBe(`${line}\n\nfinal\n`)
  expect(files.get(`${SDD}/2026-11-01-search/progress.md`)).toBe(`${line}\n\n${SEARCH_LEDGER}`)
  expect(files.get(`${SDD}/2026-11-03-export/progress.md`)).toBe(`${line}\n\n${EXPORT_LEDGER}`)
  expect(files.get(`${SDD}/2026-11-01-search/logs/task-1.log`)).toBe('log\n')
  expect(files.get(`${MAIN}/docs/superpowers/plans/2026-11-01-search.md`)).toBe('# Search plan\n')
  expect(files.has(`${SDD}/2026-11-01-search/task-1-brief.md`)).toBe(true)
})

test('a second apply is refused without refresh; with refresh it changes no status and adds no second historical line', async ($, on) => {
  const { files, writes } = world(on, TREE)
  const d = JSON.parse(text(await call($, { action: 'migrate' }))) as Draft
  const first = text(await call($, { action: 'migrate-apply', config: d.config, items: [...d.items, ...d.active], rules: d.rules }))
  const before = JSON.parse(files.get(`${DIR}/backlog.json`)!) as { items: Record<string, unknown>[] }
  const writesBefore = writes.length

  expect(text(await call($, { action: 'migrate-apply', config: d.config, items: d.items, rules: d.rules }))).toBe(
    'refused: docs/pipeline/ exists; pass refresh: true to refresh titles, sources and links without changing a status',
  )
  expect(writes.length).toBe(writesBefore)

  // The user set p1 to merged by hand and the old queue now calls the first item something else; the refresh keeps the status.
  files.set(`${DIR}/backlog.json`, files.get(`${DIR}/backlog.json`)!.replace('"status": "inbox"', '"status": "merged"'))
  const again = JSON.parse(text(await call($, { action: 'migrate', refresh: true }))) as Draft
  const edited = again.items.map((i, k) => (k === 0 ? { ...i, title: 'Export jobs and downloads', source: 'docs/backlog.md: Remaining (refreshed)', status: 'inbox' } : i))
  const r = text(await call($, { action: 'migrate-apply', refresh: true, config: again.config, items: [...edited, ...again.active], rules: again.rules }))
  expect(r).toContain('\nhistorical line added to 0 files')
  expect(first.startsWith('pipeline: 4 items')).toBe(true)
  expect(r.startsWith('pipeline: 4 items')).toBe(true)

  const after = JSON.parse(files.get(`${DIR}/backlog.json`)!) as { items: Record<string, unknown>[] }
  expect(after.items.length).toBe(before.items.length)
  expect(after.items.map(i => i.id)).toEqual(before.items.map(i => i.id))
  expect(after.items[0]).toMatchObject({ id: 'p1', status: 'merged', source: 'docs/backlog.md: Remaining (refreshed)' })
  expect(after.items.map(i => i.status)).toEqual(['merged', ...before.items.slice(1).map(i => i.status)])
  // Exactly one historical line.
  expect(files.get(`${MAIN}/docs/backlog.md`)!.split('Historical.').length).toBe(2)
  expect(files.get(`${SDD}/2026-11-03-export/progress.md`)!.split('Historical.').length).toBe(2)
  // The ledger of the building item is not written twice, and its link stays the tool's own.
  expect(writes.filter(w => w === `${DIR}/ledgers/p4.json`).length).toBe(1)
  expect(after.items[3]).toMatchObject({ id: 'p4', status: 'building', ledger: 'docs/pipeline/ledgers/p4.json' })
})

test('migrate-apply refuses a config with problems, items without titles and a missing items list, and writes nothing', async ($, on) => {
  const { writes } = world(on, TREE)
  expect(text(await call($, { action: 'migrate-apply', config: { merge: 'sometimes' }, items: [], rules: [] }))).toBe('refused: merge: expected "auto" or "pr", got "sometimes"')
  expect(text(await call($, { action: 'migrate-apply', config: {}, rules: [] }))).toBe('refused: migrate-apply needs items')
  expect(text(await call($, { action: 'migrate-apply', config: {}, items: [{ status: 'inbox' }], rules: [] }))).toBe('refused: every item needs a title')
  expect(text(await call($, { action: 'migrate-apply', config: {}, items: [{ title: 'x', status: 'done' }], rules: [] }))).toBe('refused: item "x": unknown status "done"')
  expect(writes).toEqual([])
})

test("a subagent's migrate call is ignored", async ($, on) => {
  const { writes } = world(on, TREE)
  expect(await call($, { action: 'migrate', agentId: 'a1' })).toMatchObject({ result: 'ignored: subagents do not write the pipeline' })
  expect(writes).toEqual([])
})

test('migrate-apply with refresh leaves the config on disk as the user tuned it and writes it only when missing', async ($, on) => {
  const { files, writes } = world(on, TREE)
  const d = JSON.parse(text(await call($, { action: 'migrate' }))) as Draft
  await call($, { action: 'migrate-apply', config: d.config, items: [...d.items, ...d.active], rules: d.rules })
  const tuned = JSON.parse(files.get(`${DIR}/config.json`)!) as Record<string, unknown>
  tuned['merge'] = 'auto'
  tuned['limits'] = { ...(tuned['limits'] as Record<string, unknown>), fixRounds: 5 }
  tuned['colour'] = 'red'
  files.set(`${DIR}/config.json`, JSON.stringify(tuned, null, 2) + '\n')
  const configWrites = writes.filter(w => w === `${DIR}/config.json`).length

  const again = JSON.parse(text(await call($, { action: 'migrate', refresh: true }))) as Draft
  await call($, { action: 'migrate-apply', refresh: true, config: { ...again.config, merge: 'pr' }, items: [...again.items, ...again.active], rules: again.rules })
  expect(writes.filter(w => w === `${DIR}/config.json`).length).toBe(configWrites)
  expect(JSON.parse(files.get(`${DIR}/config.json`)!)).toMatchObject({ merge: 'auto', limits: { fixRounds: 5 }, colour: 'red' })
  // The config in force is the one on disk.
  const got = JSON.parse(text(await call($, { action: 'get' }))) as { config: Record<string, unknown> }
  expect(got.config).toMatchObject({ merge: 'auto' })

  // Missing on a refresh: written from the draft.
  files.delete(`${DIR}/config.json`)
  await call($, { action: 'migrate-apply', refresh: true, config: again.config, items: [...again.items, ...again.active], rules: again.rules })
  expect(files.has(`${DIR}/config.json`)).toBe(true)
})
