import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__pipeline__pipeline'
const MAIN = '/p/main'
const WORKTREE = '/p/wt/task-7'
const DIR = `${MAIN}/docs/pipeline`
const CONFIG = `${DIR}/config.json`
const BACKLOG = `${DIR}/backlog.json`
const BACKLOG_MD = `${DIR}/BACKLOG.md`
const NOW = Date.parse('2026-11-05T10:00:00Z')

const VALID_CONFIG = JSON.stringify({ version: 1, mainBranch: 'main', branch: 'feat/<id>', checks: {}, merge: 'pr' }, null, 2) + '\n'

/** A main checkout at /p/main, this session in its worktree, files in memory; records the writes and the plugin's state. */
function world(on: On, seed: Record<string, string> = {}) {
  mock.clock(on, { now: NOW })
  const files = new Map<string, string>(Object.entries(seed))
  const writes: string[] = []
  const state = new Map<string, unknown>()
  const tools: string[] = []
  const key = (p: string) => p.split(String.fromCharCode(92)).join('/')
  on('fs.exists', (_$, e) => ({ value: files.has(key(e.path)) }))
  on('fs.read', (_$, e) => {
    const t = files.get(key(e.path))
    return t === undefined ? { deny: `ENOENT: ${e.path}` } : { value: t }
  })
  on('fs.write', (_$, e) => {
    files.set(key(e.path), e.text)
    writes.push(key(e.path))
    return { value: undefined }
  })
  on('session.repo', () => ({ value: { root: MAIN, remote: null, internal: false, name: null } }) as never)
  on('session.root', () => ({ value: WORKTREE }))
  on('session.cwd', () => ({ value: WORKTREE }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => {
    tools.push(e.name)
    return { value: { tool: e.name } }
  })
  on('state.set', async (_$, e, next) => {
    const r = await next(e)
    if ((e as { plugin: string }).plugin === 'pipeline') state.set((e as { key: string }).key, (e as { value: unknown }).value)
    return r
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  return { files, writes, state, tools }
}

const text = (r: unknown) => String((r as { result: unknown }).result)
const call = ($: { tool: { call: (e: never) => Promise<unknown> } }, input: Record<string, unknown>) => $.tool.call({ tool: TOOL, ...input } as never)
const start = ($: { session: { start: (e: never) => Promise<unknown> } }) => $.session.start({ cwd: WORKTREE, surface: 'terminal', isInteractive: true } as never)
const items = (files: Map<string, string>) => JSON.parse(files.get(BACKLOG)!).items as Record<string, unknown>[]

const ITEM = { title: 'CSV export', size: 'M', needs: [], source: 'user, 2026-11-05: "we need csv export"', note: '' }

test('add creates backlog.json and BACKLOG.md in the main checkout from a worktree and answers the id and the status', async ($, on) => {
  const { files, writes, state } = world(on, { [CONFIG]: VALID_CONFIG })
  const r = await call($, { action: 'add', item: ITEM })
  expect(text(r)).toStartWith('added p1\n')
  expect(text(r)).toContain('pipeline: 1 item · 0 ready')
  expect(text(r)).toContain('Inbox\n  p1 · CSV export · M · no spec')
  expect(writes).toEqual([BACKLOG, BACKLOG_MD])
  expect(files.get(BACKLOG)?.endsWith('\n')).toBe(true)
  expect(items(files)[0]).toMatchObject({ id: 'p1', title: 'CSV export', status: 'inbox', size: 'M', source: ITEM.source, updatedAt: '2026-11-05T10:00:00.000Z' })
  expect(files.get(BACKLOG_MD)).toContain('| p1 | CSV export | M |')
  expect(state.get('backlog')).toMatchObject({ version: 1 })
})

test('a second add merges with what is on disk and keeps unknown fields', async ($, on) => {
  const { files } = world(on, { [CONFIG]: VALID_CONFIG })
  await call($, { action: 'add', item: ITEM })
  files.set(BACKLOG, files.get(BACKLOG)!.replace('"version": 1,', '"version": 1,\n  "colour": "red",').replace('"title": "CSV export"', '"title": "CSV export (edited)"'))
  const r = await call($, { action: 'add', item: { ...ITEM, title: 'Second' } })
  expect(text(r)).toStartWith('added p2\n')
  const parsed = JSON.parse(files.get(BACKLOG)!)
  expect(parsed.colour).toBe('red')
  expect(parsed.items.map((i: { title: string }) => i.title)).toEqual(['CSV export (edited)', 'Second'])
})

test('a backlog edited into invalid JSON: add refuses with the line, nothing is overwritten, status shows the line', async ($, on) => {
  const broken = '{\n  "version": 1,\n  "items": [\n    { "id": "p1", title: "x" }\n  ]\n}\n'
  const { files, writes, state } = world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: broken })
  const r = await call($, { action: 'add', item: ITEM })
  expect(text(r)).toMatch(/^refused: docs\/pipeline\/backlog\.json: line 4: /)
  expect(writes).toEqual([])
  expect(files.get(BACKLOG)).toBe(broken)
  const status = text(await call($, { action: 'status' }))
  expect(status.split('\n')[0]).toMatch(/^pipeline: docs\/pipeline\/backlog\.json: line 4: /)
  await start($)
  expect(state.get('fileError')).toMatch(/^docs\/pipeline\/backlog\.json: line 4: /)
  expect(state.get('backlog') ?? null).toBe(null)
})

test("a subagent's call is ignored and writes nothing", async ($, on) => {
  const { writes } = world(on, { [CONFIG]: VALID_CONFIG })
  const r = await call($, { action: 'add', item: ITEM, agentId: 'a1' })
  expect(r).toMatchObject({ result: 'ignored: subagents do not write the pipeline' })
  expect(writes).toEqual([])
})

test('update sets the spec and the item becomes ready once the spec has no open question', async ($, on) => {
  const { files } = world(on, { [CONFIG]: VALID_CONFIG })
  await call($, { action: 'add', item: ITEM })
  files.set(`${DIR}/specs/p1.md`, '# p1\n\n## What\n\nx\n\n## Open\n\nWhich currency?\n')
  let r = text(await call($, { action: 'update', id: 'p1', set: { spec: 'docs/pipeline/specs/p1.md' } }))
  expect(r).toContain('Inbox\n  p1 · CSV export · M · open question in the spec')
  expect(items(files)[0]).toMatchObject({ status: 'inbox', spec: 'docs/pipeline/specs/p1.md' })
  files.set(`${DIR}/specs/p1.md`, '# p1\n\n## What\n\nx\n\n## Open\n\n_Nothing._\n')
  r = text(await call($, { action: 'update', id: 'p1', set: { note: 'answered' } }))
  expect(r).toContain('pipeline: 1 item · 1 ready')
  expect(r).toContain('Ready\n  p1 · CSV export · M')
  expect(items(files)[0]).toMatchObject({ status: 'ready', note: 'answered', updatedAt: '2026-11-05T10:00:00.000Z' })
})

test('an item whose needs are not merged stays inbox with the reason', async ($, on) => {
  const { files } = world(on, { [CONFIG]: VALID_CONFIG, [`${DIR}/specs/p2.md`]: '## What\n\nx\n' })
  await call($, { action: 'add', item: ITEM })
  const r = text(await call($, { action: 'add', item: { ...ITEM, title: 'Needs one', needs: ['p1'] } }))
  expect(r).toContain('p2 · Needs one · M · waits for p1')
  expect(items(files)[1]).toMatchObject({ status: 'inbox' })
})

test('update of an unknown id is refused', async ($, on) => {
  const { writes } = world(on, { [CONFIG]: VALID_CONFIG })
  await call($, { action: 'add', item: ITEM })
  const r = await call($, { action: 'update', id: 'p9', set: { note: 'x' } })
  expect(text(r)).toBe('refused: no item p9')
  expect(writes.length).toBe(2)
})

test('move, park, unpark and remove', async ($, on) => {
  const { files } = world(on, { [CONFIG]: VALID_CONFIG })
  await call($, { action: 'add', item: ITEM })
  await call($, { action: 'add', item: { ...ITEM, title: 'B' } })
  await call($, { action: 'add', item: { ...ITEM, title: 'C' } })
  const ids = () => items(files).map(i => i.id)
  await call($, { action: 'move', id: 'p3', to: 'top' })
  expect(ids()).toEqual(['p3', 'p1', 'p2'])
  await call($, { action: 'move', id: 'p3', to: { after: 'p2' } })
  expect(ids()).toEqual(['p1', 'p2', 'p3'])
  let r = text(await call($, { action: 'park', id: 'p2' }))
  expect(r).toContain('Parked: p2')
  expect(items(files)[1]).toMatchObject({ status: 'parked' })
  r = text(await call($, { action: 'unpark', id: 'p2' }))
  expect(r).not.toContain('Parked')
  expect(items(files)[1]).toMatchObject({ status: 'inbox' })
  r = text(await call($, { action: 'remove', id: 'p2' }))
  expect(ids()).toEqual(['p1', 'p3'])
  expect(r).toContain('pipeline: 2 items · 0 ready')
  expect(files.get(BACKLOG_MD)).not.toContain('| p2 |')
})

test('get answers the config, the backlog, the readiness and an empty signal list', async ($, on) => {
  world(on, { [CONFIG]: VALID_CONFIG })
  await call($, { action: 'add', item: ITEM })
  const got = JSON.parse(text(await call($, { action: 'get' })))
  expect(got.config).toMatchObject({ mainBranch: 'main', merge: 'pr' })
  expect(got.backlog.items[0]).toMatchObject({ id: 'p1', status: 'inbox' })
  expect(got.readiness).toEqual({ p1: { ready: false, reason: 'no spec' } })
  expect(got.signals).toEqual([])
})

test('status renders the sections and status <id> renders the ledger', async ($, on) => {
  const seed = {
    version: 1,
    items: [
      { id: 'p1', title: 'Building one', status: 'building', size: 'L', ledger: 'docs/pipeline/ledgers/p1.json' },
      { id: 'p2', title: 'Ready one', status: 'ready', size: 'S' },
      { id: 'p3', title: 'Blocked one', status: 'blocked', note: 'needs a credential' },
      { id: 'p4', title: 'Merged one', status: 'merged', pr: 'https://x/pull/4', updatedAt: '2026-11-04T00:00:00Z' },
    ],
  }
  const ledger = { item: 'p1', resume: { task: 2, state: 'review dispatched', at: '2026-11-05T09:00:00Z' }, tasks: [{ n: 1, title: 'One', status: 'accepted', dispatches: [] }, { n: 2, title: 'Two', status: 'running', dispatches: [] }, { n: 3, title: 'Three', status: 'pending', dispatches: [] }], rulings: [], blockers: [], tokens: 0 }
  world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: JSON.stringify(seed, null, 2) + '\n', [`${DIR}/ledgers/p1.json`]: JSON.stringify(ledger, null, 2) + '\n', [`${DIR}/specs/p2.md`]: '## What\n\nx\n' })
  const status = text(await call($, { action: 'status' }))
  expect(status).toContain('pipeline: 4 items · 1 ready')
  expect(status).toContain('Active\n  p1 · Building one · L · building · task 2/3 · review dispatched')
  expect(status).toContain('Ready\n  p2 · Ready one · S')
  expect(status).toContain('Blocked\n  p3 · Blocked one · needs a credential')
  expect(status).toContain('Merged this week\n  p4 · Merged one · https://x/pull/4')
  const one = text(await call($, { action: 'status', id: 'p1' }))
  expect(one.split('\n')[0]).toBe('p1 · Building one · building · task 2/3 · review dispatched')
  expect(one).toContain('  2 · Two · running')
  expect(text(await call($, { action: 'status', id: 'p2' }))).toBe('p2 · Ready one · ready\nno ledger')
  expect(text(await call($, { action: 'status', id: 'p9' }))).toBe('no item p9')
})

test('init writes the defaults and an empty backlog, and a second init changes nothing', async ($, on) => {
  const { files, writes } = world(on)
  const r = text(await call($, { action: 'init' }))
  expect(r).toBe('wrote docs/pipeline/config.json, docs/pipeline/backlog.json, docs/pipeline/BACKLOG.md')
  expect(writes).toEqual([CONFIG, BACKLOG, BACKLOG_MD])
  expect(JSON.parse(files.get(CONFIG)!)).toMatchObject({ version: 1, merge: 'pr', protectedPaths: ['.github/workflows/**'] })
  expect(JSON.parse(files.get(BACKLOG)!)).toEqual({ version: 1, items: [] })
  expect(files.get(BACKLOG_MD)).toContain('No items.')
  const again = text(await call($, { action: 'init' }))
  expect(again).toBe('exists: docs/pipeline/config.json')
  expect(writes.length).toBe(3)
})

test('status without a config says so', async ($, on) => {
  world(on)
  expect(text(await call($, { action: 'status' }))).toBe('pipeline: no config (run /pipeline init)')
})

test('an unknown action is refused', async ($, on) => {
  world(on, { [CONFIG]: VALID_CONFIG })
  expect(text(await call($, { action: 'dance' }))).toMatch(/^refused: unknown action "dance"/)
})

test('session.start registers the tool and loads the backlog', async ($, on) => {
  const { state, tools } = world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: '{ "version": 1, "items": [{ "id": "p1", "title": "A", "status": "inbox" }] }\n' })
  await start($)
  expect(tools).toEqual(['pipeline'])
  expect(state.get('backlog')).toMatchObject({ items: [{ id: 'p1' }] })
  expect(state.get('fileError') ?? null).toBe(null)
})
