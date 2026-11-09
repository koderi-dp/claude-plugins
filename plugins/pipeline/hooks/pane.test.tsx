import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { BLOCKED, DONE, OVERVIEW_ROWS, ROWS_SHOWN, RUNNING } from './pane'
import { bandSvg, bandText } from './draw'
import { BAND_COLORS, SEGMENT_COLORS, bandOf } from './status'

const MAIN = '/p/main'
const DIR = `${MAIN}/docs/pipeline`
const CONFIG = `${DIR}/config.json`
const BACKLOG = `${DIR}/backlog.json`
const HEAD = `${MAIN}/.git/HEAD`
const NOW = Date.parse('2026-11-05T10:00:00Z')
const MIN = 60_000
const TOOL = 'mcp__pipeline__pipeline'
const PANE = { title: 'Pipeline', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const BAND: { hasSurvey: boolean; isWorking: boolean; maxRows: number; bodyColumns: number } = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 }

const VALID_CONFIG = JSON.stringify({ version: 1, mainBranch: 'main', branch: 'feat/<id>', checks: {}, merge: 'pr', notify: 'off' }, null, 2) + '\n'

type Engine = {
  session: { start: (e: never) => Promise<unknown> }
  agent: { spawn: (e: never) => Promise<unknown> }
  turn: { complete: unknown }
  ui: { mount: (e: never) => Promise<Mounted> }
  command: { run: (e: never) => Promise<unknown> }
  tool: { call: (e: never) => Promise<unknown> }
}
type Found = { type: string; key?: string; props: Record<string, unknown>; text: string } | undefined
type Mounted = {
  find: (q: Record<string, unknown>) => Promise<Found>
  findAll: (q: Record<string, unknown>) => Promise<NonNullable<Found>[]>
  press: (t: Record<string, unknown>) => Promise<unknown>
  input: (t: Record<string, unknown>) => Promise<unknown>
  unmount: () => Promise<void>
}

/** A main checkout at /p/main on branch main, files in memory, a surface that records which panes are open, an engine that draws "engine" beneath. */
function world(on: On, seed: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, string>([[HEAD, 'ref: refs/heads/main\n'], ...Object.entries(seed)])
  const panes: string[] = []
  const opened: string[] = []
  const toasts: string[] = []
  const key = (p: string) => p.split(String.fromCharCode(92)).join('/')
  on('fs.exists', (_$, e) => ({ value: files.has(key(e.path)) }))
  on('fs.read', (_$, e) => {
    const t = files.get(key(e.path))
    return t === undefined ? { deny: `ENOENT: ${e.path}` } : { value: t }
  })
  on('fs.write', (_$, e) => {
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    if (!panes.includes(e.id)) panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    panes.splice(panes.indexOf(e.id), 1)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as { text?: string }).text ?? (e as { message?: string }).message ?? ''))
    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: panes.map(id => ({ id, title: 'Pipeline', isPlaced: true })) }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('session.repo', () => ({ value: { root: MAIN, remote: null, internal: false, name: null } }) as never)
  on('session.root', () => ({ value: MAIN }))
  on('session.cwd', () => ({ value: MAIN }))
  on('session.id', () => ({ value: 'self' }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: e.name } }))
  on('tool.list', () => ({ value: [] }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('agent.spawn', (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  on('turn.complete', () => ({ text: '' }) as never)
  return { clock, files, panes, opened, toasts }
}

const start = ($: Engine) => $.session.start({ cwd: MAIN, surface: 'terminal', isInteractive: true } as never)
const spawn = ($: Engine, description: string, n = 1) =>
  $.agent.spawn({ tool_use_id: `t${n}`, prompt: 'p', description, subagentType: 'general-purpose', provider: 'engine', parentModel: 'claude-x', background: false, fork: false } as never)
const complete = ($: Engine, e: Record<string, unknown>) => ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'ok', ...e })
const mount = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal', bodyColumns = 60) => $.ui.mount({ plugin: 'pipeline', surface, component: 'Pane', requestId: 'pipeline', props: { ...PANE, bodyColumns } } as never)
const band = ($: Engine, surface: 'terminal' | 'desktop', props: Partial<typeof BAND> = {}) => $.ui.mount({ plugin: 'pipeline', surface, component: 'AbovePrompt', props: { ...BAND, ...props } } as never)
const run = async ($: Engine, args: string) => ((await $.command.run({ command: 'pipeline', args, origin: { kind: 'composer' } } as never)) as { text?: string }).text ?? ''
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: TOOL, tool_use_id: 'tc', ...input } as never)

const item = (id: string, title: string, status: string, extra: Record<string, unknown> = {}) => ({ id, title, status, size: 'M', updatedAt: '2026-11-05T09:00:00Z', ...extra })
const backlogOf = (items: Record<string, unknown>[]) => JSON.stringify({ version: 1, items }, null, 2) + '\n'

const QUEUE = backlogOf([
  item('p1', 'Login', 'merged', { pr: '#3' }),
  item('p2', 'Export', 'building', { spec: 'docs/pipeline/specs/p2.md' }),
  item('p3', 'Search', 'ready'),
  item('p4', 'Import', 'blocked', { note: 'CI red after one fix' }),
  item('p5', 'Billing', 'inbox'),
  item('p6', 'Old', 'merged', { pr: '#1', updatedAt: '2026-10-01T09:00:00Z' }),
  item('p7', 'Later', 'parked'),
])
const LEDGER =
  JSON.stringify(
    {
      item: 'p2',
      tasks: [
        { n: 1, title: 'The parser', status: 'accepted', dispatches: [] },
        { n: 2, title: 'The writer', status: 'running', dispatches: [{ role: 'implementer', model: 'claude-sonnet-5-5', effort: 'medium', tokens: 0, minutes: 0, result: '' }] },
        { n: 3, title: 'The command', status: 'pending', dispatches: [] },
      ],
      rulings: [],
      blockers: [],
      tokens: 0,
      resume: { task: 2, state: 'task 1 accepted', at: '2026-11-05T09:30:00Z' },
    },
    null,
    2,
  ) + '\n'
const SPEC = '# p2 Export\n\nStatus: draft\n\n## What\n\nA CSV export of every catalog, streamed to the browser.\n\n## Why\n\nAsked.\n'
const SEED = { [CONFIG]: VALID_CONFIG, [BACKLOG]: QUEUE, [`${DIR}/ledgers/p2.json`]: LEDGER, [`${DIR}/specs/p2.md`]: SPEC }

/** 28 inbox items without specs, nothing ready, five merged this week with PR URLs and two older ones. */
const IDLE = backlogOf([
  ...Array.from({ length: 28 }, (_, i) => item(`p${i + 1}`, i === 0 ? 'grid-track-sizes — Grid row and column sizes' : `Inbox item ${i + 1}`, 'inbox')),
  ...Array.from({ length: 5 }, (_, i) => item(`m${i + 1}`, `Merged item ${i + 1}`, 'merged', { pr: `https://x/pull/${30 + i}`, updatedAt: `2026-11-0${4 - (i % 3)}T0${i}:00:00Z` })),
  ...Array.from({ length: 2 }, (_, i) => item(`o${i + 1}`, `Older ${i + 1}`, 'merged', { pr: `https://x/pull/${10 + i}`, updatedAt: '2026-10-01T00:00:00Z' })),
])

const alts = async (ui: Mounted) => (await ui.findAll({ type: 'Svg' })).map(s => String(s.props['alt']))
const svgOf = async (ui: Mounted, alt: RegExp) => String((await ui.findAll({ type: 'Svg' })).find(s => alt.test(String(s.props['alt'])))?.props['source'])
/** The drawn item rows (`p1: title · meta · tag`) by their alt. */
const rowAlts = async (ui: Mounted) => (await alts(ui)).filter(a => /^[a-z]\d+: /.test(a))

// ---------- the text block ----------

test('terminal: the view name, every section with its colour, the active item with its task counter, agents and signals, no Svg', async ($, on) => {
  const { clock } = world(on, SEED)
  await start($ as never)
  await spawn($ as never, 'Implement task 2', 1)
  await spawn($ as never, 'Review task 1', 2)
  await clock.advance(5 * MIN)
  await complete($ as never, { agentId: 'agent-t2', reason: 'error' })
  const ui = await mount($ as never, 'terminal')
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect(await ui.findAll({ type: 'Input' })).toHaveLength(0)
  expect((await ui.find({ type: 'Text', text: /^Pipeline · / }))?.text).toBe('Pipeline · Overview')
  expect((await ui.find({ type: 'Text', text: /7 items · 1 ready/ }))?.text).toBe('pipeline: 7 items · 1 ready')
  const active = await ui.find({ type: 'Text', text: /p2 · Export/ })
  expect(active?.text).toBe('p2 · Export · M · building · task 2/3 · task 1 accepted')
  expect(active?.props['color']).toBe(RUNNING)
  const running = await ui.find({ type: 'Text', text: /Implement task 2/ })
  expect(running?.text).toContain('5 min')
  expect(running?.props['color']).toBe(RUNNING)
  const failed = await ui.find({ type: 'Text', text: /Review task 1/ })
  expect(failed?.text).toContain('failed')
  expect(failed?.props['color']).toBe(BLOCKED)
  expect((await ui.find({ type: 'Text', text: /p3 · Search/ }))?.props['color']).toBeUndefined()
  const blocked = await ui.find({ type: 'Text', text: /p4 · Import/ })
  expect(blocked?.text).toBe('p4 · Import · M · CI red after one fix')
  expect(blocked?.props['color']).toBe(BLOCKED)
  expect((await ui.find({ type: 'Text', text: /p5 · Billing/ }))?.text).toContain('no spec')
  expect(await ui.find({ type: 'Text', text: /Parked: p7/ })).toBeDefined()
  const merged = await ui.find({ type: 'Text', text: /p1 · Login/ })
  expect(merged?.text).toBe('p1 · Login · M · #3')
  expect(merged?.props['color']).toBe(DONE)
  expect(await ui.find({ type: 'Text', text: /p6 · Old/ })).toBeUndefined()
  expect(await ui.find({ key: 'more' })).toBeUndefined()
  // A silent agent past silentMinutes: the signal row in the blocked colour.
  await clock.advance(11 * MIN)
  const signal = await ui.find({ type: 'Text', text: /^silent:/ })
  expect(signal?.text).toContain('Implement task 2')
  expect(signal?.props['color']).toBe(BLOCKED)
  await ui.unmount()
})

test('terminal: a queue section folds past eight rows and Show more unfolds every section', async ($, on) => {
  const many = Array.from({ length: 12 }, (_, i) => item(`p${i + 1}`, `Ready ${i + 1}`, 'ready'))
  const inbox = Array.from({ length: 10 }, (_, i) => item(`i${i + 1}`, `Inbox ${i + 1}`, 'inbox'))
  world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: backlogOf([...many, ...inbox]) })
  await start($ as never)
  const ui = await mount($ as never)
  expect(await ui.find({ type: 'Text', text: /Ready 8 · M/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Ready 9 · M/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Inbox 9/ })).toBeUndefined()
  expect((await ui.find({ key: 'more' }))?.props['label']).toBe(`Show more (${12 - ROWS_SHOWN + 10 - ROWS_SHOWN} hidden)`)
  await ui.press({ key: 'more' })
  expect(await ui.find({ type: 'Text', text: /Ready 12 · M/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Inbox 10/ })).toBeDefined()
  expect((await ui.find({ key: 'more' }))?.props['label']).toBe('Show fewer')
  await ui.press({ key: 'more' })
  expect(await ui.find({ type: 'Text', text: /Ready 9 · M/ })).toBeUndefined()
  await ui.unmount()
})

test('terminal: the text block keeps every reason and the parked ids, with the slug dropped and the PR as its number', async ($, on) => {
  world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: IDLE })
  await start($ as never)
  const ui = await mount($ as never, 'terminal')
  expect((await ui.find({ type: 'Text', text: /^p1 · / }))?.text).toBe('p1 · Grid row and column sizes · M · no spec')
  expect((await ui.find({ type: 'Text', text: /^p2 · / }))?.text).toBe('p2 · Inbox item 2 · M · no spec')
  expect((await ui.find({ type: 'Link' }))?.props['href']).toBe('https://x/pull/33')
  expect(await ui.find({ type: 'Text', text: /^o1 · / })).toBeUndefined()
  await ui.unmount()
})

test('without a config the panel says so', async ($, on) => {
  world(on)
  await start($ as never)
  const ui = await mount($ as never)
  expect(await ui.find({ type: 'Text', text: 'pipeline: no config (run /pipeline init)' })).toBeDefined()
  await ui.unmount()
})

test('a file error is drawn in the blocked colour', async ($, on) => {
  world(on, { [CONFIG]: '{\n  "version": 1,\n  merge: "pr"\n}\n' })
  await start($ as never)
  const ui = await mount($ as never)
  const row = await ui.find({ type: 'Text', text: /^pipeline: docs\/pipeline\/config\.json: line \d+: / })
  expect(row).toBeDefined()
  expect(row?.props['color']).toBe(BLOCKED)
  await ui.unmount()
})

test('/pipeline panel toggles the pane; the first agent opens it once', async ($, on) => {
  const { panes, opened } = world(on, SEED)
  await start($ as never)
  expect(panes).toEqual([])
  expect(await run($ as never, 'panel')).toBe('Pipeline panel opened.')
  expect(panes).toEqual(['pipeline'])
  expect(await run($ as never, 'panel')).toBe('Pipeline panel closed.')
  expect(panes).toEqual([])
  await spawn($ as never, 'Implement task 2', 1)
  expect(panes).toEqual(['pipeline'])
  await run($ as never, 'panel')
  expect(panes).toEqual([])
  await spawn($ as never, 'Implement task 3', 2)
  expect(panes).toEqual([])
  expect(opened).toEqual(['pipeline', 'pipeline'])
})

// ---------- Overview ----------

test('desktop idle Overview: the hero says nothing runs and why, three metrics, three rows to specify, two merged, no grid, no cost tiles', async ($, on) => {
  world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: IDLE })
  await start($ as never)
  const ui = await mount($ as never, 'desktop')
  // The header and the tabs.
  expect(await ui.find({ type: 'Text', text: 'Pipeline' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'main · main' })).toBeDefined()
  expect((await ui.find({ key: 'tab-overview' }))?.props['dimColor']).toBe(false)
  expect((await ui.find({ key: 'tab-queue' }))?.props['label']).toBe('Queue · 28')
  expect((await ui.find({ key: 'tab-history' }))?.props['label']).toBe('History')
  // The hero.
  const a = await alts(ui)
  expect(a.some(t => t === 'dotted grid')).toBe(false)
  expect(a.some(t => t.includes('≈$'))).toBe(false)
  expect(a[0]).toBe('PIPELINE IDLE: Nothing running right now. There are 28 items in your inbox, but none are ready to build. Add specifications to move work into the queue.')
  const hero = await svgOf(ui, /^PIPELINE IDLE/)
  expect(hero).toContain('Nothing running right now')
  expect(hero).toContain('Awaiting ready work')
  expect(hero).toContain('0 active agents')
  // Three metrics in one drawing.
  expect(a[1]).toBe('28 Inbox, 0 Ready, 5 Merged this week')
  // Needs specification: three drawn rows (the mockup's .item-row), the slug dropped, the reason once as the amber tag,
  // each with a chevron Button beside it, then the count of the rest.
  expect(await ui.find({ type: 'Text', text: /^Needs specification/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Up next/ })).toBeUndefined()
  expect(a.slice(2, 5)).toEqual(['p1: Grid row and column sizes · M · Inbox · No spec', 'p2: Inbox item 2 · M · Inbox · No spec', 'p3: Inbox item 3 · M · Inbox · No spec'])
  expect(await rowAlts(ui)).toHaveLength(OVERVIEW_ROWS + 2)
  for (const id of ['p1', 'p2', 'p3']) expect((await ui.find({ key: `row-${id}` }))?.props['label']).toBe('›')
  expect(await ui.find({ key: 'row-p4' })).toBeUndefined()
  const row = await svgOf(ui, /^p1: /)
  expect(row).toContain('>p1<')
  expect(row).toContain('>Grid row and column sizes<')
  expect(row).not.toContain('grid-track-sizes')
  expect(row).toContain('>M · Inbox<')
  expect(row).toContain('>No spec<')
  expect(row).toContain(`fill="${BLOCKED}"`)
  expect(row).toContain('class="chip"')
  // A hairline under every row but the last of its card.
  expect(row).toContain('class="hair"')
  expect(await svgOf(ui, /^p3: /)).toContain('class="hair"')
  expect(await ui.find({ type: 'Text', text: 'and 25 more in the queue' })).toBeDefined()
  // Recently merged: two drawn rows (the mockup's .merged-row: check, id, title), newest first, with PR links beside them.
  expect(await ui.find({ type: 'Text', text: /^Recently merged/ })).toBeDefined()
  expect(a.slice(5)).toEqual(['m4: Merged item 4 · merged · #33', 'm1: Merged item 1 · merged · #30'])
  const links = await ui.findAll({ type: 'Link' })
  expect(links.map(l => l.props['href'])).toEqual(['https://x/pull/33', 'https://x/pull/30'])
  expect(links[0]!.text).toContain('#33 ↗')
  expect(links[0]!.text).not.toContain('PR ')
  const merged = await svgOf(ui, /^m4: /)
  expect(merged).toContain(`stroke="${DONE}"`)
  expect(merged).toContain('>m4<')
  expect(merged).toContain('>Merged item 4<')
  expect(merged).toContain('class="hair"')
  expect(await svgOf(ui, /^m1: /)).not.toContain('class="hair"')
  // The footer.
  expect(await ui.find({ type: 'Text', text: 'No subagents running' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '/pipeline status' })).toBeDefined()
  // The section buttons switch the tab.
  expect((await ui.find({ key: 'goto-queue' }))?.props['label']).toBe('View queue →')
  await ui.press({ key: 'goto-history' })
  expect((await ui.find({ key: 'tab-history' }))?.props['dimColor']).toBe(false)
  expect((await alts(ui))[0]).toBe('7 items merged: all time · 5 this week')
  await ui.press({ key: 'tab-overview' })
  expect((await alts(ui))[0]).toMatch(/^PIPELINE IDLE/)
  await ui.unmount()
})

test('desktop idle Overview with ready items: Up next lists them and the hero names /pipeline next', async ($, on) => {
  world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: backlogOf([item('p1', 'Search', 'ready'), item('p2', 'Billing', 'inbox')]) })
  await start($ as never)
  const ui = await mount($ as never, 'desktop')
  expect((await alts(ui))[0]).toContain('There are 1 item in your inbox and 1 is ready to build. Run /pipeline next to start the first.')
  expect(await ui.find({ type: 'Text', text: /^Up next/ })).toBeDefined()
  expect(await rowAlts(ui)).toEqual(['p1: Search · M · Ready'])
  const row = await svgOf(ui, /^p1: /)
  expect(row).toContain('>Search<')
  expect(row).toContain('>Ready<')
  expect(row).toContain(`fill="${DONE}"`)
  expect(await ui.find({ key: 'row-p1' })).toBeDefined()
  expect(await ui.find({ key: 'row-p2' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Nothing merged yet.' })).toBeDefined()
  // Pressing a row opens the Queue on that item.
  await ui.press({ key: 'row-p1' })
  expect((await ui.find({ key: 'tab-queue' }))?.props['dimColor']).toBe(false)
  expect((await ui.find({ key: 'filter-ready' }))?.props['dimColor']).toBe(false)
  expect(await ui.find({ type: 'Text', text: '/pipeline status p1' })).toBeDefined()
  await ui.unmount()
})

test('desktop running Overview: the hero with the item, progress and steps, the usage line, the agent card, the task timeline and Up next', async ($, on) => {
  const { clock } = world(on, SEED)
  await start($ as never)
  await spawn($ as never, 'Implement task 2', 1)
  await spawn($ as never, 'Review task 1', 2)
  await clock.advance(5 * MIN)
  await complete($ as never, { agentId: 'agent-t2', reason: 'error' })
  const ui = await mount($ as never, 'desktop')
  const a = await alts(ui)
  expect(a[0]).toBe('BUILDING · P2: Export, 1 of 3 tasks accepted')
  const hero = await svgOf(ui, /^BUILDING · P2/)
  expect(hero).toContain('A CSV export of every catalog, streamed to the browser.')
  expect(hero).toContain('1 of 3 tasks accepted')
  expect(hero).toContain('>33%<')
  expect(hero).toContain('✓ Plan')
  expect(hero).toContain('● Build')
  expect(hero).toContain('○ Review')
  expect(hero).toContain('○ Merge')
  expect(hero).toContain('class="live"')
  expect(a.some(t => t === 'dotted grid')).toBe(false)
  // The usage line.
  expect((await ui.find({ type: 'Text', text: /elapsed · / }))?.text).toMatch(/^5:00 elapsed · 0 tokens · ≈\$0\.00 cost$/)
  // One card for the running agent: its role, model and effort; the failed one as a line.
  expect(a[1]).toBe('Implementer: Sonnet 5.5 · medium, running, starting')
  const card = await svgOf(ui, /^Implementer/)
  expect(card).toContain('Sonnet 5.5 · medium')
  expect(card).toContain('5:00')
  expect(a).toHaveLength(3)
  expect(await ui.find({ type: 'Text', text: /^Active agent/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Task 2 / 3' })).toBeDefined()
  // The current task's trail comes from the ledger's dispatches; an agent of an earlier task (the failed review of task 1) is not listed here.
  expect((await ui.find({ type: 'Text', text: /^Build · / }))?.text).toBe('Build · Sonnet 5.5 · 0:00 ✓')
  expect(await ui.find({ type: 'Text', text: /Review task 1/ })).toBeUndefined()
  // The timeline from the ledger.
  const parser = await ui.find({ type: 'Text', text: /^✓ The parser/ })
  expect(parser?.props['color']).toBe(DONE)
  expect(parser?.text).toContain('Accepted')
  const writer = await ui.find({ type: 'Text', text: /^● The writer/ })
  expect(writer?.props['color']).toBe(RUNNING)
  expect(writer?.text).toContain('In progress')
  expect(await ui.find({ type: 'Text', text: '   Implementer · Sonnet 5.5 · 5:00' })).toBeDefined()
  const command = await ui.find({ type: 'Text', text: /^○ The command/ })
  expect(command?.props['dimColor']).toBe(true)
  // Up next: the first ready item.
  expect(await ui.find({ type: 'Text', text: /^Up next/ })).toBeDefined()
  expect(a[2]).toBe('p3: Search · M · Ready')
  expect(await ui.find({ key: 'row-p3' })).toBeDefined()
  expect(await ui.find({ key: 'row-p5' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '1 agent working · no signals' })).toBeDefined()
  // A silent agent: the signal row above the view, and the footer counts it.
  await clock.advance(11 * MIN)
  expect((await ui.find({ type: 'Text', text: /^silent:/ }))?.props['color']).toBe(BLOCKED)
  expect(await ui.find({ type: 'Text', text: '1 agent working · 1 open signal' })).toBeDefined()
  await ui.unmount()
})

test('desktop running Overview in a fix round: a Lead line instead of an empty agent section, the current task\'s attempt trail from the ledger, and the timeline\'s fix round line', async ($, on) => {
  const ledger = JSON.parse(LEDGER) as { tasks: Record<string, unknown>[]; resume: Record<string, unknown> }
  ledger.tasks[1] = {
    n: 2,
    title: 'The writer',
    status: 'fix',
    dispatches: [
      { role: 'implementer', model: 'claude-sonnet-5-5', effort: 'medium', tokens: 10, minutes: 3.3333, result: 'done' },
      { role: 'reviewer', model: 'claude-opus-5-5', effort: 'high', tokens: 20, minutes: 0.97, result: 'FIX REQUIRED: the empty case has no test' },
      { role: 'implementer', model: 'claude-sonnet-5-5', effort: 'medium', tokens: 5, minutes: 0.62, result: 'done' },
    ],
  }
  ledger.resume = { task: 2, state: 'fix round 1 dispatched', at: new Date(NOW - 130_000).toISOString() }
  world(on, { ...SEED, [`${DIR}/ledgers/p2.json`]: JSON.stringify(ledger) + '\n' })
  await start($ as never)
  const ui = await mount($ as never, 'desktop')
  // No agent runs: the Lead line, with what it does and since when; no "Active agent · 0 running", no "No subagent running."
  expect(await ui.find({ type: 'Text', text: /^Active agent/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'No subagent running.' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^Lead$|^Lead · / }))?.text).toBe('Lead')
  const lead = await ui.find({ type: 'Text', text: /^Lead · / })
  expect(lead?.text).toBe('Lead · fix round 1 dispatched · 2:10')
  expect(lead?.props['color']).toBe(RUNNING)
  expect(await ui.find({ type: 'Text', text: 'Task 2 / 3' })).toBeDefined()
  // The attempt trail of task 2 from its dispatches, in order; the review that required fixes in amber.
  const trail = (await ui.findAll({ type: 'Text', text: /^(Build|Review|Fix \d) / })).map(t => [t.text, t.props['color']])
  expect(trail).toEqual([
    ['Build · Sonnet 5.5 · 3:20 ✓', DONE],
    ['Review · Opus 5.5 · 0:58 · FIX REQUIRED', BLOCKED],
    ['Fix 1 of 3 · Sonnet 5.5 · 0:37 ✓', DONE],
  ])
  expect(await ui.find({ type: 'Text', text: /fix round 1 · / })).toBeUndefined()
  // The timeline: the current task reads Fix round, with the round, the limit and the verdict on its second line.
  const writer = await ui.find({ type: 'Text', text: /^● The writer/ })
  expect(writer?.text).toBe('● The writer  Fix round')
  expect(await ui.find({ type: 'Text', text: '   Fix round 1 of 3 · after review: FIX REQUIRED' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^   opus$/ })).toBeUndefined()
  await ui.unmount()
})

// ---------- Queue ----------

test('desktop Queue: the search narrows rows live, the filters switch groups with counts, a row expands to its note and the status command', async ($, on) => {
  world(on, SEED)
  await start($ as never)
  const ui = await mount($ as never, 'desktop')
  await ui.press({ key: 'tab-queue' })
  const input = await ui.find({ type: 'Input' })
  expect(input?.key).toBe('pipeline-search')
  expect(input?.props['placeholder']).toBe('Find an item by name or id…')
  // The field spans the row (the mockup's .search), with a short submit label beside it.
  expect(input?.props['submitLabel']).toBe('find')
  expect((await ui.find({ key: 'pipeline-search-box' }))?.props['width']).toBe(60)
  // The filters with their counts; Inbox is selected.
  expect((await ui.find({ key: 'filter-inbox' }))?.props['label']).toBe('Inbox · 1')
  expect((await ui.find({ key: 'filter-ready' }))?.props['label']).toBe('Ready · 2')
  expect((await ui.find({ key: 'filter-blocked' }))?.props['label']).toBe('Blocked · 1')
  expect((await ui.find({ key: 'filter-parked' }))?.props['label']).toBe('Parked · 1')
  expect((await ui.find({ key: 'filter-all' }))?.props['label']).toBe('All · 5')
  expect((await ui.find({ key: 'filter-inbox' }))?.props['dimColor']).toBe(false)
  expect((await ui.find({ key: 'filter-all' }))?.props['dimColor']).toBe(true)
  expect(await ui.find({ type: 'Text', text: '1 item · inbox' })).toBeDefined()
  // The reason once, as the tag; the meta line is size and group.
  expect(await rowAlts(ui)).toEqual(['p5: Billing · M · Inbox · No spec'])
  expect((await ui.find({ key: 'row-p5' }))?.props['label']).toBe('›')
  expect(await ui.find({ key: 'row-p3' })).toBeUndefined()
  // Ready holds the item in flight first.
  await ui.press({ key: 'filter-ready' })
  expect(await rowAlts(ui)).toEqual(['p2: Export · M · Building', 'p3: Search · M · Ready'])
  expect(await svgOf(ui, /^p2: /)).toContain(`fill="${RUNNING}"`)
  expect(await ui.find({ type: 'Text', text: '2 items · ready' })).toBeDefined()
  // All, then the search narrows live.
  await ui.press({ key: 'filter-all' })
  expect(await rowAlts(ui)).toHaveLength(5)
  expect(await rowAlts(ui)).toContain('p7: Later · M · Parked')
  await ui.input({ key: 'pipeline-search', text: 'bil', kind: 'change' })
  expect((await ui.find({ type: 'Input' }))?.props['value']).toBe('bil')
  expect(await ui.find({ key: 'row-p5' })).toBeDefined()
  expect(await ui.find({ key: 'row-p3' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^1 item · all/ }))?.text).toBe('1 item · all · “bil”')
  await ui.input({ key: 'pipeline-search', text: 'p4' })
  expect(await ui.find({ key: 'row-p4' })).toBeDefined()
  expect(await ui.find({ key: 'row-p5' })).toBeUndefined()
  await ui.input({ key: 'pipeline-search', text: 'zzz', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: 'No matching items in this section.' })).toBeDefined()
  // A row expands under itself: the note and the status command; pressing again folds it.
  await ui.input({ key: 'pipeline-search', text: '', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: '/pipeline status p4' })).toBeUndefined()
  await ui.press({ key: 'row-p4' })
  expect(await ui.find({ type: 'Text', text: 'CI red after one fix' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '/pipeline status p4' }))?.props['mono']).toBe(true)
  expect((await ui.find({ key: 'row-p4' }))?.props['label']).toBe('⌄')
  await ui.press({ key: 'row-p2' })
  expect(await ui.find({ type: 'Text', text: '/pipeline status p4' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Spec docs/pipeline/specs/p2.md' })).toBeDefined()
  await ui.press({ key: 'row-p2' })
  expect(await ui.find({ type: 'Text', text: /^\/pipeline status p/ })).toBeUndefined()
  // Switching the filter closes the expansion.
  await ui.press({ key: 'row-p4' })
  await ui.press({ key: 'filter-blocked' })
  expect(await ui.find({ type: 'Text', text: '/pipeline status p4' })).toBeUndefined()
  expect(await rowAlts(ui)).toEqual(['p4: Import · M · Blocked'])
  expect(await svgOf(ui, /^p4: /)).toContain(`fill="${BLOCKED}"`)
  await ui.unmount()
})

// ---------- History ----------

test('desktop History: the hero counts the week, every merged item newest first with its PR, folded past twenty', async ($, on) => {
  const many = Array.from({ length: 23 }, (_, i) => item(`m${i + 1}`, `Merged ${i + 1}`, 'merged', { pr: i === 0 ? '#9' : `https://x/pull/${i + 1}`, updatedAt: `2026-${i < 3 ? '11-04' : '10-01'}T${String(i).padStart(2, '0')}:00:00Z` }))
  world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: backlogOf([...many, item('q1', 'Open', 'inbox')]) })
  await start($ as never)
  const ui = await mount($ as never, 'desktop')
  await ui.press({ key: 'tab-history' })
  expect((await alts(ui))[0]).toBe('23 items merged: all time · 3 this week')
  expect(await ui.find({ type: 'Text', text: /^Recent pull requests/ })).toBeDefined()
  // Drawn rows like the Overview's merged rows: the check, the id and the title, the PR Link beside each.
  const rows = await rowAlts(ui)
  expect(rows).toHaveLength(20)
  expect(rows[0]).toBe('m3: Merged 3 · merged · #3')
  const first = await svgOf(ui, /^m3: /)
  expect(first).toContain(`stroke="${DONE}"`)
  expect(first).toContain('>m3<')
  expect(first).toContain('>Merged 3<')
  expect((await ui.find({ type: 'Link', text: '#3 ↗' }))?.props['href']).toBe('https://x/pull/3')
  expect(await ui.find({ type: 'Text', text: '#9' })).toBeDefined()
  expect((await ui.find({ key: 'history-more' }))?.props['label']).toBe('Show all 23 →')
  await ui.press({ key: 'history-more' })
  expect(await rowAlts(ui)).toHaveLength(23)
  expect((await ui.find({ key: 'history-more' }))?.props['label']).toBe('Show fewer')
  expect(await ui.find({ key: 'row-q1' })).toBeUndefined()
  await ui.unmount()
})

test('desktop Overview: other sessions are drawn rows with the title cut, the item and the agents, a stale one faded; this session\'s own entry is not among them', async ($, on) => {
  const agent = { id: 't9', agentId: 'a9', name: 'Theirs', model: 'm', status: 'running', startedAt: NOW - MIN, lastStepAt: NOW - MIN, calls: 0, tokens: 0, activity: 'starting', lastCommands: [], failures: 0 }
  const sessions = {
    'old-self': { title: 'p1 · grid-track-sizes — Grid row and column sizes', cwd: MAIN, item: 'p1', startedAt: new Date(NOW - 20 * MIN).toISOString(), seenAt: new Date(NOW - 30_000).toISOString(), agents: [], signals: [] },
    busy: { title: 'p12 · A very long title of a session that will not fit in the row of the panel at this width', cwd: '/p/other', item: 'p12', startedAt: new Date(NOW - 20 * MIN).toISOString(), seenAt: new Date(NOW - 20_000).toISOString(), agents: [agent], signals: [] },
    gone: { title: 'catalo', cwd: '/p/third', startedAt: new Date(NOW - 60 * MIN).toISOString(), seenAt: new Date(NOW - 10 * MIN).toISOString(), agents: [], signals: [] },
  }
  world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: IDLE, [`${MAIN}/.git/pipeline-live.json`]: JSON.stringify({ sessions }) })
  await start($ as never)
  const ui = await mount($ as never, 'desktop', 40)
  expect((await ui.find({ type: 'Text', text: /^Other sessions/ }))?.text).toBe('Other sessions · 2')
  const a = await alts(ui)
  expect(a).toContain('p12 · A very long title of a session that will not fit in the row of the panel at this width · p12 · 1 agent')
  expect(a).toContain('catalo · 0 agents · stale')
  expect(a.some(t => t.startsWith('p1 · grid-track-sizes'))).toBe(false)
  const busy = await svgOf(ui, /^p12 · A very long/)
  expect(busy).toContain('class="live"')
  expect(busy).toContain('>p12 · 1 agent<')
  expect(busy).not.toContain('opacity="0.5"')
  const title = />([^<]*…)</.exec(busy)?.[1]
  expect(title?.startsWith('p12 · A very long title')).toBe(true)
  expect(busy).not.toContain('at this width<')
  const gone = await svgOf(ui, /^catalo/)
  expect(gone).toContain('opacity="0.5"')
  expect(gone).not.toContain('class="live"')
  await ui.unmount()
})

test('a migrated project: imported items carry the migration date, so the History hero counts them all time and only a pipeline merge this week, the Overview metric agrees, and the list runs newest first', async ($, on) => {
  const imported = Array.from({ length: 33 }, (_, i) => item(`p${i + 1}`, `Imported ${i + 1}`, 'merged', { pr: `https://x/pull/${i + 1}`, updatedAt: '2026-11-05T09:00:00Z', note: i % 2 ? 'imported from docs/backlog.md' : 'imported from docs/backlog.md; no PR link' }))
  const built = item('p34', 'Built here', 'merged', { pr: 'https://x/pull/34', updatedAt: '2026-11-05T09:30:00Z' })
  world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: backlogOf([...imported, built, item('q1', 'Open', 'inbox')]) })
  await start($ as never)
  const ui = await mount($ as never, 'desktop')
  expect((await alts(ui))[1]).toBe('1 Inbox, 0 Ready, 1 Merged this week')
  await ui.press({ key: 'tab-history' })
  expect((await alts(ui))[0]).toBe('34 items merged: all time · 1 this week')
  const links = await ui.findAll({ type: 'Link' })
  expect(links.map(l => l.props['href']).slice(0, 3)).toEqual(['https://x/pull/34', 'https://x/pull/33', 'https://x/pull/32'])
  expect(links.at(-1)!.props['href']).toBe('https://x/pull/15')
  await ui.unmount()
})

// ---------- the band above the prompt ----------

test('the band draws nothing of its own in a project without a pipeline', async ($, on) => {
  world(on)
  await start($ as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($ as never, surface)
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    expect(await ui.find({ key: 'band-expand' })).toBeUndefined()
    expect(await ui.find({ key: 'band-panel' })).toBeUndefined()
    await ui.unmount()
  }
})

test('idle: a one-line strip with the idle line and an Open panel button that opens the pane; cut to a narrow width; the terminal row cut to the columns', async ($, on) => {
  const { opened } = world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: IDLE })
  await start($ as never)
  let ui = await band($ as never, 'desktop', { bodyColumns: 100 })
  const svg = await ui.find({ type: 'Svg' })
  expect(svg?.props['alt']).toBe('pipeline · idle · 28 inbox · next: p1 Grid row and column sizes')
  expect(svg?.props['height']).toBe(28)
  const src = String(svg?.props['source'])
  expect(src).toContain('>pipeline · idle · 28 inbox · next: p1 Grid row and column sizes<')
  expect(src).not.toContain('class="live"')
  expect(await ui.find({ key: 'band-expand' })).toBeUndefined()
  const button = await ui.find({ key: 'band-panel' })
  expect(button?.props['label']).toBe('Open panel')
  expect(button?.props['hotkey']).toBe('p')
  expect(opened).toEqual([])
  await ui.press({ key: 'band-panel' })
  expect(opened).toEqual(['pipeline'])
  // Open already: pressing again brings the pane forward with the keys, and opens no second one.
  await ui.press({ key: 'band-panel' })
  expect(opened).toEqual(['pipeline', 'pipeline'])
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await ui.unmount()
  // A narrow strip cuts the line with an ellipsis and keeps every text inside the width.
  ui = await band($ as never, 'desktop', { bodyColumns: 30 })
  const narrow = String((await ui.find({ type: 'Svg' }))?.props['source'])
  const W = Number((await ui.find({ type: 'Svg' }))?.props['width'])
  expect(W).toBe(176)
  const cut = />(pipeline · idle[^<]*)</.exec(narrow)?.[1]
  expect(cut?.endsWith('…')).toBe(true)
  for (const m of narrow.matchAll(/<text x="([\d.]+)"/g)) expect(Number(m[1])).toBeLessThan(W)
  await ui.unmount()
  // The terminal: one dim row with a hollow dot, cut to the columns, and the same button.
  ui = await band($ as never, 'terminal', { bodyColumns: 100 })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect((await ui.find({ type: 'Text', text: /^○ pipeline/ }))?.text).toBe('○ pipeline · idle · 28 inbox · next: p1 Grid row and column sizes')
  expect((await ui.find({ key: 'band-panel' }))?.props['label']).toBe('Open panel')
  await ui.unmount()
  ui = await band($ as never, 'terminal', { bodyColumns: 40 })
  const row = (await ui.find({ type: 'Text', text: /^○ pipeline/ }))?.text ?? ''
  expect(row.length).toBeLessThanOrEqual(40 - 4 - 'Open panel'.length - 3)
  expect(row.endsWith('…')).toBe(true)
  await ui.unmount()
})

test('idleStrip hide: nothing of its own when idle; the running band stays', { options: { idleStrip: 'hide' } }, async ($, on) => {
  world(on, { [CONFIG]: VALID_CONFIG, [BACKLOG]: IDLE })
  await start($ as never)
  const ui = await band($ as never, 'desktop')
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  expect(await ui.find({ key: 'band-panel' })).toBeUndefined()
  await ui.unmount()
})

test('the band: two lines on the desktop within the width, segment colours, the chevron expands the tasks; the terminal row cut to the columns', async ($, on) => {
  const worldRef = world(on, { ...SEED, [BACKLOG]: backlogOf([item('p2', 'Show saved password and SSH key state in custom credentials, a long title', 'building'), item('p3', 'Search', 'ready')]) })
  const { clock } = worldRef
  await start($ as never)
  await spawn($ as never, 'Implement task 2', 1)
  await clock.advance(224_000)
  // A narrow band: 30 columns, 200 px, so the title must be cut.
  let ui = await band($ as never, 'desktop', { bodyColumns: 30 })
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs).toHaveLength(1)
  const W = Number(svgs[0]!.props['width'])
  expect(W).toBe(176)
  expect(svgs[0]!.props['height']).toBe(54)
  const src = String(svgs[0]!.props['source'])
  expect(svgs[0]!.props['alt']).toBe('p2 BUILDING: Show saved password and SSH key state in custom credentials, a long title, Task 2 / 3, Implementer · Sonnet 5.5 · starting')
  expect(src).toContain('>Task 2 / 3<')
  // Too narrow for the state tag beside the id and the count: it goes (review 0.2 M2); the colour still says it.
  expect(src).not.toContain('>BUILDING<')
  expect(src).toContain('>3:44<')
  // Every text starts inside the band, and the title is cut with an ellipsis instead of running over.
  for (const m of src.matchAll(/<text x="([\d.]+)"/g)) expect(Number(m[1])).toBeLessThan(W)
  for (const m of src.matchAll(/<rect x="(-?[\d.]+)"/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(0)
  const title = /<text class="t" x="[\d.]+" y="20" font-size="12" font-weight="650">([^<]*)</.exec(src)?.[1]
  expect(title === undefined || title.endsWith('…')).toBe(true)
  // The segments: one accepted (green), the running one (the state's purple), one pending (grey), in order.
  const fills = [...src.matchAll(/height="5" rx="2.5" fill="(#[0-9a-f]{6})"/g)].map(m => m[1])
  expect(fills).toEqual([SEGMENT_COLORS.accepted, BAND_COLORS.running, SEGMENT_COLORS.pending])
  expect(src).toContain(`fill="${BAND_COLORS.running}"`)
  // The Panel button beside the chevron: the spawn opened the pane, so it reads open; closed, it opens it on a press.
  const { opened, panes } = worldRef
  expect((await ui.find({ key: 'band-panel' }))?.props['label']).toBe('Panel ↗')
  expect((await ui.find({ key: 'band-panel' }))?.props['hotkey']).toBe('p')
  await run($ as never, 'panel')
  expect(panes).toEqual([])
  expect((await ui.find({ key: 'band-panel' }))?.props['label']).toBe('Panel')
  await ui.press({ key: 'band-panel' })
  expect(opened).toEqual(['pipeline', 'pipeline'])
  expect(panes).toEqual(['pipeline'])
  expect((await ui.find({ key: 'band-panel' }))?.props['label']).toBe('Panel ↗')
  // The chevron reveals the task list with its summary.
  expect(await ui.find({ type: 'Text', text: /^Execution tasks/ })).toBeUndefined()
  await ui.press({ key: 'band-expand' })
  expect((await ui.find({ type: 'Text', text: /^Execution tasks/ }))?.text).toBe('Execution tasks · 1 accepted · 1 running')
  expect((await ui.find({ type: 'Text', text: '✓ The parser' }))?.props['color']).toBe(SEGMENT_COLORS.accepted)
  expect((await ui.find({ type: 'Text', text: '• The writer' }))?.props['color']).toBe(BAND_COLORS.running)
  expect((await ui.find({ type: 'Text', text: '○ The command' }))?.props['dimColor']).toBe(true)
  expect((await ui.find({ key: 'band-expand' }))?.props['label']).toBe('⌃')
  await ui.press({ key: 'band-expand' })
  expect(await ui.find({ type: 'Text', text: /^Execution tasks/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await ui.unmount()

  // A wide band keeps the whole title and the state tag.
  ui = await band($ as never, 'desktop', { bodyColumns: 120 })
  const wide = String((await ui.find({ type: 'Svg' }))?.props['source'])
  expect(wide).toContain('>Show saved password and SSH key state in custom credentials, a long title<')
  expect(wide).toContain('>BUILDING<')
  await ui.unmount()

  // The terminal: one row, the head in the state colour, the segments, the tail; cut to the columns.
  ui = await band($ as never, 'terminal', { bodyColumns: 80 })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  const head = await ui.find({ type: 'Text', text: /^● p2/ })
  expect(head?.text).toBe('● p2 · Task 2 / 3')
  expect(head?.props['color']).toBe(BAND_COLORS.running)
  const tail = await ui.find({ type: 'Text', text: /3:44$/ })
  expect(tail?.text).toBe('· Implementer · Sonnet 5.5 · starting · 3:44')
  expect(await ui.find({ type: 'Text', text: '▰' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▱' })).toBeDefined()
  await ui.unmount()
  ui = await band($ as never, 'terminal', { bodyColumns: 40 })
  // 36 characters for the row: the head and the segments stay, the activity goes, the clock stays.
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const headText = texts.find(t => t.startsWith('● p2'))!
  const tailText = texts.find(t => t.endsWith('3:44'))!
  expect(`${headText} · ▰▰▱ ${tailText}`.length).toBeLessThanOrEqual(36)
  expect(headText).toBe('● p2 · Task 2 / 3')
  expect(tailText).toBe('· 3:44')
  // Narrower still, the activity is cut with an ellipsis before the clock goes.
  const cut = bandText(bandOf(item('p2', 'A long title', 'building') as never, JSON.parse(LEDGER), { id: 'a', name: 'Implement task 2', model: 'claude-sonnet-5-5', status: 'running', startedAt: NOW - 224_000, lastStepAt: NOW, calls: 0, tokens: 0, activity: 'running npm run lint', lastCommands: [], failures: 0 }, NOW), 50)
  expect(`${cut.head} · ${cut.segments} · ${cut.tail}`.length).toBeLessThanOrEqual(50)
  expect(cut.tail).toMatch(/^Implementer · S.*… · 3:44$/)
  await ui.unmount()
})

test('review 0.2 M2: at the minimum width the hook allows (156 px) the band leaves the state tag out instead of drawing it over the id', () => {
  const ledger = { item: 'p12', tasks: [{ n: 1, title: 'a', status: 'running', dispatches: [] }], rulings: [], blockers: [], tokens: 0, resume: { task: 1, state: 'implementer dispatched', at: '' } }
  const b = bandOf(item('p12', 'Show saved password and SSH key state', 'building') as never, ledger as never, undefined, NOW)
  const W = Math.max(180, Math.min(1600, 20 * 8 - 40)) - 24
  expect(W).toBe(156)
  const narrow = bandSvg(b, W)
  expect(narrow).not.toContain('>BUILDING<')
  expect(/<rect x="(-?[\d.]+)" y="8" width="[\d.]+" height="17"/.exec(narrow)).toBeNull()
  expect(narrow).toContain('>p12<')
  expect(narrow).toContain('>Task 1 / 1<')
  for (const m of narrow.matchAll(/<(?:rect|text) x="(-?[\d.]+)"/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(0)
  // Room enough: the tag sits to the right of the id with its separator.
  const wide = bandSvg(b, 600)
  const tag = /<rect x="(-?[\d.]+)" y="8" width="([\d.]+)" height="17"/.exec(wide)
  expect(tag).not.toBeNull()
  expect(Number(tag![1])).toBeGreaterThan(29 + 24)
  expect(wide).toContain('>BUILDING<')
  expect(wide).toContain('class="sep"')
  expect(narrow).not.toContain('class="sep"')
})

test('the band in compact mode: one line with the id, title, count and clock, no state tag, no activity', { options: { band: 'compact' } }, async ($, on) => {
  world(on, SEED)
  await start($ as never)
  await spawn($ as never, 'Implement task 2', 1)
  const ui = await band($ as never, 'desktop')
  const svg = await ui.find({ type: 'Svg' })
  expect(svg?.props['height']).toBe(28)
  const src = String(svg?.props['source'])
  expect(src).toContain('>p2<')
  expect(src).toContain('>Export<')
  expect(src).toContain('>Task 2 / 3<')
  expect(src).toContain('>0:00<')
  expect(src).not.toContain('>BUILDING<')
  expect(src).not.toContain('Implementer')
  expect(src).not.toContain('height="5"')
  await ui.unmount()
})

test('the band stays for a blocked item until the next turn starts, then goes', async ($, on) => {
  world(on, SEED)
  await start($ as never)
  let ui = await band($ as never, 'desktop', { isWorking: true })
  expect((await ui.find({ type: 'Svg' }))?.props['alt']).toMatch(/^p2 BUILDING/)
  await ui.unmount()
  await call($ as never, { action: 'update', id: 'p2', set: { status: 'blocked', note: 'CI red twice' } })
  // Still the turn that blocked it: shown in amber, with the note.
  ui = await band($ as never, 'desktop', { isWorking: true })
  let src = String((await ui.find({ type: 'Svg' }))?.props['source'])
  expect(src).toContain('>BLOCKED<')
  expect(src).toContain('CI red twice')
  expect(src).toContain(`fill="${BAND_COLORS.blocked}"`)
  await ui.unmount()
  // Idle between turns: still shown.
  ui = await band($ as never, 'desktop', { isWorking: false })
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  await ui.unmount()
  // The next turn: gone, the idle strip in its place.
  ui = await band($ as never, 'desktop', { isWorking: true })
  expect((await ui.find({ type: 'Svg' }))?.props['alt']).toMatch(/^pipeline · idle · \d inbox · next: p3 Search$/)
  expect(await ui.find({ key: 'band-expand' })).toBeUndefined()
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
  // A merged item the same way, in green with its count.
  await call($ as never, { action: 'update', id: 'p2', set: { status: 'building' } })
  ui = await band($ as never, 'desktop', { isWorking: true })
  await ui.unmount()
  await call($ as never, { action: 'update', id: 'p2', set: { status: 'merged', pr: 'https://x/pull/7' } })
  ui = await band($ as never, 'desktop', { isWorking: true })
  src = String((await ui.find({ type: 'Svg' }))?.props['source'])
  expect(src).toContain('>MERGED<')
  expect(src).toContain('>1 / 3 accepted<')
  expect(src).toContain('Merged · #7')
  expect(src).toContain(`fill="${BAND_COLORS.merged}"`)
  await ui.unmount()
})

test('review 0.2 C1: a ledger file without a tasks array (valid JSON) draws the desktop Overview and the band without an error', async ($, on) => {
  const seed = { [CONFIG]: VALID_CONFIG, [BACKLOG]: backlogOf([item('p2', 'Export', 'building', { spec: 'docs/pipeline/specs/p2.md', ledger: 'docs/pipeline/ledgers/p2.json' })]), [`${DIR}/ledgers/p2.json`]: JSON.stringify({ item: 'p2', tokens: 0 }) + '\n', [`${DIR}/specs/p2.md`]: SPEC }
  world(on, seed)
  await start($ as never)
  await spawn($ as never, 'Implement task 1', 1)
  const ui = await mount($ as never, 'desktop')
  expect(await ui.find({ type: 'Text', text: /^pipeline: / })).toBeUndefined()
  const a = await alts(ui)
  expect(a[0]).toBe('BUILDING · P2: Export, 0 of 0 tasks accepted')
  expect(a.length).toBeGreaterThanOrEqual(2)
  expect((await ui.find({ type: 'Text', text: 'No ledger yet.' }))?.text).toBe('No ledger yet.')
  await ui.unmount()
  // The band above the prompt draws from the same ledger.
  const bar = await band($ as never, 'desktop')
  expect(await bar.find({ type: 'Text', text: /^pipeline: / })).toBeUndefined()
  expect((await bar.find({ type: 'Svg' }))?.props['alt']).toMatch(/^p2 BUILDING: Export, , Implementer/)
  await bar.unmount()
})
