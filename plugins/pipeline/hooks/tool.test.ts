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
function world(on: On, seed: Record<string, string> = {}, options: { rename?: 'ok' | 'deny' } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, string>(Object.entries(seed))
  const writes: string[] = []
  const state = new Map<string, unknown>()
  const tools: string[] = []
  const renames: string[] = []
  on('command.run', { command: 'rename' }, (_$, e) => {
    if (options.rename === 'deny') return { deny: 'no names on this surface' } as never
    renames.push(String(e.args ?? ''))
    return { text: 'renamed' } as never
  })
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
  on('turn.complete', () => ({ text: '' }) as never)
  return { files, writes, state, tools, renames, clock }
}

const text = (r: unknown) => String((r as { result: unknown }).result)
const call = ($: { tool: { call: (e: never) => Promise<unknown> } }, input: Record<string, unknown>) => $.tool.call({ tool: TOOL, ...input } as never)
/** The turn's end, where a queued rename runs. */
const endTurn = ($: { turn: { complete: unknown } }) => ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'ok' })
const start = ($: { session: { start: (e: never) => Promise<unknown> } }) => $.session.start({ cwd: WORKTREE, surface: 'terminal', isInteractive: true } as never)
const items = (files: Map<string, string>) => JSON.parse(files.get(BACKLOG)!).items as Record<string, unknown>[]

const ITEM = { title: 'CSV export', size: 'M', needs: [], source: 'user, 2026-11-05: "we need csv export"', note: '' }

test('add creates backlog.json and BACKLOG.md in the main checkout from a worktree and answers the id and the status', async ($, on) => {
  const { files, writes, state } = world(on, { [CONFIG]: VALID_CONFIG })
  const r = await call($, { action: 'add', item: ITEM })
  expect(text(r)).toBe('added p1 · inbox · no spec')
  expect(writes).toEqual([BACKLOG, BACKLOG_MD])
  const status = text(await call($, { action: 'status' }))
  expect(status).toContain('pipeline: 1 item · 0 ready')
  expect(status).toContain('Inbox\n  p1 · CSV export · M · no spec')
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
  expect(text(r)).toBe('added p2 · inbox · no spec')
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
  expect(r).toBe('p1 · inbox · open question in the spec · set spec')
  expect(items(files)[0]).toMatchObject({ status: 'inbox', spec: 'docs/pipeline/specs/p1.md' })
  files.set(`${DIR}/specs/p1.md`, '# p1\n\n## What\n\nx\n\n## Open\n\n_Nothing._\n')
  r = text(await call($, { action: 'update', id: 'p1', set: { note: 'answered' } }))
  expect(r).toBe('p1 · ready · set note')
  expect(text(await call($, { action: 'status' }))).toContain('Ready\n  p1 · CSV export · M')
  expect(items(files)[0]).toMatchObject({ status: 'ready', note: 'answered', updatedAt: '2026-11-05T10:00:00.000Z' })
})

test('an item whose needs are not merged stays inbox with the reason', async ($, on) => {
  const { files } = world(on, { [CONFIG]: VALID_CONFIG, [`${DIR}/specs/p2.md`]: '## What\n\nx\n' })
  await call($, { action: 'add', item: ITEM })
  const r = text(await call($, { action: 'add', item: { ...ITEM, title: 'Needs one', needs: ['p1'] } }))
  expect(r).toBe('added p2 · inbox · waits for p1')
  expect(items(files)[1]).toMatchObject({ status: 'inbox' })
})

test('an update that starts an item names the session after it once: to planning, or to building from another status; never for a note or a later step', async ($, on) => {
  const { renames } = world(on, { [CONFIG]: VALID_CONFIG })
  await call($, { action: 'add', item: { ...ITEM, title: 'grid-track-sizes — Grid row and column sizes' } })
  await call($, { action: 'add', item: { ...ITEM, title: 'y'.repeat(80) } })
  await call($, { action: 'update', id: 'p1', set: { note: 'a note' } })
  await endTurn($)
  expect(renames).toEqual([])
  // The rename cannot run inside the tool's hook: it runs when the turn ends.
  await call($, { action: 'update', id: 'p1', set: { status: 'planning' } })
  expect(renames).toEqual([])
  await endTurn($)
  expect(renames).toEqual(['p1 · Grid row and column sizes'])
  await endTurn($)
  expect(renames).toEqual(['p1 · Grid row and column sizes'])
  // The same item going on to building, review and merged renames nothing more.
  for (const status of ['building', 'review', 'merged']) {
    await call($, { action: 'update', id: 'p1', set: { status } })
    await endTurn($)
  }
  expect(renames).toEqual(['p1 · Grid row and column sizes'])
  // Another item straight to building: its own name, the title cut to 60 characters.
  await call($, { action: 'update', id: 'p2', set: { status: 'building' } })
  await endTurn($)
  expect(renames).toEqual(['p1 · Grid row and column sizes', `p2 · ${'y'.repeat(59)}…`])
  await call($, { action: 'update', id: 'p2', set: { status: 'blocked', note: 'CI red' } })
  await call($, { action: 'update', id: 'p2', set: { status: 'building' } })
  await endTurn($)
  expect(renames).toHaveLength(2)
})

test('renameSession false never renames, and a refused rename does not fail the update', async ($, on) => {
  const off = JSON.stringify({ version: 1, mainBranch: 'main', branch: 'feat/<id>', checks: {}, merge: 'pr', renameSession: false }, null, 2) + '\n'
  const { renames } = world(on, { [CONFIG]: off })
  await call($, { action: 'add', item: ITEM })
  await call($, { action: 'update', id: 'p1', set: { status: 'planning' } })
  await endTurn($)
  expect(renames).toEqual([])
})

test('a refused rename does not fail the update', async ($, on) => {
  const { renames, files } = world(on, { [CONFIG]: VALID_CONFIG }, { rename: 'deny' })
  await call($, { action: 'add', item: ITEM })
  const r = text(await call($, { action: 'update', id: 'p1', set: { status: 'building' } }))
  expect(r).toBe('p1 · building')
  expect(items(files)[0]).toMatchObject({ status: 'building' })
  await endTurn($)
  expect(renames).toEqual([])
  // The next turn's end does not try again.
  await endTurn($)
  expect(renames).toEqual([])
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
  expect(text(await call($, { action: 'move', id: 'p3', to: 'top' }))).toBe('p3 · moved to the top · inbox · no spec')
  expect(ids()).toEqual(['p3', 'p1', 'p2'])
  expect(text(await call($, { action: 'move', id: 'p3', to: { after: 'p2' } }))).toBe('p3 · moved after p2 · inbox · no spec')
  expect(ids()).toEqual(['p1', 'p2', 'p3'])
  let r = text(await call($, { action: 'park', id: 'p2' }))
  expect(r).toBe('p2 · parked')
  expect(items(files)[1]).toMatchObject({ status: 'parked' })
  r = text(await call($, { action: 'unpark', id: 'p2' }))
  expect(r).toBe('p2 · inbox · no spec')
  expect(items(files)[1]).toMatchObject({ status: 'inbox' })
  r = text(await call($, { action: 'remove', id: 'p2' }))
  expect(ids()).toEqual(['p1', 'p3'])
  expect(r).toBe('removed p2 · 2 items left')
  expect(files.get(BACKLOG_MD)).not.toContain('| p2 |')
})

test('get { full } answers the config, the backlog, the readiness and an empty signal list', async ($, on) => {
  world(on, { [CONFIG]: VALID_CONFIG })
  await call($, { action: 'add', item: ITEM })
  const got = JSON.parse(text(await call($, { action: 'get', full: true })))
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
  expect(one.split('\n')[0]).toBe('p1 · Building one · building · resume: task 2/3 · review dispatched · at 2026-11-05T09:00:00Z')
  expect(one).toContain('Tasks\n  1 · One · accepted\n  2 · Two · running\n  3 · Three · pending')
  expect(text(await call($, { action: 'status', id: 'p2' }))).toBe('p2 · Ready one · ready\nno ledger')
  expect(text(await call($, { action: 'status', id: 'p9' }))).toBe('no item p9')
})

test('init writes the defaults and an empty backlog, and a second init changes nothing', async ($, on) => {
  const { files, writes } = world(on)
  const r = text(await call($, { action: 'init' }))
  expect(r).toBe('wrote docs/pipeline/config.json, docs/pipeline/backlog.json, docs/pipeline/BACKLOG.md\ncommit docs/pipeline/ on main now: git add docs/pipeline && git commit')
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

const LEDGER = `${DIR}/ledgers/p1.json`
const ledgerOf = (files: Map<string, string>) => JSON.parse(files.get(LEDGER)!)
const dispatch = (tokens: number, result: string, role = 'implementer') => ({ role, model: 'sonnet', effort: 'medium', tokens, minutes: 1, result })

test('ledger creates the file and links it from the item, mirroring branch, pr and plan', async ($, on) => {
  const { files, writes } = world(on, { [CONFIG]: VALID_CONFIG })
  await call($, { action: 'add', item: ITEM })
  const r = text(await call($, { action: 'ledger', item: 'p1', set: { branch: 'feat/p1', worktree: '.claude/worktrees/p1', base: 'a3f91c2', plan: 'docs/pipeline/plans/p1.md' } }))
  expect(r).toBe('ledger p1 · no tasks')
  const full = text(await call($, { action: 'status', id: 'p1' }))
  expect(full.split('\n')[0]).toBe('p1 · CSV export · inbox · no resume')
  expect(full.split('\n')[1]).toBe('  branch feat/p1 · worktree .claude/worktrees/p1')
  expect(writes.slice(2)).toEqual([LEDGER, BACKLOG, BACKLOG_MD])
  expect(files.get(LEDGER)?.endsWith('\n')).toBe(true)
  expect(ledgerOf(files)).toEqual({ item: 'p1', pr: null, tasks: [], rulings: [], blockers: [], final: null, tokens: 0, branch: 'feat/p1', worktree: '.claude/worktrees/p1', base: 'a3f91c2', plan: 'docs/pipeline/plans/p1.md' })
  expect(items(files)[0]).toMatchObject({ ledger: 'docs/pipeline/ledgers/p1.json', branch: 'feat/p1', plan: 'docs/pipeline/plans/p1.md' })
  await call($, { action: 'ledger', item: 'p1', set: { pr: '#31' } })
  expect(items(files)[0]).toMatchObject({ pr: '#31' })
  expect(ledgerOf(files).pr).toBe('#31')
})

test('a task entry merged twice keeps both dispatches and the later status; rulings number themselves; tokens sum', async ($, on) => {
  const { files, writes } = world(on, { [CONFIG]: VALID_CONFIG })
  await call($, { action: 'add', item: ITEM })
  await call($, { action: 'ledger', item: 'p1', set: { tasks: [{ n: 1, title: 'One', status: 'pending', dispatches: [] }, { n: 2, title: 'Two', status: 'pending', dispatches: [] }], resume: { task: 1, state: 'planned', lastVerified: 'a3f91c2' } } })
  await call($, { action: 'ledger', item: 'p1', set: { tasks: [{ n: 2, status: 'running' }], rulings: [{ task: 2, text: 'Keep the snapshot id', why: 'immutable', costIfWrong: 'exports change' }] } })
  await call($, { action: 'ledger', item: 'p1', set: { tasks: [{ n: 2, dispatches: [dispatch(100, 'fix round 1')] }] } })
  const r = text(await call($, { action: 'ledger', item: 'p1', set: { tasks: [{ n: 2, status: 'accepted', commits: 'a..b', dispatches: [dispatch(50, 'done'), dispatch(25, 'approved', 'reviewer')], review: { kind: 'independent', verdict: 'approved' } }], rulings: [{ text: 'B', why: 'b', costIfWrong: 'c' }], resume: { task: 3, state: 'task 2 accepted', lastVerified: 'b' } } }))
  const l = ledgerOf(files)
  expect(l.tasks).toEqual([
    { n: 1, title: 'One', status: 'pending', dispatches: [] },
    { n: 2, title: 'Two', status: 'accepted', commits: 'a..b', dispatches: [dispatch(100, 'fix round 1'), dispatch(50, 'done'), dispatch(25, 'approved', 'reviewer')], review: { kind: 'independent', verdict: 'approved' } },
  ])
  expect(l.rulings).toEqual([{ n: 1, task: 2, text: 'Keep the snapshot id', why: 'immutable', costIfWrong: 'exports change' }, { n: 2, text: 'B', why: 'b', costIfWrong: 'c' }])
  expect(l.tokens).toBe(175)
  expect(l.resume).toEqual({ task: 3, state: 'task 2 accepted', lastVerified: 'b', at: '2026-11-05T10:00:00.000Z' })
  expect(r).toBe('ledger p1 · task 2/2 · task 2 accepted · 2 rulings · 175 tokens')
  const full = text(await call($, { action: 'status', id: 'p1' }))
  expect(full.split('\n')[0]).toBe('p1 · CSV export · inbox · resume: task 3/2 · task 2 accepted · verified b · at 2026-11-05T10:00:00.000Z')
  expect(full).toContain('Tasks\n  1 · One · pending\n  2 · Two · accepted · a..b · 3 dispatches (implementer ×2, reviewer) · approved\n')
  expect(full).toContain('Rulings\n  R1 (task 2): Keep the snapshot id — immutable — exports change\n  R2: B — b — c\n')
  expect(full).toContain('Tokens: 175')
  // Only the first ledger call touched the backlog (to link the file); the others wrote the ledger alone.
  expect(writes.filter(w => w === BACKLOG).length).toBe(2)
})

test('ledger records the final verdict and the blockers without duplicates', async ($, on) => {
  const { files } = world(on, { [CONFIG]: VALID_CONFIG })
  await call($, { action: 'add', item: ITEM })
  await call($, { action: 'ledger', item: 'p1', set: { tasks: [{ n: 1, dispatches: [dispatch(10, 'done')] }], blockers: ['CI red'] } })
  const r = text(await call($, { action: 'ledger', item: 'p1', set: { final: { verdict: 'approved', gate: 'green', tokens: 5 }, blockers: ['CI red', 'needs a credential'] } }))
  expect(ledgerOf(files)).toMatchObject({ final: { verdict: 'approved', gate: 'green', tokens: 5 }, blockers: ['CI red', 'needs a credential'], tokens: 15 })
  expect(r).toBe('ledger p1 · final approved · 2 blockers · 15 tokens')
  expect(text(await call($, { action: 'status', id: 'p1' }))).toContain('Blockers\n  CI red\n  needs a credential\nFinal: approved · gate green · 5 tokens\nTokens: 15')
})

test('a parse error in the ledger file is refused and the file is left alone', async ($, on) => {
  const broken = '{\n  "item": "p1",\n  tasks: []\n}\n'
  const seed = { version: 1, items: [{ id: 'p1', title: 'A', status: 'building', ledger: 'docs/pipeline/ledgers/p1.json' }] }
  const { files, writes } = world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: JSON.stringify(seed, null, 2) + '\n', [LEDGER]: broken })
  const r = text(await call($, { action: 'ledger', item: 'p1', set: { pr: '#1' } }))
  expect(r).toMatch(/^refused: docs\/pipeline\/ledgers\/p1\.json: line 3: /)
  expect(writes).toEqual([])
  expect(files.get(LEDGER)).toBe(broken)
  expect(text(await call($, { action: 'status', id: 'p1' }))).toMatch(/^p1 · A · building\ndocs\/pipeline\/ledgers\/p1\.json: line 3: /)
})

test('ledger needs a known item and a set', async ($, on) => {
  const { writes } = world(on, { [CONFIG]: VALID_CONFIG })
  await call($, { action: 'add', item: ITEM })
  expect(text(await call($, { action: 'ledger', item: 'p9', set: { pr: '#1' } }))).toBe('refused: no item p9')
  expect(text(await call($, { action: 'ledger', item: 'p1' }))).toBe('refused: ledger needs set')
  expect(text(await call($, { action: 'ledger', set: { pr: '#1' } }))).toBe('refused: an id is needed')
  expect(writes.length).toBe(2)
})

test('I7: a removed id is not reused, and a stale ledger file of an unlinked item is refused by name', async ($, on) => {
  const { files, writes } = world(on, { [CONFIG]: VALID_CONFIG })
  await call($, { action: 'add', item: { title: 'Old thing' } })
  files.set(`${DIR}/specs/p1.md`, '## What\n\nold spec\n\n## Open\n\n_Nothing._\n')
  await call($, { action: 'ledger', item: 'p1', set: { tasks: [{ n: 1, title: 'old task', status: 'accepted', dispatches: [] }] } })
  await call($, { action: 'remove', id: 'p1' })
  const r = text(await call($, { action: 'add', item: { title: 'New thing' } }))
  expect(items(files).map(i => i.id)).toEqual(['p2'])
  // The old spec answers for nobody: p2 has no spec of its own.
  expect(r).toBe('added p2 · inbox · no spec')
  expect(JSON.parse(files.get(BACKLOG)!).lastId).toBe(2)

  // An item without a ledger link whose ledger file exists on disk (left by a removed item, or written by hand).
  files.set(BACKLOG, JSON.stringify({ version: 1, items: [{ id: 'p1', title: 'Again', status: 'inbox', ledger: null }] }))
  const before = writes.length
  const refused = text(await call($, { action: 'ledger', item: 'p1', set: { pr: '#2' } }))
  expect(refused).toStartWith('refused: docs/pipeline/ledgers/p1.json exists but p1 has no ledger link')
  expect(writes.length).toBe(before)
  expect(JSON.parse(files.get(LEDGER)!).tasks[0].title).toBe('old task')
  // Linked explicitly, the file is merged into.
  await call($, { action: 'update', id: 'p1', set: { ledger: 'docs/pipeline/ledgers/p1.json' } })
  expect(text(await call($, { action: 'ledger', item: 'p1', set: { pr: '#2' } }))).toBe('ledger p1 · 1 task')
  expect(text(await call($, { action: 'status', id: 'p1' }))).toContain('old task')
})

test('I4: get names a planning item as active, with resume null until its ledger has the block', async ($, on) => {
  const backlog = JSON.stringify({ version: 1, items: [{ id: 'p12', title: 'CSV export', status: 'planning', ledger: 'docs/pipeline/ledgers/p12.json' }] })
  const { files } = world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: backlog, [`${DIR}/ledgers/p12.json`]: JSON.stringify({ item: 'p12', branch: 'feat/p12', worktree: '.claude/worktrees/p12', tasks: [], rulings: [], blockers: [], tokens: 0 }) })
  await start($)
  const got = JSON.parse(text(await call($, { action: 'get' }))) as { active: { id: string; branch: unknown; worktree: unknown }; resume: unknown }
  expect(got.active).toMatchObject({ id: 'p12', status: 'planning', branch: 'feat/p12', worktree: '.claude/worktrees/p12' })
  expect(got.resume).toBe(null)
  files.set(`${DIR}/ledgers/p12.json`, JSON.stringify({ item: 'p12', tasks: [], rulings: [], blockers: [], tokens: 0, resume: { task: 1, state: 'planned', at: '2026-11-05T09:00:00Z' } }))
  const again = JSON.parse(text(await call($, { action: 'get' }))) as { active: unknown; resume: unknown }
  expect(again.resume).toMatchObject({ task: 1, state: 'planned' })
})

// ---------- 0.2.2: a lean get ----------

/** A backlog the size of catalo's at its first run: 71 items with real-length titles, sources and notes. */
function bigBacklog(): { backlog: string; files: Record<string, string> } {
  const statuses = ['merged', 'merged', 'merged', 'building', ...Array(14).fill('ready'), ...Array(45).fill('inbox'), 'blocked', 'blocked', ...Array(6).fill('parked')] as string[]
  const files: Record<string, string> = {}
  const list = statuses.map((status, n) => {
    const id = `p${n + 1}`
    const spec = status === 'inbox' && n % 3 === 0 ? null : `docs/pipeline/specs/${id}.md`
    if (spec) files[`${MAIN}/${spec}`] = `## What\n\n${'x '.repeat(200)}\n\n## Open\n\n_Nothing._\n`
    return {
      id,
      title: `${id}-slug — A catalog feature with a title as long as catalo's (${n})`,
      status,
      size: (['S', 'M', 'L'] as const)[n % 3],
      needs: n > 20 && n % 5 === 0 ? [`p${n - 1}`] : [],
      source: `user, 2026-11-0${(n % 9) + 1}: "${'the person asked for this in a long sentence that the queue quoted verbatim '.repeat(2)}"`,
      note: `${'A scope note as catalo writes them: what changes, which files, what stays the same, and why it matters. '.repeat(5)}`,
      spec,
      plan: status === 'building' || status === 'merged' ? `docs/pipeline/plans/${id}.md` : null,
      branch: status === 'building' || status === 'merged' ? `feat/${id}` : null,
      pr: status === 'merged' ? `https://github.com/koderi-dp/catalo/pull/${n}` : null,
      ledger: status === 'building' ? `docs/pipeline/ledgers/${id}.json` : null,
      updatedAt: '2026-11-05T09:00:00.000Z',
    }
  })
  files[`${DIR}/ledgers/p4.json`] = JSON.stringify({ item: 'p4', branch: 'feat/p4', worktree: '.claude/worktrees/p4', tasks: [{ n: 1, title: 'One', status: 'accepted', dispatches: [] }, { n: 2, title: 'Two', status: 'running', dispatches: [] }], rulings: [], blockers: [], tokens: 674000, resume: { task: 2, state: 'implementer dispatched', lastVerified: 'abc1234', at: '2026-11-05T09:00:00.000Z' } })
  return { backlog: JSON.stringify({ version: 1, items: list }, null, 2) + '\n', files }
}

test('0.2.2: get answers a slim compact JSON under 8,000 characters for a 71-item backlog, with every field the run skill reads', async ($, on) => {
  const big = bigBacklog()
  world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: big.backlog, ...big.files })
  const answer = text(await call($, { action: 'get' }))
  const full = text(await call($, { action: 'get', full: true }))
  expect(answer.length).toBeLessThan(8000)
  expect(answer).not.toContain('\n')
  const got = JSON.parse(answer)
  expect(Object.keys(got).sort()).toEqual(['active', 'children', 'config', 'counts', 'next', 'resume', 'siblings', 'signals'])
  expect(got.active).toEqual({ id: 'p4', title: expect.stringContaining('p4-slug'), status: 'building', note: expect.any(String), spec: 'docs/pipeline/specs/p4.md', plan: 'docs/pipeline/plans/p4.md', branch: 'feat/p4', worktree: '.claude/worktrees/p4' })
  expect(got.resume).toMatchObject({ task: 2, state: 'implementer dispatched', lastVerified: 'abc1234' })
  expect(got.signals).toEqual([])
  expect(got.children).toEqual([])
  expect(got.counts).toEqual({ inbox: 45, ready: 14, building: 1, review: 0, blocked: 2, parked: 6, merged: 3 })
  expect(got.next).toEqual([
    { id: 'p5', title: expect.stringContaining('p5-slug'), size: 'M', spec: 'docs/pipeline/specs/p5.md', reason: 'ready' },
    { id: 'p6', title: expect.stringContaining('p6-slug'), size: 'L', spec: 'docs/pipeline/specs/p6.md', reason: 'ready' },
    { id: 'p7', title: expect.stringContaining('p7-slug'), size: 'S', spec: 'docs/pipeline/specs/p7.md', reason: 'ready' },
  ])
  expect(Object.keys(got.config).sort()).toEqual(['checks', 'limits', 'merge', 'mergeMethod', 'models', 'protectedPaths', 'riskyPaths', 'runner', 'superpowers', 'taskReview'])
  expect(got.config).toMatchObject({ runner: 'subagent', taskReview: 'risky', merge: 'pr', mergeMethod: 'merge', limits: { fixRounds: expect.any(Number), silentMinutes: expect.any(Number) }, models: { implementer: expect.any(Object), final: expect.any(Object) } })
  // The full answer is today's shape, pretty-printed.
  const all = JSON.parse(full)
  expect(Object.keys(all).sort()).toEqual(['active', 'backlog', 'children', 'config', 'mergedPending', 'readiness', 'resume', 'siblings', 'signals'])
  expect(all.backlog.items).toHaveLength(71)
  expect(all.active).toBe('p4')
})

test('0.2.2: get with nothing ready lists the first inbox items with their reasons; get { id } adds that item; get { titles } adds every title', async ($, on) => {
  const seed = { version: 1, items: [{ id: 'p1', title: 'A', status: 'inbox', size: 'S', note: 'n' }, { id: 'p2', title: 'B', status: 'merged' }, { id: 'p3', title: 'C', status: 'inbox', needs: ['p1'], spec: 'docs/pipeline/specs/p3.md' }] }
  world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: JSON.stringify(seed), [`${DIR}/specs/p3.md`]: '## What\n\nx\n' })
  const got = JSON.parse(text(await call($, { action: 'get' })))
  expect(got.active).toBe(null)
  expect(got.resume).toBe(null)
  expect(got.next).toEqual([{ id: 'p1', title: 'A', size: 'S', reason: 'no spec' }, { id: 'p3', title: 'C', spec: 'docs/pipeline/specs/p3.md', reason: 'waits for p1' }])
  expect(got.item).toBeUndefined()
  const one = JSON.parse(text(await call($, { action: 'get', id: 'p3' })))
  expect(one.item).toMatchObject({ id: 'p3', title: 'C', status: 'inbox', needs: ['p1'], spec: 'docs/pipeline/specs/p3.md', readiness: { ready: false, reason: 'waits for p1' } })
  expect(JSON.parse(text(await call($, { action: 'get', id: 'p9' }))).item).toBe(null)
  const titles = JSON.parse(text(await call($, { action: 'get', titles: true })))
  expect(titles.titles).toEqual(['p1 inbox A', 'p2 merged B', 'p3 inbox C'])
})

test('0.2.2: a ledger write answers one line: the running task, the rulings and the tokens', async ($, on) => {
  world(on, { [CONFIG]: VALID_CONFIG })
  await call($, { action: 'add', item: ITEM })
  await call($, { action: 'ledger', item: 'p1', set: { tasks: [1, 2, 3, 4, 5, 6].map(n => ({ n, title: `T${n}`, status: n < 3 ? 'accepted' : 'pending', dispatches: [] })), rulings: [{ text: 'a', why: 'b', costIfWrong: 'c' }, { text: 'd', why: 'e', costIfWrong: 'f' }] } })
  const r = text(await call($, { action: 'ledger', item: 'p1', set: { tasks: [{ n: 3, status: 'running', dispatches: [dispatch(674000, 'running')] }], resume: { task: 3, state: 'implementer dispatched', lastVerified: 'a' } } }))
  expect(r).toBe('ledger p1 · task 3/6 running · 2 rulings · 674k tokens')
  expect(text(await call($, { action: 'ledger', item: 'p1', set: { final: { verdict: 'approved' }, tasks: [{ n: 4, dispatches: [dispatch(800000, 'done')] }] } }))).toBe('ledger p1 · final approved · 2 rulings · 1.5M tokens')
})

// ---------- 0.2.3: a PR merged by hand ----------

/** A git whose `origin/main` holds the given branch tips; records every call. */
function gitWorld(on: On, merged: string[], remoteRefs: string[] = ['refs/remotes/origin/main']) {
  const runs: string[][] = []
  on('process.run', (_$, e) => {
    const argv = [...(e as { argv: readonly string[] }).argv]
    runs.push(argv)
    const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    const sub = argv[3]
    if (sub === 'fetch') return { value: ok } as never
    if (sub === 'rev-parse') return { value: { ...ok, exitCode: remoteRefs.includes(argv[6]!) ? 0 : 1 } } as never
    if (sub === 'merge-base') return { value: { ...ok, exitCode: merged.includes(argv[5]!) ? 0 : 1 } } as never
    return { value: { ...ok, exitCode: 1, stderr: 'unknown command' } } as never
  })
  return runs
}

const REVIEW_SEED = {
  [CONFIG]: VALID_CONFIG,
  [BACKLOG]: JSON.stringify({ version: 1, items: [{ id: 'p1', title: 'Login', status: 'review', pr: '#3' }, { id: 'p2', title: 'Export', status: 'ready' }] }),
  [`${DIR}/ledgers/p1.json`]: JSON.stringify({ item: 'p1', branch: 'feat/p1', worktree: '.claude/worktrees/p1', tasks: [], rulings: [], blockers: [], tokens: 0 }),
  [`${DIR}/specs/p2.md`]: '## What\n\nx\n',
}

test('get answers mergedPending for a review item whose branch tip is on origin/main, fetching once a minute', async ($, on) => {
  const { clock } = world(on, REVIEW_SEED)
  const runs = gitWorld(on, ['feat/p1'])
  const got = JSON.parse(text(await call($, { action: 'get' }))) as { mergedPending?: unknown; active: { id: string } }
  expect(got.mergedPending).toEqual([{ id: 'p1', branch: 'feat/p1', pr: '#3' }])
  expect(got.active.id).toBe('p1')
  expect(runs[0]).toEqual(['git', '-C', MAIN, 'fetch', '-q', 'origin', 'main'])
  expect(runs.at(-1)).toEqual(['git', '-C', MAIN, 'merge-base', '--is-ancestor', 'feat/p1', 'origin/main'])
  const fetches = () => runs.filter(r => r[3] === 'fetch').length
  expect(fetches()).toBe(1)
  // Within the minute: no second fetch; the check still runs.
  const full = JSON.parse(text(await call($, { action: 'get', full: true }))) as { mergedPending: unknown }
  expect(full.mergedPending).toEqual([{ id: 'p1', branch: 'feat/p1', pr: '#3' }])
  expect(fetches()).toBe(1)
  // The status block carries the line.
  expect(text(await call($, { action: 'status' }))).toContain('pipeline: 2 items · 1 ready\np1 merged on main · run /pipeline next or "continue the pipeline" to close it')
  // Past the minute: fetched again.
  await clock.advance(60_000)
  await call($, { action: 'get' })
  expect(fetches()).toBe(2)
})

test('get leaves mergedPending out when the tip is not on origin/main, and signals answers it with the signals when it is', async ($, on) => {
  world(on, REVIEW_SEED)
  gitWorld(on, [])
  const got = JSON.parse(text(await call($, { action: 'get' }))) as Record<string, unknown>
  expect('mergedPending' in got).toBe(false)
  expect(JSON.parse(text(await call($, { action: 'get', full: true }))).mergedPending).toEqual([])
  expect(text(await call($, { action: 'signals' }))).toBe('no signals')
  expect(text(await call($, { action: 'status' }))).not.toContain('merged on main')
})

test('signals answers { signals, mergedPending } for a merged PR, and a remote tracking tip is preferred', async ($, on) => {
  world(on, REVIEW_SEED)
  const runs = gitWorld(on, ['refs/remotes/origin/feat/p1'], ['refs/remotes/origin/main', 'refs/remotes/origin/feat/p1'])
  expect(JSON.parse(text(await call($, { action: 'signals' })))).toEqual({ signals: [], mergedPending: [{ id: 'p1', branch: 'feat/p1', pr: '#3' }] })
  expect(runs.at(-1)).toEqual(['git', '-C', MAIN, 'merge-base', '--is-ancestor', 'refs/remotes/origin/feat/p1', 'origin/main'])
})

test('a building item with a pr is checked, one without is not, and a git that fails reads as not merged', async ($, on) => {
  const seed = {
    ...REVIEW_SEED,
    [BACKLOG]: JSON.stringify({ version: 1, items: [{ id: 'p1', title: 'Login', status: 'building', pr: '#3' }, { id: 'p3', title: 'Other', status: 'building' }] }),
    [`${DIR}/ledgers/p3.json`]: JSON.stringify({ item: 'p3', branch: 'feat/p3', tasks: [], rulings: [], blockers: [], tokens: 0 }),
  }
  world(on, seed)
  const runs = gitWorld(on, ['feat/p1', 'feat/p3'])
  const got = JSON.parse(text(await call($, { action: 'get' }))) as { mergedPending?: unknown }
  expect(got.mergedPending).toEqual([{ id: 'p1', branch: 'feat/p1', pr: '#3' }])
  expect(runs.some(r => r.includes('feat/p3'))).toBe(false)
})

test('without a process.run handler the check is unknown and get still answers', async ($, on) => {
  world(on, REVIEW_SEED)
  const got = JSON.parse(text(await call($, { action: 'get' }))) as Record<string, unknown>
  expect('mergedPending' in got).toBe(false)
  expect(got['active']).toMatchObject({ id: 'p1' })
})

test('at session start a merged PR with its Close pending is one toast per item', async ($, on) => {
  world(on, REVIEW_SEED)
  gitWorld(on, ['feat/p1'])
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  await start($)
  expect(toasts).toEqual(['pipeline: p1 merged on main · run /pipeline next or "continue the pipeline" to close it'])
})

// ---------- 0.3.0: the tool reads the plan and renders the briefs ----------

const WT = `${MAIN}/.claude/worktrees/p1`
const PLAN_MD = `# p1: CSV export

## Constraints
Kysely only.

### Task 1: Schema
- Files: db/schema.sql, src/job.ts
- Check: npm test -- job
- Focus: the organization filter

Write the failing test first.

### Task 2: Route
- Files: src/route.ts
- Needs: 1

Build the route.
`
const BUILD_SEED = {
  [CONFIG]: JSON.stringify({ version: 1, mainBranch: 'main', branch: 'feat/<id>', checks: { fast: 'npm run fast', task: 'npm test', gate: 'npm run gate' }, riskyPaths: ['db/**'], merge: 'pr' }),
  [BACKLOG]: JSON.stringify({ version: 1, items: [{ id: 'p1', title: 'CSV export', status: 'planning', spec: 'docs/pipeline/specs/p1.md', ledger: 'docs/pipeline/ledgers/p1.json' }] }),
  [`${DIR}/ledgers/p1.json`]: JSON.stringify({ item: 'p1', branch: 'feat/p1', worktree: '.claude/worktrees/p1', base: 'a1b2c3d', tasks: [], rulings: [], blockers: [], tokens: 0 }),
  [`${DIR}/specs/p1.md`]: '# p1\n\n## What\n\nx\n\n## Acceptance\n\n- [ ] A CSV downloads.\n\n## Open\n',
  [`${DIR}/rules.md`]: '# Rules\n\n## In every implementer brief\n\n1. No raw SQL.\n',
}
/** A git that answers the changed files of a range and a head. */
function diffWorld(on: On, changed: string[]) {
  on('process.run', (_$, e) => {
    const argv = [...(e as { argv: readonly string[] }).argv]
    const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (argv[3] === 'diff') return { value: { ...ok, stdout: changed.join('\n') + '\n' } } as never
    if (argv[3] === 'rev-parse') return { value: { ...ok, stdout: 'f00d123\n' } } as never
    return { value: { ...ok, exitCode: 1 } } as never
  })
}
const buildLedger = (files: Map<string, string>) => JSON.parse(files.get(`${DIR}/ledgers/p1.json`)!) as { tasks: Array<{ n: number; title: string; status: string; dispatches: Array<Record<string, unknown>> }>; resume: Record<string, unknown>; attribution?: string }

test('plan without a file answers the format; an unsound plan answers the problems; nothing is written', async ($, on) => {
  const { files, writes } = world(on, BUILD_SEED)
  const none = text(await call($, { action: 'plan', item: 'p1' }))
  expect(none).toMatch(/^refused: no plan at docs\/pipeline\/plans\/p1\.md; write it in this format/)
  expect(none).toContain('### Task 1: <title>')
  files.set(`${WT}/docs/pipeline/plans/p1.md`, '# p1\n\n### Task 1: A\n\n### Task 3: B\n- Files: b.ts\n')
  const bad = text(await call($, { action: 'plan', item: 'p1' }))
  expect(bad).toContain('- task 1 has no `- Files:` line')
  expect(bad).toContain('- task 3 is at position 2')
  expect(writes).toEqual([])
})

test('plan seeds the tasks and the resume block from the worktree plan and sets the item building', async ($, on) => {
  const { files } = world(on, { ...BUILD_SEED, [`${WT}/docs/pipeline/plans/p1.md`]: PLAN_MD })
  expect(text(await call($, { action: 'plan', item: 'p1', attribution: 'Co-Authored-By: X' }))).toBe('p1 · building · 2 tasks · task 1/2 · Agent subagent_type pipeline:implementer model sonnet effort medium · prompt: Read docs/pipeline/ledgers/p1/task-1-brief.md and follow it.')
  const l = buildLedger(files)
  expect(l.tasks.map(t => [t.n, t.title, t.status, t.dispatches.length])).toEqual([[1, 'Schema', 'running', 1], [2, 'Route', 'pending', 0]])
  expect(l.resume).toMatchObject({ task: 1, state: 'implementer dispatched', lastVerified: 'a1b2c3d' })
  expect(l.attribution).toBe('Co-Authored-By: X')
  expect(items(files)[0]).toMatchObject({ status: 'building', plan: 'docs/pipeline/plans/p1.md' })
  // A second call after a task was accepted keeps the record and moves on.
  await call($, { action: 'ledger', item: 'p1', set: { tasks: [{ n: 1, status: 'accepted', commits: 'a..b' }] } })
  expect(text(await call($, { action: 'plan', item: 'p1' }))).toBe('p1 · building · 2 tasks · next: brief task 2')
  expect(buildLedger(files).tasks[0]).toMatchObject({ status: 'accepted', commits: 'a..b' })
})

test('brief renders into the worktree, opens the dispatch and answers the Agent call; close ends it', async ($, on) => {
  const { files } = world(on, { ...BUILD_SEED, [`${WT}/docs/pipeline/plans/p1.md`]: PLAN_MD })
  diffWorld(on, ['src/route.ts'])
  await call($, { action: 'plan', item: 'p1', attribution: 'Co-Authored-By: X' })
  expect(text(await call($, { action: 'brief', item: 'p1', kind: 'implementer', task: 1 }))).toBe('p1 · task 1/2 · Agent subagent_type pipeline:implementer model sonnet effort medium · prompt: Read docs/pipeline/ledgers/p1/task-1-brief.md and follow it.')
  const brief = files.get(`${WT}/docs/pipeline/ledgers/p1/task-1-brief.md`)!
  expect(brief).toContain('# p1 · task 1 of 2: Schema')
  expect(brief).toContain('1. No raw SQL.')
  expect(brief).toContain('`npm test -- job` once')
  expect(brief).toContain('Co-Authored-By: X')
  expect(brief).not.toMatch(/\{\{/)
  let l = buildLedger(files)
  expect(l.tasks[0]).toMatchObject({ status: 'running', dispatches: [{ role: 'implementer', model: 'sonnet', effort: 'medium', result: '', brief: 'docs/pipeline/ledgers/p1/task-1-brief.md', report: 'docs/pipeline/ledgers/p1/task-1-report.md' }] })
  expect(l.resume).toMatchObject({ task: 1, state: 'implementer dispatched', lastVerified: 'a1b2c3d' })
  expect(text(await call($, { action: 'ledger', item: 'p1', set: { tasks: [{ n: 1, close: { tokens: 120000, minutes: 9, result: 'fix round 1' } }] } }))).toContain('120k tokens')
  // Fix rounds count themselves from the briefs on disk.
  expect(text(await call($, { action: 'brief', item: 'p1', kind: 'fix', task: 1 }))).toBe('refused: a fix brief needs findings')
  expect(text(await call($, { action: 'brief', item: 'p1', kind: 'fix', task: 1, findings: '- src/job.ts:4 · no filter' }))).toBe('p1 · task 1/2 · fix round 1 of 3 · Agent subagent_type pipeline:implementer model sonnet effort medium · prompt: Read docs/pipeline/ledgers/p1/task-1-fix-1-brief.md and follow it.')
  expect(text(await call($, { action: 'brief', item: 'p1', kind: 'fix', task: 1, findings: 'again', escalate: true }))).toBe('p1 · task 1/2 · fix round 2 of 3 · Agent subagent_type pipeline:implementer model opus effort high · prompt: Read docs/pipeline/ledgers/p1/task-1-fix-2-brief.md and follow it.')
  l = buildLedger(files)
  expect(l.tasks[0]!.status).toBe('fix')
  expect(l.tasks[0]!.dispatches.map((d: Record<string, unknown>) => d['role'])).toEqual(['implementer', 'implementer', 'escalate'])
  expect(l.resume['state']).toBe('fix round 2 dispatched')
  expect(text(await call($, { action: 'brief', item: 'p1', kind: 'implementer', task: 7 }))).toBe('refused: brief needs task: 1 to 2')
})

test('a review brief is rendered only when the config asks for it; a re-review and the final review', async ($, on) => {
  const { files } = world(on, { ...BUILD_SEED, [`${WT}/docs/pipeline/plans/p1.md`]: PLAN_MD })
  diffWorld(on, ['src/route.ts'])
  await call($, { action: 'plan', item: 'p1' })
  expect(text(await call($, { action: 'brief', item: 'p1', kind: 'review', task: 2 }))).toBe('refused: a review brief needs commits, as <sha>..<sha>')
  expect(text(await call($, { action: 'brief', item: 'p1', kind: 'review', task: 2, commits: 'a..b' }))).toBe('no review: a..b touches no risky path · accept task 2 with review.kind lead-diff')
  expect(files.has(`${WT}/docs/pipeline/ledgers/p1/task-2-review-brief.md`)).toBe(false)
  // The final review: the acceptance list, the base from the ledger and the head from git.
  expect(text(await call($, { action: 'brief', item: 'p1', kind: 'final' }))).toBe('p1 · final review · Agent subagent_type pipeline:reviewer model opus effort xhigh · prompt: Read docs/pipeline/ledgers/p1/final-brief.md and follow it.')
  const final = files.get(`${WT}/docs/pipeline/ledgers/p1/final-brief.md`)!
  expect(final).toContain('`git diff a1b2c3d..f00d123`')
  expect(final).toContain('- [ ] A CSV downloads.')
  expect(buildLedger(files).resume['state']).toBe('final review dispatched')
  expect(text(await call($, { action: 'brief', item: 'p1', kind: 'final' }))).toMatch(/^refused: docs\/pipeline\/ledgers\/p1\/final-brief\.md exists/)
  expect(text(await call($, { action: 'brief', item: 'p1', kind: 'final', findings: 'the fix wave of task 1' }))).toContain('final-review-2-brief.md')
})

test('a risky diff gets its review with the matched path; a project template replaces the built-in one', async ($, on) => {
  const { files } = world(on, { ...BUILD_SEED, [`${WT}/docs/pipeline/plans/p1.md`]: PLAN_MD, [`${DIR}/templates/review.md`]: 'OWN {{item}} {{commits}} {{risky}}' })
  diffWorld(on, ['db/schema.sql', 'src/job.ts'])
  await call($, { action: 'plan', item: 'p1' })
  expect(text(await call($, { action: 'brief', item: 'p1', kind: 'review', task: 1, commits: 'a..b' }))).toBe('p1 · task 1/2 · review · Agent subagent_type pipeline:reviewer model opus effort high · prompt: Read docs/pipeline/ledgers/p1/task-1-review-brief.md and follow it.')
  expect(files.get(`${WT}/docs/pipeline/ledgers/p1/task-1-review-brief.md`)).toBe('OWN p1 a..b db/schema.sql')
  expect(buildLedger(files).tasks[0]!.dispatches.at(-1)).toMatchObject({ role: 'reviewer', risky: 'db/schema.sql' })
  expect(text(await call($, { action: 'brief', item: 'p1', kind: 'review', task: 1, commits: 'b..c', findings: 'the fix commit' }))).toContain('task 1/2 · review 2 ·')
})

test('several sessions on one repository: the active item is the one this session works on, not the first in the backlog', async ($, on) => {
  const { state } = world(on, {
    [CONFIG]: VALID_CONFIG,
    [BACKLOG]: JSON.stringify({ version: 1, items: [{ id: 'p1', title: 'Sections', status: 'building' }, { id: 'p2', title: 'Themes', status: 'ready' }] }),
    [`${DIR}/specs/p2.md`]: '## What\n\nx\n',
  })
  const active = async () => (JSON.parse(text(await call($, { action: 'get' }))) as { active: { id: string } | null }).active?.id
  // Nothing says whose p1 is: the first active item, as before.
  expect(await active()).toBe('p1')
  // This session starts p2: p2 is its item from then on, in get and in its live entry.
  await call($, { action: 'update', id: 'p2', set: { status: 'planning' } })
  expect(await active()).toBe('p2')
  await call($, { action: 'ledger', item: 'p2', set: { resume: { task: 1, state: 'planned' } } })
  const got = JSON.parse(text(await call($, { action: 'get' }))) as { active: { id: string }; resume: { state: string } }
  expect(got.active.id).toBe('p2')
  expect(got.resume.state).toBe('planned')
  expect(text(await call($, { action: 'status' }))).toContain('p1')
  void state
})

// ---------- 0.3.1: the tool does the git chores and runs the gate ----------

/** A git and a shell that answer by subcommand; records every argv. */
function choreWorld(on: On, opts: { gate?: number; head?: string[]; push?: number } = {}) {
  const runs: string[][] = []
  const heads = [...(opts.head ?? ['c0de111'])]
  on('process.run', (_$, e) => {
    const argv = [...(e as { argv: readonly string[] }).argv]
    runs.push(argv)
    const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    const sub = argv[0] === 'git' && argv[1] === '-C' ? argv[3] : argv[1]
    if (sub === 'rev-parse' && argv.includes('--verify')) return { value: { ...ok, stdout: 'aaa\n' } } as never
    if (sub === 'rev-parse' && argv.at(-1) === 'HEAD') return { value: { ...ok, stdout: `${heads.length > 1 ? heads.shift() : heads[0]}\n` } } as never
    if (sub === 'rev-parse') return { value: { ...ok, stdout: `${argv.at(-1)}\n` } } as never
    if (sub === 'merge-base') return { value: { ...ok, stdout: 'ba5e000111222\n' } } as never
    if (sub === 'push') return { value: { ...ok, exitCode: opts.push ?? 0 } } as never
    if (sub === 'diff') return { value: { ...ok, stdout: 'src/route.ts\n' } } as never
    return { value: ok } as never
  })
  // The gate runs through spawn, which has no time limit of the host's.
  on('process.spawn', async function* (_$, e) {
    runs.push([...(e as unknown as { argv: readonly string[] }).argv])
    yield { stream: 'stdout', text: opts.gate ? 'not ok 3 - clamp\n# fail 1\n' : '# pass 4\n' } as never
    return { value: { code: opts.gate ?? 0, signal: null } } as never
  })
  return runs
}
const READY_SEED = { ...BUILD_SEED, [BACKLOG]: JSON.stringify({ version: 1, items: [{ id: 'p1', title: 'CSV export', status: 'ready', spec: 'docs/pipeline/specs/p1.md' }] }) }
delete (READY_SEED as Record<string, string>)[`${DIR}/ledgers/p1.json`]

test('begin claims a ready item: the worktree on the item branch off origin/main, the base, planning, and the worktree to enter', async ($, on) => {
  const { files } = world(on, READY_SEED)
  const runs = choreWorld(on)
  const line = text(await call($, { action: 'begin', item: 'p1' }))
  expect(line).toBe(`p1 · planning · branch feat/p1 · base ba5e000 · EnterWorktree { "path": "${WT}" } · next: read docs/pipeline/specs/p1.md, write docs/pipeline/plans/p1.md, then plan`)
  expect(runs).toContainEqual(['git', 'worktree', 'add', WT, '-b', 'feat/p1', 'origin/main'])
  expect(buildLedger(files)).toMatchObject({ branch: 'feat/p1', worktree: '.claude/worktrees/p1', base: 'ba5e00011122' })
  expect(items(files)[0]).toMatchObject({ status: 'planning', branch: 'feat/p1' })
  expect(JSON.parse(text(await call($, { action: 'get' }))).active.id).toBe('p1')
  // An inbox item is not begun.
  await call($, { action: 'add', item: { title: 'No spec yet' } })
  expect(text(await call($, { action: 'begin', item: 'p2' }))).toBe('refused: p2 is inbox: no spec, not ready')
})

test('begin refuses an item another live session runs', async ($, on) => {
  const live = { sessions: { other: { title: 'p1 · CSV export', cwd: '/p/elsewhere', item: 'p1', startedAt: new Date(NOW - 60_000).toISOString(), seenAt: new Date(NOW - 5_000).toISOString(), agents: [], signals: [] } } }
  world(on, { ...BUILD_SEED, [BACKLOG]: JSON.stringify({ version: 1, items: [{ id: 'p1', title: 'CSV export', status: 'building', ledger: 'docs/pipeline/ledgers/p1.json' }] }), [`${MAIN}/.git/pipeline-live.json`]: JSON.stringify(live) })
  choreWorld(on)
  await start($ as never)
  expect(text(await call($, { action: 'begin', item: 'p1' }))).toBe('refused: p1 is run by another session (p1 · CSV export); pick the next item')
})

test('plan commits the plan; accept closes the dispatch, records the range, commits the records, pushes and names what is next', async ($, on) => {
  const { files } = world(on, { ...BUILD_SEED, [`${WT}/docs/pipeline/plans/p1.md`]: PLAN_MD })
  const runs = choreWorld(on, { head: ['c0de111', 'rec0222'] })
  expect(text(await call($, { action: 'plan', item: 'p1', attribution: 'Co-Authored-By: X' }))).toBe('p1 · building · 2 tasks · plan committed · task 1/2 · Agent subagent_type pipeline:implementer model sonnet effort medium · prompt: Read docs/pipeline/ledgers/p1/task-1-brief.md and follow it.')
  expect(runs).toContainEqual(['git', '-C', WT, 'commit', '-q', '-m', 'p1: plan', '-m', 'Co-Authored-By: X', '--', 'docs/pipeline/plans/p1.md'])
  await call($, { action: 'brief', item: 'p1', kind: 'implementer', task: 1 })
  expect(text(await call($, { action: 'accept', item: 'p1', task: 1, tokens: 42000, minutes: 3 }))).toBe('p1 · task 1 accepted · 1/2 · a1b2c3d..c0de111 · pushed · task 2/2 · Agent subagent_type pipeline:implementer model sonnet effort medium · prompt: Read docs/pipeline/ledgers/p1/task-2-brief.md and follow it.')
  const l = buildLedger(files)
  expect(l.tasks[0]).toMatchObject({ status: 'accepted', commits: 'a1b2c3d..c0de111', review: { kind: 'lead-diff', verdict: 'approved' }, dispatches: [{ tokens: 42000, minutes: 3, result: 'done' }] })
  // The answer already opened task 2's dispatch.
  expect(l.resume).toMatchObject({ task: 2, state: 'implementer dispatched', lastVerified: 'rec0222' })
  expect(runs).toContainEqual(['git', '-C', WT, 'commit', '-q', '-m', 'p1: task 1 record', '-m', 'Co-Authored-By: X', '--', 'docs/pipeline/ledgers/p1'])
  expect(runs).toContainEqual(['git', '-C', WT, 'push', '-q', '-u', 'origin', 'feat/p1'])
  expect(text(await call($, { action: 'accept', item: 'p1', task: 9 }))).toBe('refused: accept needs task: 1 to 2')
})

test('accept asks for the review the config wants: a risky diff is refused until a reviewer was dispatched', async ($, on) => {
  const { files } = world(on, { ...BUILD_SEED, [`${WT}/docs/pipeline/plans/p1.md`]: PLAN_MD })
  files.set(CONFIG, files.get(CONFIG)!.replace('"db/**"', '"src/**"'))
  choreWorld(on)
  await call($, { action: 'plan', item: 'p1' })
  await call($, { action: 'brief', item: 'p1', kind: 'implementer', task: 1 })
  expect(text(await call($, { action: 'accept', item: 'p1', task: 1 }))).toBe('refused: review first: task 1 touches src/route.ts · brief { kind: "review", task: 1, commits: "a1b2c3d..c0de111", close: { tokens, minutes, result } }, then accept')
  await call($, { action: 'brief', item: 'p1', kind: 'review', task: 1, commits: 'a1b2c3d..c0de111', close: { tokens: 9000, minutes: 2, result: 'done' } })
  expect(text(await call($, { action: 'accept', item: 'p1', task: 1, tokens: 5000, minutes: 1 }))).toContain('p1 · task 1 accepted · 1/2')
  expect(buildLedger(files).tasks[0]).toMatchObject({ review: { kind: 'independent' }, dispatches: [{ role: 'implementer', tokens: 9000 }, { role: 'reviewer', tokens: 5000 }] })
})

test('accept refuses a task with no commit, and says so when the push fails', async ($, on) => {
  world(on, { ...BUILD_SEED, [`${WT}/docs/pipeline/plans/p1.md`]: PLAN_MD })
  choreWorld(on, { head: ['a1b2c3d'], push: 1 })
  await call($, { action: 'plan', item: 'p1' })
  expect(text(await call($, { action: 'accept', item: 'p1', task: 1 }))).toBe('refused: task 1 has no commit after a1b2c3d: nothing to accept')
})

test('gate runs checks.gate in the worktree and records what happened: green pushes, red answers the tail', async ($, on) => {
  const { files } = world(on, { ...BUILD_SEED, [`${WT}/docs/pipeline/plans/p1.md`]: PLAN_MD })
  const runs = choreWorld(on)
  await call($, { action: 'plan', item: 'p1' })
  expect(text(await call($, { action: 'gate', item: 'p1', verdict: 'approved', tokens: 39000 }))).toBe('p1 · gate green · final approved · pushed · next: open the PR')
  expect(runs).toContainEqual(['sh', '-c', 'npm run gate'])
  expect(JSON.parse(files.get(`${DIR}/ledgers/p1.json`)!).final).toEqual({ verdict: 'approved', gate: 'green', tokens: 39000 })
})

test('a red gate is recorded red with the output tail and nothing is pushed', async ($, on) => {
  const { files } = world(on, { ...BUILD_SEED, [`${WT}/docs/pipeline/plans/p1.md`]: PLAN_MD })
  const runs = choreWorld(on, { gate: 1 })
  await call($, { action: 'plan', item: 'p1' })
  const before = runs.filter(r => r.includes('push')).length
  expect(text(await call($, { action: 'gate', item: 'p1', verdict: 'approved' }))).toBe('p1 · gate red (exit 1) · `npm run gate`\nnot ok 3 - clamp\n# fail 1')
  expect(JSON.parse(files.get(`${DIR}/ledgers/p1.json`)!).final.gate).toBe('red (exit 1)')
  expect(runs.filter(r => r.includes('push')).length).toBe(before)
})

test('superpowers off (the default) tells every brief to invoke no skill; on allows the discipline skills', async ($, on) => {
  const { files } = world(on, { ...BUILD_SEED, [`${WT}/docs/pipeline/plans/p1.md`]: PLAN_MD })
  choreWorld(on)
  await call($, { action: 'plan', item: 'p1' })
  await call($, { action: 'brief', item: 'p1', kind: 'implementer', task: 1 })
  expect(files.get(`${WT}/docs/pipeline/ledgers/p1/task-1-brief.md`)).toContain('invoke no skill (no superpowers skill')
  expect(JSON.parse(text(await call($, { action: 'get' }))).config.superpowers).toBe('off')
  files.set(CONFIG, files.get(CONFIG)!.replace('"merge"', '"superpowers": "on", "merge"'))
  await call($, { action: 'brief', item: 'p1', kind: 'implementer', task: 2 })
  expect(files.get(`${WT}/docs/pipeline/ledgers/p1/task-2-brief.md`)).toContain('may be used inside a step')
})

test('0.3.2: a fact given at accept is kept in facts.md, once, and reaches the next brief', async ($, on) => {
  const { files } = world(on, { ...BUILD_SEED, [`${WT}/docs/pipeline/plans/p1.md`]: PLAN_MD })
  choreWorld(on, { head: ['c0de111', 'rec0222'] })
  await call($, { action: 'plan', item: 'p1' })
  expect(files.get(`${WT}/docs/pipeline/ledgers/p1/task-1-brief.md`)).toContain('Known about working in this repository:\nnone yet')
  await call($, { action: 'accept', item: 'p1', task: 1, fact: 'run   npm ci in the worktree before the first test' })
  expect(files.get(`${DIR}/facts.md`)).toContain('- run npm ci in the worktree before the first test\n')
  // The answer rendered task 2's brief, with the fact in it.
  expect(files.get(`${WT}/docs/pipeline/ledgers/p1/task-2-brief.md`)).toContain('- run npm ci in the worktree before the first test')
})

test('0.3.2: a brief names its report by the full path in the worktree', async ($, on) => {
  const { files } = world(on, { ...BUILD_SEED, [`${WT}/docs/pipeline/plans/p1.md`]: PLAN_MD })
  choreWorld(on)
  await call($, { action: 'plan', item: 'p1' })
  expect(files.get(`${WT}/docs/pipeline/ledgers/p1/task-1-brief.md`)).toContain(`\`${WT}/docs/pipeline/ledgers/p1/task-1-report.md\``)
})
